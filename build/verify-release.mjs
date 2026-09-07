// Verifies a published release the way a consumer must (TECHNICAL-DESIGN §3.5).
//
// Given a version it downloads every asset of the tag `v<version>`, checks each one
// against `SHA256SUMS`, and checks `SHA256SUMS` itself against the detached minisign
// signature and the public key given on the command line. Anything that does not add up
// is an error: a missing asset, an extra asset nobody signed, a hash that differs by one
// byte, a signature made by another key. `release.yml` runs it right after it publishes,
// so a release that cannot be verified is a red run rather than a discovery made later by
// whoever tried to install it.
//
// The minisign verification is deliberately self-contained — no `minisign` binary, no
// dependency — because `handoff-app` has to run the same check inside `fetch-server`
// (T-012) on machines that have neither. Everything it needs is in Node: Ed25519 through
// `crypto.verify` and BLAKE2b-512 through `crypto.createHash`.
//
// Usage:
//   node build/verify-release.mjs <version> <public-key|path-to-.pub>
//   node build/verify-release.mjs 0.1.0 keys/handoff-mcp-release.pub --dir out --keep
//   node build/verify-release.mjs 0.1.0 keys/handoff-mcp-release.pub --dir out --offline
//
// Options:
//   --repo <owner/name>  the release repository (default Cepeppe/handoff-mcp)
//   --dir <dir>          where the assets are written (default a temporary directory)
//   --keep               do not delete the directory afterwards
//   --offline            verify the assets already in --dir instead of downloading
//
// Authentication: `handoff-mcp` is private for now, so the GitHub API needs a token. It is
// read from `GH_TOKEN` or `GITHUB_TOKEN`, and locally falls back to `gh auth token`.
import { execFileSync } from 'node:child_process';
import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULT_REPO = 'Cepeppe/handoff-mcp';

const SUMS = 'SHA256SUMS';
const SIGNATURE = 'SHA256SUMS.minisig';

/**
 * The assets §3.5 requires of every release. The two darwin binaries are absent while
 * macOS is deferred, so they are accepted when present and never demanded.
 */
function requiredAssets(version) {
  return [
    `handoff-mcp-${version}-win32-x64.exe`,
    `handoff-mcp-${version}-format.tar.gz`,
    SUMS,
    SIGNATURE,
  ];
}

/** minisign's two signature algorithms: legacy over the file, `ED` over its BLAKE2b hash. */
const SIGALG_LEGACY = 'Ed';
const SIGALG_PREHASHED = 'ED';

/** The SPKI wrapper that turns 32 raw Ed25519 bytes into a key `crypto.verify` accepts. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

class VerifyError extends Error {}

function fail(message) {
  throw new VerifyError(message);
}

// ---------------------------------------------------------------------------- minisign

/**
 * The key id the way minisign prints it in the comment of a `.pub` file: the eight bytes
 * read big-endian. Only the comparison matters here, but a value the owner can put next to
 * `keys/handoff-mcp-release.pub` by eye is worth the reverse.
 */
function keyIdOf(raw) {
  return Buffer.from(raw.subarray(2, 10)).reverse().toString('hex').toUpperCase();
}

/** The payload line of a minisign key or signature file, decoded. */
function decodeBase64Line(line, what) {
  const decoded = Buffer.from(line.trim(), 'base64');
  if (decoded.length === 0) fail(`${what} is not base64`);
  return decoded;
}

/**
 * Parses a minisign public key, given either as the raw `RW…` line or as the path of a
 * `.pub` file (whose first line is a comment).
 */
async function readPublicKey(argument) {
  let line = argument.trim();
  if (!/^RW[A-Za-z0-9+/=]+$/.test(line)) {
    let text;
    try {
      text = await readFile(argument, 'utf8');
    } catch {
      fail(`${argument} is neither a minisign public key nor a readable file`);
    }
    const candidate = text
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '' && !entry.startsWith('untrusted comment:'));
    if (candidate.length !== 1) fail(`${argument} does not look like a minisign public key file`);
    line = candidate[0];
  }

  const raw = decodeBase64Line(line, 'the public key');
  if (raw.length !== 42) fail(`the public key is ${raw.length} bytes, expected 42`);
  const algorithm = raw.subarray(0, 2).toString('latin1');
  if (algorithm !== SIGALG_LEGACY) fail(`unknown public key algorithm ${algorithm}`);
  return {
    keyId: keyIdOf(raw),
    key: createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, raw.subarray(10)]),
      format: 'der',
      type: 'spki',
    }),
  };
}

/** Parses a `.minisig`: the signature, its algorithm, and the trusted comment it covers. */
function parseSignature(text) {
  const lines = text.split(/\r?\n/);
  if (lines.length < 4) fail(`${SIGNATURE} is truncated: ${lines.length} lines, expected 4`);

  const raw = decodeBase64Line(lines[1], 'the signature');
  if (raw.length !== 74) fail(`the signature is ${raw.length} bytes, expected 74`);
  const trustedComment = lines[2].replace(/^trusted comment:\s?/, '');
  if (trustedComment === lines[2]) fail(`${SIGNATURE} has no trusted comment on line 3`);
  const globalSignature = decodeBase64Line(lines[3], 'the global signature');
  if (globalSignature.length !== 64) {
    fail(`the global signature is ${globalSignature.length} bytes, expected 64`);
  }

  const algorithm = raw.subarray(0, 2).toString('latin1');
  if (algorithm !== SIGALG_LEGACY && algorithm !== SIGALG_PREHASHED) {
    fail(`unknown signature algorithm ${algorithm}`);
  }
  return {
    algorithm,
    keyId: keyIdOf(raw),
    signature: raw.subarray(10),
    trustedComment,
    globalSignature,
  };
}

/**
 * Verifies a detached minisign signature over `content`. Both signatures are checked: the
 * one over the file, and the global one over `signature || trusted comment`, which is what
 * stops an attacker from keeping a valid signature and rewriting the comment around it.
 */
function verifyMinisign(content, signatureText, publicKey) {
  const parsed = parseSignature(signatureText);
  if (parsed.keyId !== publicKey.keyId) {
    fail(`the signature was made by key ${parsed.keyId}, not by ${publicKey.keyId}`);
  }

  const signed =
    parsed.algorithm === SIGALG_PREHASHED
      ? createHash('blake2b512').update(content).digest()
      : content;
  if (!verifySignature(null, signed, publicKey.key, parsed.signature)) {
    fail(`the signature of ${SUMS} does not match its content`);
  }
  if (
    !verifySignature(
      null,
      Buffer.concat([parsed.signature, Buffer.from(parsed.trustedComment, 'utf8')]),
      publicKey.key,
      parsed.globalSignature,
    )
  ) {
    fail('the global signature does not match the trusted comment');
  }
  return parsed;
}

// ------------------------------------------------------------------------------ GitHub

function token() {
  const fromEnv = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  try {
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: 'pipe' }).trim();
  } catch {
    fail('no GitHub token: set GH_TOKEN, or log in with `gh auth login`');
  }
}

async function api(path, accept, auth) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      accept,
      authorization: `Bearer ${auth}`,
      'user-agent': 'handoff-mcp-verify-release',
      'x-github-api-version': '2022-11-28',
    },
  });
  if (!response.ok) {
    fail(`GET ${path} answered ${response.status} ${response.statusText}`);
  }
  return response;
}

/** The assets of the release tagged `v<version>`, as `{ name, id, size }`. */
async function releaseAssets(repo, version, auth) {
  const response = await api(
    `/repos/${repo}/releases/tags/v${version}`,
    'application/vnd.github+json',
    auth,
  );
  const release = await response.json();
  return release.assets.map((asset) => ({ name: asset.name, id: asset.id, size: asset.size }));
}

/**
 * Downloads one asset. The API endpoint redirects to storage, and Node's fetch drops the
 * `Authorization` header across origins by itself, which is exactly what the redirect
 * target wants.
 */
async function download(repo, asset, dir, auth) {
  const response = await api(
    `/repos/${repo}/releases/assets/${asset.id}`,
    'application/octet-stream',
    auth,
  );
  const target = join(dir, asset.name);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(target));
  const written = (await stat(target)).size;
  if (written !== asset.size) {
    fail(`${asset.name} downloaded as ${written} bytes, the release says ${asset.size}`);
  }
  return target;
}

// ------------------------------------------------------------------------ verification

function sha256(path) {
  const hash = createHash('sha256');
  return pipeline(createReadStream(path), hash).then(() => hash.digest('hex'));
}

/** Parses `sha256sum` output: `<64 hex><two spaces><name>`, one asset per line. */
function parseSums(text) {
  const sums = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line);
    if (match === null) fail(`${SUMS} has a line that is not a checksum: ${line}`);
    const name = basename(match[2].trim());
    if (sums.has(name)) fail(`${SUMS} lists ${name} twice`);
    sums.set(name, match[1]);
  }
  if (sums.size === 0) fail(`${SUMS} is empty`);
  return sums;
}

async function verifyDirectory(dir, version, publicKey, present) {
  const sumsText = await readFile(join(dir, SUMS), 'utf8');
  const parsed = verifyMinisign(
    Buffer.from(sumsText, 'utf8'),
    await readFile(join(dir, SIGNATURE), 'utf8'),
    publicKey,
  );
  console.error(`[ok] ${SIGNATURE} — key ${publicKey.keyId}, ${parsed.trustedComment}`);

  const sums = parseSums(sumsText);
  for (const name of requiredAssets(version)) {
    if (!present.includes(name)) fail(`the release has no ${name}`);
  }
  for (const name of present) {
    if (name === SUMS || name === SIGNATURE) continue;
    if (!sums.has(name)) fail(`${name} is published but not listed in ${SUMS}`);
    if (!name.startsWith(`handoff-mcp-${version}-`)) {
      fail(`${name} is not named after version ${version} (§3.5)`);
    }
  }

  for (const [name, expected] of sums) {
    if (!present.includes(name)) fail(`${SUMS} lists ${name}, which the release does not have`);
    const actual = await sha256(join(dir, name));
    if (actual !== expected) {
      fail(`${name} hashes to ${actual}, ${SUMS} says ${expected}`);
    }
    console.error(`[ok] ${name} — sha256 ${expected}`);
  }
  return sums.size;
}

async function main(argv) {
  const flag = (name) => argv.includes(name);
  const value = (name) => {
    const index = argv.indexOf(name);
    if (index === -1) return undefined;
    if (argv[index + 1] === undefined) fail(`${name} needs a value`);
    return argv[index + 1];
  };

  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument.startsWith('--')) {
      if (argument !== '--keep' && argument !== '--offline') index += 1;
      continue;
    }
    positional.push(argument);
  }

  const [version, key] = positional;
  if (version === undefined || key === undefined) {
    fail('usage: node build/verify-release.mjs <version> <public-key|path-to-.pub> [options]');
  }

  const repo = value('--repo') ?? DEFAULT_REPO;
  const offline = flag('--offline');
  const keep = flag('--keep') || offline;
  const publicKey = await readPublicKey(key);

  const chosen = value('--dir');
  if (offline && chosen === undefined) fail('--offline needs --dir');
  const dir =
    chosen === undefined
      ? await mkdtemp(join(tmpdir(), 'handoff-mcp-release-'))
      : resolve(repoRoot, chosen);

  let assets;
  try {
    if (offline) {
      assets = (await readdir(dir)).sort();
      console.error(`verifying ${assets.length} files in ${dir} against key ${publicKey.keyId}`);
    } else {
      const auth = token();
      await mkdir(dir, { recursive: true });
      const published = await releaseAssets(repo, version, auth);
      console.error(`${repo} v${version}: ${published.length} assets`);
      for (const asset of published) await download(repo, asset, dir, auth);
      assets = published.map((asset) => asset.name).sort();
    }

    const checked = await verifyDirectory(dir, version, publicKey, assets);
    console.error(`\nv${version} verified: ${checked} assets, signed by ${publicKey.keyId}`);
  } finally {
    if (!keep && chosen === undefined) await rm(dir, { recursive: true, force: true });
  }
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  if (!(error instanceof VerifyError)) throw error;
  console.error(`verify-release: ${error.message}`);
  process.exitCode = 1;
}

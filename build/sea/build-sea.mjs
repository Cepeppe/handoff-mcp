// Builds the Single Executable Application of the server (TECHNICAL-DESIGN §5.1, SRV-24).
//
// The route is Node's own: the esbuild bundle of `build/bundle.mjs` becomes a preparation
// blob through `node --experimental-sea-config`, the blob is injected by `postject` into a
// copy of the running Node binary, and the result is renamed to the release asset name of
// §3.5. No Node.js is required on the target machine. Bun, Deno and `pkg` are excluded by
// DD-21.
//
// Usage:
//   node build/sea/build-sea.mjs                     build for the host platform
//   node build/sea/build-sea.mjs --print-target      print the asset name and exit
//   node build/sea/build-sea.mjs --print-target --host darwin-arm64
//
// Cross-building is not possible: the blob is injected into *this* Node binary, so the
// asset for a platform is produced on that platform (that is what `sea.yml` does). The
// `--host` override exists only for `--print-target`, so that the naming rule can be
// tested without a 90 MB build.
//
// Two platform steps matter and are not optional:
//   * Windows — the official `node.exe` is Authenticode-signed. Injecting into it leaves a
//     corrupted signature, and Windows application-control policies (Smart App Control)
//     then refuse to start the file with "a policy blocked this file". The signature is
//     removed with `signtool remove /s` before injection.
//   * macOS — the binary is ad-hoc signed after injection, because macOS refuses to run a
//     Mach-O whose signature no longer covers its content. The real signing and the
//     notarization happen in the app pipeline (T-060), which re-signs this file with the
//     hardened runtime and the entitlements listed in `docs/build-sea.md`.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  METAFILE,
  bundledPackages,
  executableNoticesName,
  nodeLicence,
  renderExecutableNotices,
  writeText,
} from '../third-party-notices.mjs';

const require = createRequire(import.meta.url);
const seaDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(seaDir, '..', '..');

/** The release targets of §3.5. Nothing else is a published asset. */
const TARGETS = ['darwin-arm64', 'darwin-x64', 'win32-x64'];

/** Fixed by Node; `postject` looks for it to find the injection point. */
const SENTINEL_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

/** The Mach-O segment Node reads the blob from on macOS. */
const MACHO_SEGMENT = 'NODE_SEA';

const SEA_CONFIG = join('build', 'sea', 'sea-config.json');
const BUNDLE = join('dist', 'handoff-mcp.cjs');
const OUT_DIR = join('dist', 'sea');

class BuildError extends Error {}

function fail(message) {
  throw new BuildError(message);
}

/** `win32-x64`, `darwin-arm64` or `darwin-x64`; anything else is not a release target. */
function hostTarget(platform = process.platform, arch = process.arch) {
  const target = `${platform}-${arch}`;
  if (!TARGETS.includes(target)) {
    fail(`${target} is not a release target of TECHNICAL-DESIGN §3.5 (${TARGETS.join(', ')})`);
  }
  return target;
}

/** The asset name of §3.5: `handoff-mcp-<ver>-<platform>[.exe]`. */
function assetName(version, target) {
  return `handoff-mcp-${version}-${target}${target.startsWith('win32-') ? '.exe' : ''}`;
}

function readVersion() {
  return JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version;
}

function inCI() {
  const value = process.env.CI;
  return value !== undefined && value !== '' && value !== '0' && value !== 'false';
}

function run(command, args, label) {
  try {
    return execFileSync(command, args, { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe' });
  } catch (error) {
    const detail = [error.stdout, error.stderr].filter(Boolean).join('\n').trim();
    fail(`${label} failed: ${detail || error.message}`);
  }
}

/**
 * `signtool.exe` is part of the Windows SDK and is not on `PATH` on this machine or on the
 * GitHub runners, so it is looked up in the SDK layout. `SIGNTOOL` overrides the search.
 */
function findSigntool() {
  if (process.env.SIGNTOOL) return process.env.SIGNTOOL;
  const roots = [
    'C:\\Program Files (x86)\\Windows Kits\\10\\bin',
    'C:\\Program Files\\Windows Kits\\10\\bin',
  ];
  const found = [];
  for (const root of roots) {
    let versions;
    try {
      versions = readdirSync(root);
    } catch {
      continue;
    }
    for (const version of versions) {
      const candidate = join(root, version, 'x64', 'signtool.exe');
      if (existsSync(candidate)) found.push({ version, candidate });
    }
  }
  found.sort((a, b) => a.version.localeCompare(b.version, 'en', { numeric: true }));
  return found.length === 0 ? null : found[found.length - 1].candidate;
}

/** Removes the Authenticode signature of the copied `node.exe`. See the header. */
function stripWindowsSignature(outPath) {
  const signtool = findSigntool();
  if (signtool === null) {
    console.error(
      'warning: signtool.exe not found, so the Authenticode signature of node.exe stays in ' +
        'place and the injected binary carries a corrupted one. It runs where no application ' +
        'control policy is enforced, but Smart App Control refuses it. Set SIGNTOOL to the ' +
        'full path, or install the Windows SDK.',
    );
    return false;
  }
  run(signtool, ['remove', '/s', outPath], `signtool remove /s ${outPath}`);
  console.error(`removed the Authenticode signature with ${signtool}`);
  return true;
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

async function build() {
  const target = hostTarget();
  const version = readVersion();
  const name = assetName(version, target);
  const outPath = join(OUT_DIR, name);

  for (const built of [BUNDLE, METAFILE]) {
    if (!existsSync(join(repoRoot, built))) fail(`${built} is missing: run \`pnpm build\` first`);
  }

  mkdirSync(join(repoRoot, OUT_DIR), { recursive: true });

  // 1. bundle -> preparation blob. The paths inside sea-config.json are resolved against
  //    the current working directory, not against the configuration file, hence `cwd`.
  const blob = JSON.parse(readFileSync(join(repoRoot, SEA_CONFIG), 'utf8')).output;
  run(
    process.execPath,
    ['--experimental-sea-config', SEA_CONFIG],
    'node --experimental-sea-config',
  );
  console.error(`wrote ${blob} (${statSync(join(repoRoot, blob)).size} bytes)`);

  // 2. a copy of this Node binary is the carrier.
  copyFileSync(process.execPath, join(repoRoot, outPath));
  console.error(`copied ${process.execPath} to ${outPath}`);

  // 3. platform preparation before the injection.
  let signatureRemoved = true;
  if (process.platform === 'win32') {
    signatureRemoved = stripWindowsSignature(outPath);
  } else if (process.platform === 'darwin') {
    run('codesign', ['--remove-signature', outPath], 'codesign --remove-signature');
    console.error('removed the signature of the copied binary');
  }

  // 4. injection.
  const postject = require.resolve('postject/dist/cli.js');
  const injectArgs = [postject, outPath, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', SENTINEL_FUSE];
  if (process.platform === 'darwin') injectArgs.push('--macho-segment-name', MACHO_SEGMENT);
  run(process.execPath, injectArgs, 'postject');
  console.error('injected NODE_SEA_BLOB');

  // 5. macOS needs a valid signature to run the file at all; ad-hoc is enough here.
  if (process.platform === 'darwin') {
    run('codesign', ['--sign', '-', outPath], 'codesign --sign -');
    console.error('ad-hoc signed the binary (the app pipeline re-signs it, T-060)');
  }

  // 6. the licences of what the executable carries — this Node binary and the packages of the
  //    bundle — as the release asset published beside it. A release must carry the texts; a
  //    local build that is offline links to the licence of Node.js instead.
  const node = await nodeLicence(process.execPath, process.version);
  if (node.text === undefined) {
    if (inCI()) fail(`the licence of Node.js ${process.version} could not be read: ${node.source}`);
    console.error(`warning: the notices link to ${node.source}, they do not carry its text`);
  }
  const metafile = JSON.parse(readFileSync(join(repoRoot, METAFILE), 'utf8'));
  const noticesPath = join(OUT_DIR, executableNoticesName(version, target));
  writeText(
    join(repoRoot, noticesPath),
    renderExecutableNotices(bundledPackages(metafile, repoRoot), { asset: name, node }),
  );
  console.error(`wrote ${noticesPath} (Node.js licence from ${node.source})`);

  const size = statSync(join(repoRoot, outPath)).size;
  console.error(`\n${outPath}`);
  console.error(`  target  ${target}`);
  console.error(`  node    ${process.version}`);
  console.error(`  size    ${(size / 1024 / 1024).toFixed(1)} MB`);
  console.error(`  sha256  ${sha256(join(repoRoot, outPath))}`);
  if (!signatureRemoved) console.error('  signature  CORRUPTED (see the warning above)');
  console.error(`\nSmoke it with: node build/sea/smoke.mjs ${outPath}`);
}

function printTarget(hostOverride) {
  const target = hostOverride === undefined ? hostTarget() : hostTarget(...splitHost(hostOverride));
  const version = readVersion();
  process.stdout.write(
    `${JSON.stringify({ target, version, asset: assetName(version, target), out: join(OUT_DIR, assetName(version, target)) })}\n`,
  );
}

function splitHost(host) {
  const dash = host.indexOf('-');
  if (dash === -1) fail(`--host wants <platform>-<arch>, got ${host}`);
  return [host.slice(0, dash), host.slice(dash + 1)];
}

async function main(argv) {
  const hostIndex = argv.indexOf('--host');
  const host = hostIndex === -1 ? undefined : argv[hostIndex + 1];
  if (hostIndex !== -1 && host === undefined) fail('--host needs a value');

  if (argv.includes('--print-target')) {
    printTarget(host);
    return;
  }
  if (host !== undefined)
    fail('--host only makes sense with --print-target: SEA cannot cross-build');
  await build();
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  if (!(error instanceof BuildError)) throw error;
  console.error(`build-sea: ${error.message}`);
  process.exitCode = 2;
}

/**
 * Guards the release pipeline (TECHNICAL-DESIGN §3.5, §3.6).
 *
 * Everything here runs off-line and in a second. The three scripts `release.yml` calls are
 * exercised through their command line, and the workflow itself is read as text, because
 * the parts of a release that can go wrong quietly — a tag that does not match the version,
 * a darwin leg that starts costing 10x per push, an npm publish that stops being gated, a
 * signature nobody checks — are all decisions written in that file and nowhere else.
 *
 * The minisign artifacts are built here with Node's own Ed25519 rather than with the
 * `minisign` binary, which is installed on the release runner but on neither CI leg. The
 * format is the one `minisign -S` produces, and `build/verify-release.mjs` was checked
 * against a real signature by hand before this suite was written.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const VERIFY_RELEASE = join(ROOT, 'build', 'verify-release.mjs');
const FORMAT_TARBALL = join(ROOT, 'build', 'format-tarball.mjs');
const CHANGELOG_SECTION = join(ROOT, 'build', 'changelog-section.mjs');

const release = readFileSync(join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
const sea = readFileSync(join(ROOT, '.github', 'workflows', 'sea.yml'), 'utf8');
const packageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  version: string;
  scripts: Record<string, string>;
};

const temporary: string[] = [];

function temporaryDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'handoff-release-'));
  temporary.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true });
});

function run(script: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

/**
 * The slice of a workflow after `from` and before `to`. A marker that is not there is a
 * failure of the test rather than an empty string quietly satisfying every assertion.
 */
function between(text: string, from: string, to?: string): string {
  const parts = text.split(from);
  if (parts.length < 2) throw new Error(`the workflow has no ${JSON.stringify(from)}`);
  const after = parts[1] ?? '';
  if (to === undefined) return after;
  const end = after.split(to);
  if (end.length < 2) throw new Error(`no ${JSON.stringify(to)} after ${JSON.stringify(from)}`);
  return end[0] ?? '';
}

// ---------------------------------------------------------------------------- minisign

interface Keypair {
  privateKey: KeyObject;
  keyId: Buffer;
  publicKeyFile: string;
}

/** A minisign keypair: the `.pub` file is what `verify-release.mjs` is given. */
function keypair(): Keypair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(12);
  const keyId = randomBytes(8);
  const line = Buffer.concat([Buffer.from('Ed', 'latin1'), keyId, raw]).toString('base64');
  return {
    privateKey,
    keyId,
    publicKeyFile: `untrusted comment: minisign public key\n${line}\n`,
  };
}

const DEFAULT_TRUSTED_COMMENT = 'timestamp:1788800000\tfile:SHA256SUMS\thashed';

/** A detached `.minisig`, prehashed like `minisign -S` or legacy when asked. */
function signDetached(
  content: Buffer,
  key: Keypair,
  options: { algorithm?: 'ED' | 'Ed' | undefined; trustedComment?: string | undefined } = {},
): string {
  const algorithm = options.algorithm ?? 'ED';
  const trustedComment = options.trustedComment ?? DEFAULT_TRUSTED_COMMENT;
  const payload = algorithm === 'ED' ? createHash('blake2b512').update(content).digest() : content;
  const signature = sign(null, payload, key.privateKey);
  const global = sign(
    null,
    Buffer.concat([signature, Buffer.from(trustedComment, 'utf8')]),
    key.privateKey,
  );
  const line = Buffer.concat([Buffer.from(algorithm, 'latin1'), key.keyId, signature]).toString(
    'base64',
  );
  return [
    'untrusted comment: signature from minisign secret key',
    line,
    `trusted comment: ${trustedComment}`,
    global.toString('base64'),
    '',
  ].join('\n');
}

const VERSION = '9.9.9';

/** A directory shaped like a downloaded release: two assets, the sums and the signature. */
function publishedRelease(
  assets: Record<string, string> = {
    [`handoff-mcp-${VERSION}-win32-x64.exe`]: 'the standalone server\n',
    [`handoff-mcp-${VERSION}-format.tar.gz`]: 'the format tarball\n',
  },
  options: {
    key?: Keypair | undefined;
    signWith?: Keypair | undefined;
    algorithm?: 'ED' | 'Ed' | undefined;
    sums?: string | undefined;
  } = {},
): { dir: string; publicKey: string } {
  const dir = temporaryDir();
  const key = options.key ?? keypair();
  for (const [name, content] of Object.entries(assets)) {
    writeFileSync(join(dir, name), content);
  }
  const sums =
    options.sums ??
    Object.entries(assets)
      .map(([name, content]) => `${createHash('sha256').update(content).digest('hex')}  ${name}\n`)
      .join('');
  writeFileSync(join(dir, 'SHA256SUMS'), sums);
  writeFileSync(
    join(dir, 'SHA256SUMS.minisig'),
    signDetached(Buffer.from(sums, 'utf8'), options.signWith ?? key, {
      algorithm: options.algorithm,
    }),
  );

  const publicKeyPath = join(temporaryDir(), 'release.pub');
  writeFileSync(publicKeyPath, key.publicKeyFile);
  return { dir, publicKey: publicKeyPath };
}

function verify(published: { dir: string; publicKey: string }, version = VERSION) {
  return run(VERIFY_RELEASE, [version, published.publicKey, '--dir', published.dir, '--offline']);
}

describe('verify-release.mjs', () => {
  it('accepts a release whose assets, checksums and signature agree', () => {
    const result = verify(publishedRelease());
    expect(result.stderr).toContain('verified: 2 assets');
    expect(result.status).toBe(0);
  });

  it('accepts the legacy signature algorithm as well as the prehashed one', () => {
    expect(verify(publishedRelease(undefined, { algorithm: 'Ed' })).status).toBe(0);
  });

  it('rejects an asset that was changed after it was signed', () => {
    const published = publishedRelease();
    writeFileSync(join(published.dir, `handoff-mcp-${VERSION}-format.tar.gz`), 'tampered\n');
    const result = verify(published);
    expect(result.stderr).toMatch(/format\.tar\.gz hashes to [0-9a-f]{64}, SHA256SUMS says/);
    expect(result.status).not.toBe(0);
  });

  it('rejects checksums that were rewritten after they were signed', () => {
    const published = publishedRelease();
    const sums = readFileSync(join(published.dir, 'SHA256SUMS'), 'utf8');
    writeFileSync(join(published.dir, 'SHA256SUMS'), sums.replace(/^./, '0'));
    const result = verify(published);
    expect(result.stderr).toContain('the signature of SHA256SUMS does not match its content');
    expect(result.status).not.toBe(0);
  });

  it('rejects a signature made by another key', () => {
    const result = verify(publishedRelease(undefined, { signWith: keypair() }));
    expect(result.stderr).toMatch(/was made by key [0-9A-F]{16}, not by/);
    expect(result.status).not.toBe(0);
  });

  it('rejects a trusted comment rewritten around a valid signature', () => {
    const published = publishedRelease();
    const signature = readFileSync(join(published.dir, 'SHA256SUMS.minisig'), 'utf8').split('\n');
    signature[2] = 'trusted comment: file:something-else';
    writeFileSync(join(published.dir, 'SHA256SUMS.minisig'), signature.join('\n'));
    const result = verify(published);
    expect(result.stderr).toContain('the global signature does not match the trusted comment');
    expect(result.status).not.toBe(0);
  });

  it('rejects an asset nobody signed', () => {
    const published = publishedRelease();
    writeFileSync(join(published.dir, `handoff-mcp-${VERSION}-darwin-arm64`), 'smuggled\n');
    const result = verify(published);
    expect(result.stderr).toContain('is published but not listed in SHA256SUMS');
    expect(result.status).not.toBe(0);
  });

  it('rejects a release that is missing one of the assets of §3.5', () => {
    const published = publishedRelease({
      [`handoff-mcp-${VERSION}-win32-x64.exe`]: 'the standalone server\n',
    });
    const result = verify(published);
    expect(result.stderr).toContain(`the release has no handoff-mcp-${VERSION}-format.tar.gz`);
    expect(result.status).not.toBe(0);
  });

  it('rejects an asset carrying another version in its name', () => {
    const published = publishedRelease({
      [`handoff-mcp-${VERSION}-win32-x64.exe`]: 'the standalone server\n',
      [`handoff-mcp-${VERSION}-format.tar.gz`]: 'the format tarball\n',
      'handoff-mcp-1.2.3-format.tar.gz': 'from another build\n',
    });
    const result = verify(published);
    expect(result.stderr).toContain(`is not named after version ${VERSION}`);
    expect(result.status).not.toBe(0);
  });

  it('refuses a public key it cannot read', () => {
    const result = run(VERIFY_RELEASE, [
      VERSION,
      'not-a-key',
      '--dir',
      temporaryDir(),
      '--offline',
    ]);
    expect(result.stderr).toContain('is neither a minisign public key nor a readable file');
    expect(result.status).not.toBe(0);
  });
});

describe('format-tarball.mjs', () => {
  it('reads every version of §3.6 out of the files that define it', () => {
    const printed = run(FORMAT_TARBALL, ['--print']);
    expect(printed.status).toBe(0);

    const values = new Map(
      printed.stdout
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => line.split('=') as [string, string]),
    );
    const schemaConst = (file: string, field: string) => {
      const schema = JSON.parse(readFileSync(join(ROOT, 'schemas', file), 'utf8')) as {
        properties: Record<string, { const: number } | undefined>;
      };
      return String(schema.properties[field]?.const);
    };

    expect(values.get('spec_version')).toBe(
      schemaConst('handoff-spec.v1.schema.json', 'spec_version'),
    );
    expect(values.get('outcome_version')).toBe(
      schemaConst('handoff-outcome.v1.schema.json', 'outcome_version'),
    );
    expect(values.get('runbook_version')).toBe(
      schemaConst('handoff-runbook.v1.schema.json', 'runbook_version'),
    );
    expect(values.get('protocol_version')).toBe(
      readFileSync(join(ROOT, 'protocol', 'channel', 'protocol_version'), 'utf8').trim(),
    );
    expect(values.get('patterns_version')).toBe(
      String(
        (
          JSON.parse(readFileSync(join(ROOT, 'patterns', 'certain-secrets.v1.json'), 'utf8')) as {
            patterns_version: number;
          }
        ).patterns_version,
      ),
    );
    expect(values.get('package_version')).toBe(packageJson.version);
  });

  it('archives the five format folders and the version file, with no wrapping directory', () => {
    const out = join('dist', 'test-format-tarball');
    const built = run(FORMAT_TARBALL, ['--out', out]);
    expect(built.status).toBe(0);

    // The archive is listed by a repository-relative path on purpose: GNU tar, which is
    // the `tar` on `PATH` under Git Bash and on the Windows runner, reads `C:\…` as a
    // remote host and tries to open a network connection.
    const archive = `${out}/handoff-mcp-${packageJson.version}-format.tar.gz`;
    // The listing is split on `\r?\n`: the `tar` of the Windows runner ends its lines with
    // CRLF where the same command under Git Bash ends them with LF.
    const entries = execFileSync('tar', ['-tzf', archive.split('\\').join('/')], {
      cwd: ROOT,
      encoding: 'utf8',
    })
      .split(/\r?\n/)
      .filter((entry) => entry !== '');
    const top = [...new Set(entries.map((entry) => entry.split('/')[0]))].sort();
    expect(top).toEqual(['FORMAT-VERSION', 'docs', 'fixtures', 'patterns', 'protocol', 'schemas']);
    expect(entries).toContain('schemas/handoff-spec.v1.schema.json');
    expect(entries).toContain('protocol/channel/channel.v1.schema.json');
    rmSync(join(ROOT, out), { recursive: true, force: true });
  });
});

describe('changelog-section.mjs', () => {
  function changelog(text: string): string {
    const file = join(temporaryDir(), 'CHANGELOG.md');
    writeFileSync(file, text);
    return file;
  }

  it('prints the section of the version being released', () => {
    const result = run(CHANGELOG_SECTION, [packageJson.version]);
    expect(result.status).toBe(0);
    expect(result.stdout.trim().length).toBeGreaterThan(0);
    expect(result.stdout).not.toContain('## [');
  });

  it('fails on a version the changelog does not have', () => {
    const result = run(CHANGELOG_SECTION, ['4.2.0']);
    expect(result.stderr).toContain('has no section for 4.2.0');
    expect(result.status).not.toBe(0);
  });

  it('fails on a section with nothing in it', () => {
    const result = run(CHANGELOG_SECTION, [
      '1.0.0',
      changelog('# Changelog\n\n## [1.0.0] - 2026-01-01\n\n## [0.9.0] - 2025-12-01\n\n- old\n'),
    ]);
    expect(result.stderr).toContain('is empty');
    expect(result.status).not.toBe(0);
  });

  it('does not stop at a heading written inside a fenced block', () => {
    const result = run(CHANGELOG_SECTION, [
      '1.0.0',
      changelog(
        '# Changelog\n\n## [1.0.0] - 2026-01-01\n\n- first\n\n```md\n## [0.1.0]\n```\n\n- last\n\n## [0.9.0] - 2025-12-01\n\n- old\n',
      ),
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('- first');
    expect(result.stdout).toContain('- last');
    expect(result.stdout).not.toContain('- old');
  });
});

describe('release.yml', () => {
  it('runs on version tags and on a manual dispatch, and is never cancelled', () => {
    expect(release).toMatch(/on:\n {2}push:\n {4}tags: \['v\*'\]/);
    expect(release).toContain('cancel-in-progress: false');
  });

  it('refuses a tag that is not the version of package.json, before building anything', () => {
    const guard = between(release, '\n  guard:', '\n  sea_');
    expect(guard).toContain('does not match the package.json version');
    expect(guard).toContain('exit 1');
    expect(guard).toContain('build/changelog-section.mjs');
    for (const job of ['sea_win32_x64', 'sea_darwin_arm64', 'sea_darwin_x64', 'release']) {
      expect(between(release, `\n  ${job}:`, '\n    steps:')).toContain('needs:');
    }
  });

  it('builds win32-x64 always and the darwin binaries only when the input asks for them', () => {
    expect(between(release, '\n  sea_win32_x64:', '\n  sea_darwin')).not.toContain('if:');
    for (const job of ['sea_darwin_arm64', 'sea_darwin_x64']) {
      expect(between(release, `\n  ${job}:`, '\n\n')).toContain('if: ${{ inputs.include_macos }}');
    }
    expect(release).toMatch(
      /include_macos:\n {8}description:.*\n {8}type: boolean\n {8}default: false/,
    );
  });

  it('releases when the darwin legs are skipped, never when a job failed', () => {
    const guard = between(release, '\n    if: ${{ !cancelled()', '\n');
    expect(guard).toContain("needs.guard.result == 'success'");
    expect(guard).toContain("needs.sea_win32_x64.result == 'success'");
    expect(guard).toContain("!contains(needs.*.result, 'failure')");
  });

  it('produces the four assets of §3.5 and signs the checksums with the release key', () => {
    const job = between(release, '\n  release:', '\n  npm:');
    expect(job).toContain('node build/format-tarball.mjs --out dist/assets');
    expect(job).toContain('sha256sum handoff-mcp-* > SHA256SUMS');
    expect(job).toContain('minisign -S -s minisign.key -m SHA256SUMS');
    expect(job).toContain('secrets.MINISIGN_SECRET_KEY');
    expect(job).toContain('secrets.MINISIGN_PASSWORD');
    expect(job).toContain('rm -f minisign.key');
  });

  it('never puts a secret on a command line where the log would keep it', () => {
    expect(release).not.toMatch(/echo .*secrets\./);
    expect(release).not.toMatch(/-P \$\{\{ secrets/);
    expect(release).toContain('printf \'%s\\n\' "$MINISIGN_PASSWORD" | minisign');
  });

  it('creates the release from the changelog and verifies what it published', () => {
    const job = between(release, '\n  release:', '\n  npm:');
    expect(job).toContain('node build/changelog-section.mjs "$VERSION" > dist/notes.md');
    expect(job).toContain('--notes-file dist/notes.md');
    expect(job).toContain('--verify-tag');
    expect(job).toContain('node build/verify-release.mjs "$VERSION" keys/handoff-mcp-release.pub');
  });

  it('lets only the release job write to the repository', () => {
    expect(release).toMatch(/^permissions:\n {2}contents: read$/m);
    expect(release.match(/contents: write/g)).toHaveLength(1);
    expect(between(release, '\n  release:', '\n  npm:')).toContain('contents: write');
  });

  it('publishes to npm only while the PUBLISH_NPM variable says so', () => {
    const job = between(release, '\n  npm:');
    expect(job).toContain("if: ${{ vars.PUBLISH_NPM == 'true' }}");
    expect(job).toContain('npm publish --access public');
  });

  it('signs against the public key committed in the repository', () => {
    const pub = readFileSync(join(ROOT, 'keys', 'handoff-mcp-release.pub'), 'utf8');
    expect(pub.split('\n')[1]).toMatch(/^RW[A-Za-z0-9+/=]{54}$/);
    expect(release).toContain('keys/handoff-mcp-release.pub');
  });

  it('builds the executables the way sea.yml does', () => {
    /** The artifact `path:` a workflow uploads for one release target. */
    const uploadedPath = (text: string, target: string) => {
      const next = (between(text, `name: sea-${target}\n`).split('\n')[0] ?? '').trim();
      expect(next).toMatch(/^path: dist\/sea\/handoff-mcp-\*-/);
      return next;
    };

    const targets = ['win32-x64', 'darwin-arm64', 'darwin-x64'];
    expect(release.match(/pnpm build:sea/g)).toHaveLength(targets.length);
    expect(release.match(/pnpm smoke:sea/g)).toHaveLength(targets.length);
    for (const target of targets) {
      expect(uploadedPath(release, target)).toBe(uploadedPath(sea, target));
    }
    expect(release.match(/node-version-file: \.node-version/g)).toHaveLength(targets.length + 3);
  });

  it('has a script for each command the acceptance of T-011 runs by hand', () => {
    expect(packageJson.scripts['pack:format']).toBe('node build/format-tarball.mjs');
    expect(packageJson.scripts['verify:release']).toBe('node build/verify-release.mjs');
  });
});

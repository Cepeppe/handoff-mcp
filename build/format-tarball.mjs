// Builds the format tarball of a release (TECHNICAL-DESIGN §3.5).
//
// `handoff-mcp-<ver>-format.tar.gz` carries everything the public formats are made of —
// `schemas/`, `patterns/`, `protocol/`, `fixtures/`, `docs/` — plus a `FORMAT-VERSION`
// file listing the version of each format. The app consumes this asset rather than the
// repository (DD-03): it is the only way the closed side sees the open formats, and it is
// unpacked verbatim into `vendor/handoff-mcp/format/`, so the archive has no wrapping
// directory and its top level is exactly those five folders and the version file.
//
// The version numbers are read out of the files themselves, never typed here: a schema
// that bumps its `const` and a `patterns_version` that moves are picked up by the next
// release with nothing to remember.
//
// Usage:
//   node build/format-tarball.mjs              write dist/handoff-mcp-<ver>-format.tar.gz
//   node build/format-tarball.mjs --out <dir>  write it somewhere else
//   node build/format-tarball.mjs --print      print FORMAT-VERSION and exit
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The top-level entries of the archive, in the order §3.5 lists them. */
const FORMAT_DIRS = ['schemas', 'patterns', 'protocol', 'fixtures', 'docs'];

const VERSION_FILE = 'FORMAT-VERSION';
const STAGE_DIR = join('dist', 'format');

class BuildError extends Error {}

function fail(message) {
  throw new BuildError(message);
}

function readJson(...parts) {
  return JSON.parse(readFileSync(join(repoRoot, ...parts), 'utf8'));
}

/** The `const` a schema pins its own version field to. */
function schemaVersion(file, field) {
  const value = readJson('schemas', file).properties?.[field]?.const;
  if (typeof value !== 'number') {
    fail(`schemas/${file} does not pin ${field} to a constant`);
  }
  return value;
}

/**
 * The contents of `FORMAT-VERSION`: one `key=value` line per version of §3.6, sorted the
 * way that table lists them, plus the package version that produced the archive.
 */
function formatVersion() {
  const lines = [
    ['spec_version', schemaVersion('handoff-spec.v1.schema.json', 'spec_version')],
    ['outcome_version', schemaVersion('handoff-outcome.v1.schema.json', 'outcome_version')],
    ['runbook_version', schemaVersion('handoff-runbook.v1.schema.json', 'runbook_version')],
    [
      'protocol_version',
      Number(
        readFileSync(join(repoRoot, 'protocol', 'channel', 'protocol_version'), 'utf8').trim(),
      ),
    ],
    ['patterns_version', readJson('patterns', 'certain-secrets.v1.json').patterns_version],
    ['package_version', readJson('package.json').version],
  ];
  for (const [key, value] of lines) {
    if (value === undefined || value === null || Number.isNaN(value) || value === '') {
      fail(`${key} could not be read from the repository`);
    }
  }
  return lines.map(([key, value]) => `${key}=${value}\n`).join('');
}

/** The asset name of §3.5. */
function assetName(version) {
  return `handoff-mcp-${version}-format.tar.gz`;
}

/**
 * A path `tar` accepts on every platform, relative to the repository root. An absolute
 * Windows path reaches GNU tar as `host:path` and it tries to open a network connection,
 * which is how this script failed the first time it ran under Git Bash.
 */
function localPath(target) {
  const rel = relative(repoRoot, resolve(repoRoot, target));
  if (rel === '' || isAbsolute(rel)) {
    fail(`${target} cannot be expressed relative to the repository (another drive?)`);
  }
  return rel;
}

function build(outDir) {
  const version = readJson('package.json').version;
  const stage = join(repoRoot, STAGE_DIR);

  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  for (const dir of FORMAT_DIRS) {
    try {
      cpSync(join(repoRoot, dir), join(stage, dir), { recursive: true });
    } catch (error) {
      fail(`${dir}/ could not be staged: ${error.message}`);
    }
  }
  writeFileSync(join(stage, VERSION_FILE), formatVersion());

  mkdirSync(resolve(repoRoot, outDir), { recursive: true });
  const out = localPath(join(outDir, assetName(version)));
  // `tar` ships with Windows 10+, macOS and every Linux runner; the entries are named
  // explicitly so the archive has no `./` prefix and no wrapping directory.
  try {
    execFileSync('tar', ['-czf', out, '-C', STAGE_DIR, ...FORMAT_DIRS, VERSION_FILE], {
      cwd: repoRoot,
      stdio: 'pipe',
      encoding: 'utf8',
    });
  } catch (error) {
    fail(
      `tar failed: ${[error.stdout, error.stderr].filter(Boolean).join('\n').trim() || error.message}`,
    );
  }
  rmSync(stage, { recursive: true, force: true });

  process.stdout.write(`${out}\n`);
  console.error(`  size    ${(statSync(resolve(repoRoot, out)).size / 1024).toFixed(0)} KB`);
  console.error(`  entries ${[...FORMAT_DIRS, VERSION_FILE].join(' ')}`);
}

function main(argv) {
  if (argv.includes('--print')) {
    process.stdout.write(formatVersion());
    return;
  }
  const outIndex = argv.indexOf('--out');
  if (outIndex !== -1 && argv[outIndex + 1] === undefined) fail('--out needs a value');
  build(outIndex === -1 ? 'dist' : argv[outIndex + 1]);
}

try {
  main(process.argv.slice(2));
} catch (error) {
  if (!(error instanceof BuildError)) throw error;
  console.error(`format-tarball: ${error.message}`);
  process.exitCode = 2;
}

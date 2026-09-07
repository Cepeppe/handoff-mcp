/**
 * Guards the Single Executable Application build (TECHNICAL-DESIGN §5.1, §3.5, SRV-24).
 *
 * The binaries themselves are ~90 MB and take minutes to produce, so they are built and
 * smoked by `sea.yml` and by hand (`pnpm build:sea && pnpm smoke:sea`), not here. What
 * this suite pins is everything that can drift silently: the release asset names, the
 * paths inside `sea-config.json`, the constants `postject` needs, and the agreement
 * between the build script and the workflow that is supposed to run it on three platforms.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const BUILD_SEA = join(ROOT, 'build', 'sea', 'build-sea.mjs');
const SEA_CONFIG = join(ROOT, 'build', 'sea', 'sea-config.json');
const SEA_WORKFLOW = join(ROOT, '.github', 'workflows', 'sea.yml');

/** The three release targets of §3.5, with the asset name each one must produce. */
const ASSETS: ReadonlyArray<readonly [string, string]> = [
  ['darwin-arm64', 'handoff-mcp-<ver>-darwin-arm64'],
  ['darwin-x64', 'handoff-mcp-<ver>-darwin-x64'],
  ['win32-x64', 'handoff-mcp-<ver>-win32-x64.exe'],
];

const version = (
  JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }
).version;
const buildSeaSource = readFileSync(BUILD_SEA, 'utf8');
const workflow = readFileSync(SEA_WORKFLOW, 'utf8');

interface PrintedTarget {
  target: string;
  version: string;
  asset: string;
  out: string;
}

function printTarget(host: string): PrintedTarget {
  const stdout = execFileSync(process.execPath, [BUILD_SEA, '--print-target', '--host', host], {
    encoding: 'utf8',
  });
  return JSON.parse(stdout) as PrintedTarget;
}

describe('release asset names (§3.5)', () => {
  it.each(ASSETS)('%s is named %s', (host, shape) => {
    const printed = printTarget(host);
    expect(printed.target).toBe(host);
    expect(printed.asset).toBe(shape.replace('<ver>', version));
  });

  it('refuses a platform that is not a release target', () => {
    expect(() =>
      execFileSync(process.execPath, [BUILD_SEA, '--print-target', '--host', 'linux-x64'], {
        encoding: 'utf8',
        stdio: 'pipe',
      }),
    ).toThrow(/not a release target/);
  });

  it('refuses to pretend it can cross-build', () => {
    expect(() =>
      execFileSync(process.execPath, [BUILD_SEA, '--host', 'darwin-arm64'], {
        encoding: 'utf8',
        stdio: 'pipe',
      }),
    ).toThrow(/cannot cross-build/);
  });
});

interface SeaConfig {
  main: string;
  output: string;
  disableExperimentalSEAWarning: boolean;
  useSnapshot: boolean;
  useCodeCache: boolean;
}

describe('sea-config.json', () => {
  const config = JSON.parse(readFileSync(SEA_CONFIG, 'utf8')) as SeaConfig;

  it('embeds the bundle that build/bundle.mjs writes', () => {
    const bundler = readFileSync(join(ROOT, 'build', 'bundle.mjs'), 'utf8');
    expect(config.main).toBe('dist/handoff-mcp.cjs');
    expect(bundler).toContain(`'dist', 'handoff-mcp.cjs'`);
  });

  it('writes the blob where git ignores it', () => {
    expect(config.output).toMatch(/^dist\//);
    expect(readFileSync(join(ROOT, '.gitignore'), 'utf8')).toMatch(/^dist\/$/m);
  });

  it('suppresses the experimental banner, which would pollute the stdio transport', () => {
    expect(config.disableExperimentalSEAWarning).toBe(true);
  });

  it('keeps the snapshot and the code cache off, so the blob stays portable', () => {
    expect(config.useSnapshot).toBe(false);
    expect(config.useCodeCache).toBe(false);
  });
});

describe('build-sea.mjs', () => {
  it("uses Node's documented sentinel fuse", () => {
    expect(buildSeaSource).toContain('NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2');
  });

  it('injects into the Mach-O segment Node reads on macOS', () => {
    expect(buildSeaSource).toContain('--macho-segment-name');
    expect(buildSeaSource).toContain("'NODE_SEA'");
  });

  it('removes the platform signature before injecting and re-signs macOS afterwards', () => {
    expect(buildSeaSource).toContain("'remove', '/s'");
    expect(buildSeaSource).toContain("'--remove-signature'");
    expect(buildSeaSource).toContain("'--sign', '-'");
  });
});

describe('sea.yml', () => {
  it('has one job per release target', () => {
    for (const [target] of ASSETS) expect(workflow).toContain(`\n  ${target}:\n`);
  });

  it('builds win32-x64 on main pushes and keeps the darwin legs on dispatch', () => {
    expect(workflow).toMatch(/push:\n {4}branches: \[main\]/);
    const darwinLegs = workflow.split('\n  darwin-').slice(1);
    expect(darwinLegs).toHaveLength(2);
    for (const leg of darwinLegs) {
      expect(leg).toContain("if: github.event_name == 'workflow_dispatch'");
    }
    expect(workflow.split('\n  win32-x64:')[1]?.split('\n  darwin-')[0]).not.toContain('if:');
  });

  it('runs the build and the smoke test of every leg and uploads the asset', () => {
    expect(workflow.match(/pnpm build:sea/g)).toHaveLength(ASSETS.length);
    expect(workflow.match(/pnpm smoke:sea/g)).toHaveLength(ASSETS.length);
    for (const [target] of ASSETS) expect(workflow).toContain(`name: sea-${target}`);
  });

  it('pins the Node line in one place, .node-version', () => {
    expect(workflow.match(/node-version-file: \.node-version/g)).toHaveLength(ASSETS.length);
    expect(readFileSync(join(ROOT, '.node-version'), 'utf8').trim()).toBe('24');
  });
});

describe('package.json', () => {
  const scripts = (
    JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    }
  ).scripts;

  it('bundles before building the executable, so the blob is never stale', () => {
    expect(scripts['build:sea']).toBe('pnpm build && node build/sea/build-sea.mjs');
    expect(scripts['smoke:sea']).toBe('node build/sea/smoke.mjs');
  });
});

/**
 * The third-party notices of the bundle and of the executables (build/third-party-notices.mjs).
 *
 * `dist/handoff-mcp.cjs` inlines npm packages whose licences ask for their notice to travel
 * with every copy, so the list is read from esbuild's metafile. These tests lay out a small
 * `node_modules` the way pnpm does and check that the list follows the inputs, that a package
 * without a licence file stops the build, and what the two renderings put where.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

interface BundledPackage {
  name: string;
  version: string;
  license: string;
  text: string;
}

interface NodeLicence {
  version: string;
  source: string;
  text: string | undefined;
}

interface NoticesModule {
  METAFILE: string;
  BUNDLE_NOTICES: string;
  packageDirOf(input: string, root: string): string | null;
  bundledPackages(metafile: { inputs: Record<string, unknown> }, root: string): BundledPackage[];
  renderBundleNotices(packages: BundledPackage[]): string;
  renderExecutableNotices(
    packages: BundledPackage[],
    options: { asset: string; node: NodeLicence },
  ): string;
  executableNoticesName(version: string, target: string): string;
}

// A plain JavaScript build script: imported by URL, so its type is the interface above.
const notices = (await import(
  new URL('../../build/third-party-notices.mjs', import.meta.url).href
)) as NoticesModule;

const temporary: string[] = [];

afterAll(() => {
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true });
});

const ALPHA = 'node_modules/.pnpm/alpha@1.0.0/node_modules/alpha';
const BETA = 'node_modules/.pnpm/@scope+beta@2.0.0/node_modules/@scope/beta';
const GAMMA = 'node_modules/.pnpm/gamma@3.0.0/node_modules/gamma';

/** A root with three packages: two with a licence file under two spellings, one without. */
function tree(): string {
  const root = mkdtempSync(join(tmpdir(), 'handoff-notices-'));
  temporary.push(root);
  const place = (dir: string, manifest: object, licence?: [string, string]) => {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, 'package.json'), JSON.stringify(manifest));
    writeFileSync(join(root, dir, 'index.js'), '');
    if (licence !== undefined) writeFileSync(join(root, dir, licence[0]), licence[1]);
  };
  place(ALPHA, { name: 'alpha', version: '1.0.0', license: 'MIT' }, ['LICENSE', 'alpha text\r\n']);
  place(BETA, { name: '@scope/beta', version: '2.0.0', license: 'ISC' }, [
    'LICENCE.md',
    'beta ```quoted``` text',
  ]);
  place(GAMMA, { name: 'gamma', version: '3.0.0', license: 'MIT' });
  return root;
}

const metafile = (...inputs: string[]) => ({
  inputs: Object.fromEntries(inputs.map((input) => [input, {}])),
});

describe('the packages of the bundle', () => {
  it('reads the package of an input from the last node_modules of its path', () => {
    const root = resolve('/repo');
    expect(notices.packageDirOf('src/main.ts', root)).toBeNull();
    expect(
      notices.packageDirOf('node_modules/.pnpm/zod@4.5.4/node_modules/zod/v4/core/core.js', root),
    ).toBe(resolve(root, 'node_modules/.pnpm/zod@4.5.4/node_modules', 'zod'));
    expect(notices.packageDirOf(`${BETA}/dist/cjs/index.js`, root)).toBe(resolve(root, BETA));
    expect(notices.packageDirOf('node_modules\\outer\\node_modules\\inner\\a.js', root)).toBe(
      resolve(root, 'node_modules/outer/node_modules', 'inner'),
    );
  });

  it('lists each package once, sorted, with the text of its licence file', () => {
    const root = tree();
    const packages = notices.bundledPackages(
      metafile(`${ALPHA}/index.js`, `${ALPHA}/lib/other.js`, `${BETA}/index.js`, 'src/main.ts'),
      root,
    );
    expect(packages.map((pkg) => `${pkg.name}@${pkg.version} ${pkg.license}`)).toEqual([
      '@scope/beta@2.0.0 ISC',
      'alpha@1.0.0 MIT',
    ]);
    expect(packages[1]?.text).toBe('alpha text\r\n');
  });

  it('stops at a package that has no licence file', () => {
    const root = tree();
    expect(() => notices.bundledPackages(metafile(`${GAMMA}/index.js`), root)).toThrow(
      /gamma@3\.0\.0 is in the bundle but has no licence file/,
    );
  });
});

describe('the renderings', () => {
  const root = tree();
  const packages = notices.bundledPackages(metafile(`${ALPHA}/index.js`, `${BETA}/index.js`), root);

  it('fences every text, longer than any fence the text itself contains', () => {
    const text = notices.renderBundleNotices(packages);
    expect(text).toContain('## alpha 1.0.0 (MIT)\n\n```text\nalpha text\n```');
    expect(text).toContain('## @scope/beta 2.0.0 (ISC)\n\n````text\nbeta ```quoted``` text\n````');
  });

  it('puts Node.js before the packages in the notices of an executable', () => {
    const text = notices.renderExecutableNotices(packages, {
      asset: 'handoff-mcp-9.9.9-win32-x64.exe',
      node: { version: 'v24.1.0', source: '/node/LICENSE', text: 'node text' },
    });
    expect(text.split('\n')[0]).toBe('# Third-party notices: handoff-mcp-9.9.9-win32-x64.exe');
    const node = text.indexOf('## Node.js v24.1.0');
    expect(node).toBeGreaterThan(-1);
    expect(node).toBeLessThan(text.indexOf('## @scope/beta 2.0.0'));
    expect(text).toContain('```text\nnode text\n```');
  });

  it('links the licence of Node.js when its text could not be read', () => {
    const text = notices.renderExecutableNotices([], {
      asset: 'x.exe',
      node: { version: 'v24.1.0', source: 'https://example.test/LICENSE', text: undefined },
    });
    expect(text).toContain('The licence text of this version is at https://example.test/LICENSE.');
  });

  it('names the asset after the executable it sits beside', () => {
    expect(notices.executableNoticesName('1.8.0', 'darwin-arm64')).toBe(
      'handoff-mcp-1.8.0-darwin-arm64-notices.md',
    );
  });
});

describe('the real bundle', () => {
  it('has a notices file that names every package esbuild inlined', () => {
    const meta = join(ROOT, notices.METAFILE);
    if (!existsSync(meta)) return; // Nothing built yet.
    const packages = notices.bundledPackages(
      JSON.parse(readFileSync(meta, 'utf8')) as { inputs: Record<string, unknown> },
      ROOT,
    );
    expect(packages.map((pkg) => pkg.name)).toContain('@modelcontextprotocol/sdk');
    const written = readFileSync(join(ROOT, notices.BUNDLE_NOTICES), 'utf8');
    for (const pkg of packages) {
      expect(pkg.text.trim()).not.toBe('');
      expect(written).toContain(`## ${pkg.name} ${pkg.version} (${pkg.license})`);
    }
  });
});

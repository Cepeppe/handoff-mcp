/**
 * What the npm package ships (TECHNICAL-DESIGN §3.5, SRV-26).
 *
 * Two things went wrong here and neither showed up in any other check. `files` listed the
 * whole of `dist/`, which npm honours over `.gitignore`, so a `pnpm pack` on a machine that
 * had ever built a Single Executable Application carried the executables, the SEA blob and
 * the leftover format tarballs with it — 71.9 MB packed against a bundle of 0.8 MB. And the
 * published pages of `docs/` link to `../fixtures/`, `../protocol/`, `../keys/` and
 * `../CHANGELOG.md`, which were outside `files`: `pnpm check:links` walks the repository and
 * resolves them there, so it cannot see that the same page dangles inside an installed
 * package.
 *
 * Both are asserted against `package.json` and the working tree rather than against a real
 * `npm pack`, which would cost a subprocess and a temporary directory on every run. What
 * the assertions encode is the rule npm applies: a `files` entry ending in `/` ships that
 * whole directory, any other entry ships that one path, and neither `.gitignore` nor
 * `.npmignore` can take back what `files` names.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  bin: Record<string, string>;
  files: string[];
};

/** True when `path`, repository-relative with forward slashes, is inside the package. */
function shipped(path: string): boolean {
  return manifest.files.some((entry) =>
    entry.endsWith('/') ? path === entry.slice(0, -1) || path.startsWith(entry) : path === entry,
  );
}

/**
 * The targets of the inline links and reference definitions of one Markdown source, with
 * the 1-based line each sits on. Fenced blocks are blanked first, keeping the line count,
 * because a path inside a fence is an example and not a link. This is the narrow half of
 * `build/check-links.mjs`: that script resolves every link of the repository, this one only
 * needs the ones that leave the folder they are written in.
 */
function relativeLinks(source: string): { target: string; line: number }[] {
  let fence: string | null = null;
  const text = source
    .split('\n')
    .map((line) => {
      const marker = /^\s{0,3}(```+|~~~+)/.exec(line);
      if (fence === null) {
        if (marker === null) return line;
        fence = marker[1] as string;
        return '';
      }
      if ((marker?.[1] ?? '').startsWith(fence)) fence = null;
      return '';
    })
    .join('\n');

  const found: { target: string; line: number }[] = [];
  const patterns = [
    /!?\[(?:[^\]\\]|\\.)*\]\(\s*<?([^\s()<>]*)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g,
    /^[ \t]{0,3}\[(?:[^\]\\]|\\.)+\]:[ \t]*<?(\S+?)>?$/gm,
  ];
  for (const pattern of patterns) {
    for (let m = pattern.exec(text); m !== null; m = pattern.exec(text)) {
      found.push({ target: (m[1] ?? '').trim(), line: text.slice(0, m.index).split('\n').length });
    }
  }
  return found;
}

/**
 * Appends one line per link of `page` that leaves its folder for a path the package does
 * not ship. A link inside `docs/` is `check-links`' business; an external one is nobody's.
 */
function danglingInPackage(page: string): string[] {
  const problems: string[] = [];
  for (const { target, line } of relativeLinks(readFileSync(join(ROOT, page), 'utf8'))) {
    const path = target.split('#')[0] ?? '';
    if (path === '' || /^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith('//')) continue;
    if (!path.startsWith('../')) continue;

    const relative = path.slice(3).replace(/\/$/, '');
    const where = `${page}:${String(line)}`;
    const onDisk = join(ROOT, relative);
    if (!existsSync(onDisk)) {
      problems.push(`${where} links to ${path}, which does not exist`);
      continue;
    }
    const wanted = statSync(onDisk).isDirectory() ? `${relative}/` : relative;
    if (!shipped(wanted)) problems.push(`${where} links to ${path}, which files omits`);
  }
  return problems;
}

describe('the published package', () => {
  it('ships the bundle `bin` points at', () => {
    const targets = Object.values(manifest.bin);
    expect(targets).toEqual(['dist/handoff-mcp.cjs']);
    for (const target of targets) expect(shipped(target)).toBe(true);
  });

  it('ships the bundle and its notices out of dist/, never the directory', () => {
    // `dist/` also holds the SEA output and the format tarballs. Listing the directory put
    // 189 MB of build products into the package; listing the bundle puts the bundle in, and
    // the notices of the packages the bundle inlines go with it.
    expect(manifest.files.filter((entry) => entry.startsWith('dist'))).toEqual([
      'dist/handoff-mcp.cjs',
      'dist/THIRD-PARTY-NOTICES.md',
    ]);
    expect(shipped('dist/sea/handoff-mcp.blob')).toBe(false);
    expect(shipped('dist/handoff-mcp.cjs.map')).toBe(false);
    expect(shipped('dist/handoff-mcp.meta.json')).toBe(false);
  });

  it('gives the bundle the shebang npm needs to launch it', () => {
    // npm reads the first line of a `bin` target to decide how to run it. Without one, the
    // shim it generates executes the file itself: `npx baton-handoff-mcp` handed the
    // CommonJS bundle to /bin/sh (a screen of syntax errors, exit 2) and to cmd.exe
    // (nothing at all, exit 0). That is the documented way to install this server.
    expect(readFileSync(join(ROOT, 'build', 'bundle.mjs'), 'utf8')).toContain(
      "banner: { js: '#!/usr/bin/env node' }",
    );

    const bundle = join(ROOT, 'dist', 'handoff-mcp.cjs');
    if (!existsSync(bundle)) return; // Nothing built yet; the assertion above still holds.
    expect(readFileSync(bundle, 'utf8').split('\n')[0]).toBe('#!/usr/bin/env node');
  });

  it('ships every path a page of docs/ links to', () => {
    const pages = readdirSync(join(ROOT, 'docs'))
      .filter((name) => name.endsWith('.md'))
      .sort();
    expect(pages.length).toBeGreaterThan(5);

    const problems = pages.flatMap((page) => danglingInPackage(`docs/${page}`));
    expect(problems).toEqual([]);
  });

  it('finds the links it is looking for, and skips the ones inside a fence', () => {
    // Without this the test above passes on a page whose links it simply failed to parse.
    const found = relativeLinks(
      ['[a](../schemas/x.json)', '```', '[b](../nowhere/y.json)', '```', '[c]: ../keys/z.pub'].join(
        '\n',
      ),
    );
    expect(found.map((link) => link.target)).toEqual(['../schemas/x.json', '../keys/z.pub']);
  });
});

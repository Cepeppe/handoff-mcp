/**
 * Environment variable names (TECHNICAL-DESIGN §5.12, Appendix B A-23).
 *
 * Claude Code strips variables whose name contains `TOKEN`, `SECRET`, `PASSWORD`, `KEY`
 * or `AUTH` from the environment of a server declared in project scope. A name that falls
 * foul of that arrives as `undefined` in exactly one deployment shape and nowhere else,
 * which is the kind of defect that reaches a user, so the rule is a test rather than a
 * convention: it greps `src/` and holds whatever the tree actually reads.
 *
 * The second assertion is what makes the first one true tomorrow as well: `src/config.ts`
 * is the only module allowed to touch `process.env`, so every name is declared in one
 * list and none can be added without passing here.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ENV_VAR_NAMES, STRIPPED_ENV_SUBSTRINGS } from '../../src/config';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SRC = join(ROOT, 'src');

/** Every TypeScript file under `src/`, as repository-relative paths with forward slashes. */
function sources(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sources(path));
    else if (entry.name.endsWith('.ts')) found.push(relative(ROOT, path).replaceAll('\\', '/'));
  }
  return found.sort();
}

const FILES = sources(SRC);

/** `process.env.NAME` and `process.env['NAME']`, the two ways a name can be read. */
const NAMED_READ = /process\.env(?:\.([A-Za-z_$][\w$]*)|\[\s*['"`]([^'"`]+)['"`]\s*\])/gu;

/** Any mention at all, including `process.env` passed on as a whole record. */
const ANY_READ = /process\.env\b/u;

describe('A-23: the names the server reads', () => {
  it('avoid every substring Claude Code strips in project scope', () => {
    for (const name of ENV_VAR_NAMES) {
      for (const substring of STRIPPED_ENV_SUBSTRINGS) {
        expect(name.toUpperCase().includes(substring), `${name} contains ${substring}`).toBe(false);
      }
    }
  });

  it('is a list the grep of src/ agrees with', () => {
    const found = new Set<string>();
    for (const file of FILES) {
      const text = readFileSync(join(ROOT, file), 'utf8');
      for (const match of text.matchAll(NAMED_READ)) {
        const name = match[1] ?? match[2];
        if (name !== undefined) found.add(name);
      }
    }
    for (const name of found) {
      expect(ENV_VAR_NAMES as readonly string[], `${name} is read but not declared`).toContain(
        name,
      );
    }
  });

  it('is the only list, because only src/config.ts touches process.env', () => {
    const readers = FILES.filter((file) => ANY_READ.test(readFileSync(join(ROOT, file), 'utf8')));
    expect(readers).toEqual(['src/config.ts']);
  });

  it('are declared without duplicates', () => {
    expect(new Set(ENV_VAR_NAMES).size).toBe(ENV_VAR_NAMES.length);
  });

  it('would catch a name that breaks the rule', () => {
    const wrong = ['HANDOFF_TOKEN', 'HANDOFF_API_KEY', 'MY_SECRET', 'GH_AUTH', 'DB_PASSWORD'];
    for (const name of wrong) {
      expect(
        STRIPPED_ENV_SUBSTRINGS.some((substring) => name.includes(substring)),
        name,
      ).toBe(true);
    }
  });
});

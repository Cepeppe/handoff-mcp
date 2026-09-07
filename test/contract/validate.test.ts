/**
 * Contract test of the validation pipeline (TECHNICAL-DESIGN §4.2, §4.7.5, §5.4).
 *
 * The fixtures are the contract: `test/contract/schemas.test.ts` asserts what the schema
 * alone accepts and rejects, and this file asserts what the whole pipeline answers — the
 * error code and the exact path of `<name>.expected.json`. The Rust implementation of the
 * app (T-029) must answer the same on the same files.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { validateSpec } from '../../src/format';

const FIXTURES = fileURLToPath(new URL('../../fixtures/', import.meta.url));

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function fixtureFiles(dir: string): string[] {
  return readdirSync(join(FIXTURES, dir))
    .filter((name) => name.endsWith('.json') && !name.endsWith('.expected.json'))
    .sort();
}

interface ExpectedProblem {
  path: string;
  code: 'SPEC_INVALID' | 'SPEC_VERSION_UNSUPPORTED';
  schema_valid?: boolean;
}

const valid = fixtureFiles('specs/valid');
const invalid = fixtureFiles('specs/invalid');

function expectationFor(name: string): ExpectedProblem {
  return readJson(
    join(FIXTURES, 'specs/invalid', name.replace(/\.json$/, '.expected.json')),
  ) as ExpectedProblem;
}

describe('every valid spec fixture', () => {
  it.each(valid)('%s passes the whole pipeline', (name) => {
    const result = validateSpec(readJson(join(FIXTURES, 'specs/valid', name)));
    expect(result.ok ? [] : result.error.problems).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

describe('every invalid spec fixture', () => {
  it.each(invalid)('%s is rejected with the expected code and path', (name) => {
    const expected = expectationFor(name);
    const result = validateSpec(readJson(join(FIXTURES, 'specs/invalid', name)));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(expected.code);
    // One fixture, one mistake, one problem: the fixtures are written that way, and a
    // second problem here would mean the pipeline reports a mistake twice.
    expect(result.error.problems.map((problem) => problem.path)).toEqual([expected.path]);
  });

  it.each(invalid)('%s comes back with a problem and a fix that say something', (name) => {
    const result = validateSpec(readJson(join(FIXTURES, 'specs/invalid', name)));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    for (const problem of result.error.problems) {
      expect(problem.problem.length).toBeGreaterThan(0);
      expect(problem.fix.length).toBeGreaterThan(0);
      // The renderer has a fallback for a keyword nobody translated. No fixture may need
      // it: reaching it means the schema grew a keyword and the messages did not.
      expect(problem.fix).not.toContain('matches the published schema');
    }
  });

  it('covers both error codes', () => {
    const codes = invalid.map((name) => expectationFor(name).code);
    expect(codes).toContain('SPEC_INVALID');
    expect(codes).toContain('SPEC_VERSION_UNSUPPORTED');
  });
});

/**
 * Contract test for the matching rule and the conversion (TECHNICAL-DESIGN §4.5.3, §4.5.4).
 *
 * `fixtures/matching/*.json` is the contract: the app re-implements this rule in Rust
 * (T-029, T-044) and must produce the same results, in the same order, with the same
 * `matched_words`. The stubs each case carries are expanded here into schema-valid runbooks
 * — the expansion rule is written down in `fixtures/matching/README.md` — and validated
 * before they are matched, so no case can rest on a document the format would refuse.
 *
 * The second half asserts the conversion against the published example: the `runbooks[0]`
 * item of `fixtures/outcomes/runbook-match.json` is what an agent is shown for the runbook
 * `fixtures/runbooks/valid/stripe-webhook.json`, so the converter has to produce it field
 * for field.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';
import type { AnySchema, ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';

import {
  matchRunbooks,
  toRunbookMatch,
  type Runbook,
  type StoredRunbook,
} from '../../src/runbooks';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const FIXTURES = join(ROOT, 'fixtures');

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
const validateRunbook: ValidateFunction = ajv.compile(
  readJson(join(ROOT, 'schemas', 'handoff-runbook.v1.schema.json')) as AnySchema,
);
const validateSpecSchema: ValidateFunction = ajv.compile(
  readJson(join(ROOT, 'schemas', 'handoff-spec.v1.schema.json')) as AnySchema,
);

/** The four fields of a runbook the matching rule reads; everything else is filler. */
interface RunbookStub {
  id: string;
  where: string;
  goal: string;
  last_verified_at: string;
}

interface MatchingCase {
  case: string;
  why: string;
  query: { where: string; goal: string; lang?: string };
  runbooks: RunbookStub[];
  expected: { id: string; matched_words: string[] }[];
}

/**
 * The expansion of `fixtures/matching/README.md`: the same filler for every stub, so a case
 * can only ever differ from another in the four fields it declares.
 */
function expand(stub: RunbookStub): Runbook {
  return {
    runbook_version: 1,
    id: stub.id,
    where: stub.where,
    goal: stub.goal,
    why_human: 'A person has to do this in the browser.',
    url: null,
    lang: null,
    values: {},
    secrets: {},
    steps: [{ text: 'Do the thing.', url: null, values: [], warning: null, annotations: [] }],
    verify: null,
    trust: 'verified',
    last_verified_at: stub.last_verified_at,
    last_run_failed_at: null,
    runs: 1,
    created_at: stub.last_verified_at,
    updated_at: stub.last_verified_at,
    origin: { app: 'handoff-app', app_version: '1.0.0' },
  };
}

function stored(stub: RunbookStub): StoredRunbook {
  return { path: join(FIXTURES, 'matching', `${stub.id}.json`), runbook: expand(stub) };
}

const CASE_FILES = readdirSync(join(FIXTURES, 'matching'))
  .filter((name) => name.endsWith('.json'))
  .sort();

const CASES = CASE_FILES.map((name) => readJson(join(FIXTURES, 'matching', name)) as MatchingCase);

describe('matching fixtures', () => {
  it('ships at least 12 cases, each named after its file', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(12);
    expect(CASES.map((item) => `${item.case}.json`)).toEqual(CASE_FILES);
    for (const item of CASES) expect(item.why.length).toBeGreaterThan(0);
  });

  it.each(CASES.map((item) => [item.case, item] as const))(
    'expands %s into runbooks the schema accepts',
    (_name, item) => {
      for (const stub of item.runbooks) {
        expect(validateRunbook(expand(stub)), JSON.stringify(validateRunbook.errors)).toBe(true);
      }
    },
  );

  it.each(CASES.map((item) => [item.case, item] as const))('matches %s', (_name, item) => {
    const matched = matchRunbooks(item.runbooks.map(stored), item.query);
    expect(
      matched.map((one) => ({
        id: one.stored.runbook.id,
        matched_words: [...one.matchedWords],
      })),
    ).toEqual(item.expected);
  });

  it('covers the case families the rule is made of', () => {
    const names = CASES.map((item) => item.case).join(' ');
    for (const family of [
      'arrow',
      'separator',
      'case-insensitive',
      'nfkc',
      'italian',
      'lang',
      'no-match',
      'ranking',
      'cap-at-five',
    ]) {
      expect(names, `no case covers ${family}`).toContain(family);
    }
  });
});

describe('conversion to a draft spec', () => {
  const runbook = readJson(join(FIXTURES, 'runbooks/valid', 'stripe-webhook.json')) as Runbook;
  const outcome = readJson(join(FIXTURES, 'outcomes', 'runbook-match.json')) as {
    runbooks: (Record<string, unknown> & { path: string; matched_words: string[] })[];
  };
  const published = outcome.runbooks[0];

  it('reproduces the published runbook_match item field for field', () => {
    expect(published).toBeDefined();
    const item = toRunbookMatch({ path: published?.path ?? '', runbook }, [
      ...(published?.matched_words ?? []),
    ]);
    expect(JSON.parse(JSON.stringify(item))).toEqual(published);
  });

  it('derives those matched words from a real query', () => {
    const matched = matchRunbooks([{ path: 'x.json', runbook }], {
      where: 'Stripe Dashboard > Developers > Webhooks',
      goal: 'Set up Stripe webhook for payment notifications',
      lang: 'en',
    });
    expect(matched.map((one) => [...one.matchedWords])).toEqual([published?.matched_words]);
  });

  it('produces a draft the spec schema accepts but the semantic rules do not', () => {
    const item = toRunbookMatch({ path: 'x.json', runbook }, []);
    expect(validateSpecSchema(item.draft_spec), JSON.stringify(validateSpecSchema.errors)).toBe(
      true,
    );
  });
});

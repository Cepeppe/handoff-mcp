/**
 * The translation of ajv errors into problems (TECHNICAL-DESIGN §4.7.5, §5.4).
 *
 * The fixtures in `test/contract/validate.test.ts` pin the path of every schema failure;
 * here the texts are pinned, and so is the collapsing of the two ajv error groups that
 * describe one mistake with several errors.
 */
import { describe, expect, it } from 'vitest';

import { validateSpec, type Problem } from '../../../src/format';

function baseSpec(): Record<string, unknown> {
  return {
    spec_version: 1,
    goal: 'Register the Stripe webhook for payment events',
    where: 'Stripe Dashboard → Developers → Webhooks',
    why_human: 'Requires access to the production Stripe account.',
    values: {},
    steps: [{ text: 'Click Add destination and paste the endpoint URL.' }],
  };
}

function problemsOf(spec: unknown): readonly Problem[] {
  const result = validateSpec(spec);
  return result.ok ? [] : result.error.problems;
}

function only(spec: unknown): Problem {
  const problems = problemsOf(spec);
  expect(problems).toHaveLength(1);
  return problems[0] as Problem;
}

const str = (n: number): string => 'x'.repeat(n);

describe('additionalProperties', () => {
  it('reads as the design writes it when problem and fix are put together', () => {
    const spec = baseSpec();
    spec['steps'] = [{ text: 'Open it.', expected_result: 'a webhook exists' }];
    const problem = only(spec);
    expect(problem.path).toBe('steps[0].expected_result');
    expect(problem.fix).toBe(
      'Unknown field `expected_result` at `steps[0]`. Allowed fields: text, url, values, warning.',
    );
  });

  it('names the top level and lists the fields of the spec', () => {
    const problem = only({ ...baseSpec(), warnings: 'careful' });
    expect(problem).toEqual({
      path: 'warnings',
      problem: '`warnings` is not a field of the format.',
      fix: 'Unknown field `warnings` at the top level. Allowed fields: spec_version, goal, where, url, why_human, values, secrets, steps, verify, lang.',
    });
  });
});

describe('the other keywords of the schema', () => {
  it('translates required', () => {
    const spec = baseSpec();
    delete spec['why_human'];
    expect(only(spec)).toEqual({
      path: 'why_human',
      problem: 'Required field `why_human` is missing at the top level.',
      fix: 'Add `why_human` at the top level.',
    });
  });

  it('translates required inside a step', () => {
    const spec = { ...baseSpec(), steps: [{ warning: 'careful' }] };
    expect(only(spec)).toEqual({
      path: 'steps[0].text',
      problem: 'Required field `text` is missing at `steps[0]`.',
      fix: 'Add `text` at `steps[0]`.',
    });
  });

  it('translates maxLength with the limit of the schema', () => {
    expect(only({ ...baseSpec(), goal: str(301) })).toEqual({
      path: 'goal',
      problem: '`goal` is longer than 300 characters.',
      fix: 'Shorten it to at most 300 characters.',
    });
  });

  it('translates maxItems and minItems', () => {
    const many = Array.from({ length: 51 }, () => ({ text: 'Open it.' }));
    expect(only({ ...baseSpec(), steps: many }).fix).toBe('Keep at most 50 items.');
    expect(only({ ...baseSpec(), steps: [] })).toEqual({
      path: 'steps',
      problem: '`steps` has fewer than 1 item.',
      fix: 'Provide at least 1 item, or omit the field when it is optional.',
    });
  });

  it('translates maxProperties', () => {
    const values: Record<string, string> = {};
    for (let i = 0; i <= 50; i += 1) values[`value_${String(i)}`] = 'v';
    expect(only({ ...baseSpec(), values })).toEqual({
      path: 'values',
      problem: '`values` has more than 50 keys.',
      fix: 'Keep at most 50 keys.',
    });
  });

  it('translates a bad key of values into one problem naming the key rule', () => {
    expect(only({ ...baseSpec(), values: { '9events': 'v' } })).toEqual({
      path: 'values',
      problem: '`9events` is not a valid key of values.',
      fix: 'Rename the key: it must match the pattern ^[A-Za-z_][A-Za-z0-9_.-]{0,63}$.',
    });
  });

  it('translates a bad key of secrets with the length rule', () => {
    const spec = { ...baseSpec(), secrets: { [str(129)]: '.env' } };
    expect(only(spec).fix).toBe('Rename the key: it must be 1 to 128 characters long.');
  });

  it('translates a pattern that is not the URL one', () => {
    expect(only({ ...baseSpec(), lang: 'English' })).toEqual({
      path: 'lang',
      problem: '`lang` does not have the expected shape.',
      fix: 'It must match the pattern ^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$.',
    });
  });

  it('translates a step that is a string (SPEC-03)', () => {
    expect(only({ ...baseSpec(), steps: ['Open the dashboard.'] })).toEqual({
      path: 'steps[0]',
      problem: '`steps[0]` must be an object.',
      fix: 'A step is an object with these fields: text, url, values, warning.',
    });
  });

  it('translates const on spec_version', () => {
    expect(only({ ...baseSpec(), spec_version: 0 })).toEqual({
      path: 'spec_version',
      problem: '`spec_version` must be 1.',
      fix: 'Set spec_version to 1.',
    });
  });
});

describe('the ajv error groups that describe one mistake', () => {
  it('keeps one problem when neither branch of a value matches', () => {
    expect(only({ ...baseSpec(), values: { retries: 3 } })).toEqual({
      path: 'values.retries',
      problem: '`values.retries` does not have one of the allowed shapes.',
      fix: 'A value is a string, or a list of strings.',
    });
  });

  it('reports the list branch when the value is a list', () => {
    expect(only({ ...baseSpec(), values: { events: [str(4097)] } })).toEqual({
      path: 'values.events[0]',
      problem: '`values.events[0]` is longer than 4096 characters.',
      fix: 'Shorten it to at most 4096 characters.',
    });
  });

  it('reports the string branch when the value is a string', () => {
    expect(only({ ...baseSpec(), values: { endpoint_url: str(4097) } }).path).toBe(
      'values.endpoint_url',
    );
  });

  it('keeps the branches apart when two different values fail', () => {
    const spec = { ...baseSpec(), values: { endpoint_url: str(4097), events: [str(4097)] } };
    expect(problemsOf(spec).map((problem) => problem.path)).toEqual([
      'values.endpoint_url',
      'values.events[0]',
    ]);
  });

  it('reports a bad scheme once, although the schema and S5 both see it', () => {
    expect(only({ ...baseSpec(), url: 'ftp://x.test' }).path).toBe('url');
  });

  it('reports a control field once, although the schema and S2 both see it', () => {
    expect(only({ ...baseSpec(), reply: 'yes' }).path).toBe('reply');
  });
});

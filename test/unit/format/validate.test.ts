/**
 * The pipeline itself (TECHNICAL-DESIGN §5.4): what runs before what, and the promise that
 * everything wrong with a spec comes back in one answer.
 */
import { describe, expect, it } from 'vitest';

import { validateReplacementSteps, validateSpec, type Problem } from '../../../src/format';

function baseSpec(): Record<string, unknown> {
  return {
    spec_version: 1,
    goal: 'Register the Stripe webhook for payment events',
    where: 'Stripe Dashboard → Developers → Webhooks',
    why_human: 'Requires access to the production Stripe account.',
    values: { endpoint_url: 'https://example.com/hooks' },
    steps: [{ text: 'Click Add destination and paste the endpoint URL.' }],
  };
}

function problemsOf(spec: unknown): readonly Problem[] {
  const result = validateSpec(spec);
  return result.ok ? [] : result.error.problems;
}

describe('validateSpec', () => {
  it.each([[null], [42], ['{}'], [[]]])('refuses %j, which is not an object', (input) => {
    const result = validateSpec(input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('SPEC_INVALID');
    expect(result.error.problems).toEqual([
      {
        path: '',
        problem: 'The spec is not a JSON object.',
        fix: 'Send a JSON object carrying at least spec_version, goal, where, why_human, values, steps.',
      },
    ]);
  });

  it('returns three problems for three mistakes, in one answer', () => {
    const spec = baseSpec();
    spec['where'] = '   ';
    spec['url'] = 'ftp://dashboard.stripe.com';
    spec['steps'] = [{ text: 'Paste {{endpoint_url}} in the field.', values: ['nope'] }];
    const problems = problemsOf(spec);
    // What the schema saw first, then the rules, each walking the document in field order.
    expect(problems.map((problem) => problem.path)).toEqual([
      'url',
      'where',
      'steps[0].text',
      'steps[0].values[0]',
    ]);
    expect(new Set(problems.map((problem) => problem.fix)).size).toBe(4);
  });

  it('reports schema and semantic problems of one field together', () => {
    const spec = { ...baseSpec(), goal: `${'x'.repeat(300)} {{name}}` };
    expect(problemsOf(spec).map((problem) => problem.problem)).toEqual([
      '`goal` is longer than 300 characters.',
      'A runbook placeholder was never replaced.',
    ]);
  });

  it('hands the spec on unchanged, the same object it was given (DET-04)', () => {
    const spec = baseSpec();
    const result = validateSpec(spec);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec).toBe(spec);
    expect(result.spec.values['endpoint_url']).toBe('https://example.com/hooks');
  });

  it('accepts a spec whose values are empty of keys', () => {
    expect(validateSpec({ ...baseSpec(), values: {}, steps: [{ text: 'Open it.' }] }).ok).toBe(
      true,
    );
  });
});

describe('validateReplacementSteps', () => {
  it('accepts steps that cite the value keys of the handoff', () => {
    const steps = [{ text: 'Paste the URL again.', values: ['endpoint_url'] }];
    const result = validateReplacementSteps(steps, ['endpoint_url']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.steps).toBe(steps);
  });

  it('reports the paths where the agent sent them', () => {
    const steps = [{ text: 'Open {{url}}.', url: 'ftp://x.test', values: ['nope'] }];
    const result = validateReplacementSteps(steps, ['endpoint_url']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('SPEC_INVALID');
    expect(result.error.problems.map((problem) => problem.path)).toEqual([
      'replacement_steps[0].url',
      'replacement_steps[0].text',
      'replacement_steps[0].values[0]',
    ]);
    expect(result.error.problems[2]?.fix).toContain(
      'in replacement_steps[0].values; declare it in `values`',
    );
  });

  it('holds replacement steps to the schema of the steps they replace', () => {
    const tooMany = Array.from({ length: 51 }, () => ({ text: 'Open it.' }));
    const result = validateReplacementSteps(tooMany, []);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.problems).toEqual([
      {
        path: 'replacement_steps',
        problem: '`replacement_steps` has more than 50 items.',
        fix: 'Keep at most 50 items.',
      },
    ]);
  });

  it('names the fields of a step when one carries an unknown one', () => {
    const result = validateReplacementSteps([{ text: 'Open it.', expected_result: 'ok' }], []);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.problems).toEqual([
      {
        path: 'replacement_steps[0].expected_result',
        problem: '`expected_result` is not a field of the format.',
        fix: 'Unknown field `expected_result` at `replacement_steps[0]`. Allowed fields: text, url, values, warning.',
      },
    ]);
  });

  it('refuses something that is not a list of steps', () => {
    const result = validateReplacementSteps('do it again', []);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.problems).toEqual([
      {
        path: 'replacement_steps',
        problem: '`replacement_steps` must be of type array.',
        fix: 'Send a value of type array.',
      },
    ]);
  });
});

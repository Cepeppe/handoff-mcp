/**
 * One test per semantic rule, on the exact texts of TECHNICAL-DESIGN §4.2.
 *
 * The `fix` of a problem is the sentence the design's rule table prints; the tests below
 * spell it out in full rather than matching a fragment, because a text an agent reads is a
 * contract and a silent reword is exactly what this suite exists to catch.
 */
import { describe, expect, it } from 'vitest';

import { CONTROL_FIELDS, validateSpec, type Problem } from '../../../src/format';
import { TOOL_INPUT_SCHEMAS } from '../../../src/mcp/generated/contract';

/** A spec that passes every rule, as the base every case below breaks in one place. */
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

function only(spec: unknown): Problem {
  const problems = problemsOf(spec);
  expect(problems).toHaveLength(1);
  return problems[0] as Problem;
}

describe('S1, the version check that runs before the schema', () => {
  it('answers a newer spec with the update instruction and nothing else', () => {
    const result = validateSpec({ ...baseSpec(), spec_version: 2, goal: '' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('SPEC_VERSION_UNSUPPORTED');
    expect(result.error.message).toBe('This server does not support that spec_version.');
    // The empty goal is not reported: a spec from the future is answered with one thing to
    // do, not with a list of fields this version happens not to know (§5.4).
    expect(result.error.problems).toEqual([
      {
        path: 'spec_version',
        problem: 'This server supports spec_version ≤ 1.',
        fix: 'Update the server or lower spec_version.',
      },
    ]);
  });

  it('spells the fix text of the design when problem and fix are read together', () => {
    const problem = only({ ...baseSpec(), spec_version: 9 });
    expect(`${problem.problem} ${problem.fix}`).toBe(
      'This server supports spec_version ≤ 1. Update the server or lower spec_version.',
    );
  });

  it('leaves an older or equal version to the schema', () => {
    expect(validateSpec({ ...baseSpec(), spec_version: 1 }).ok).toBe(true);
    expect(only({ ...baseSpec(), spec_version: 0 }).fix).toBe('Set spec_version to 1.');
  });
});

describe('S2, control fields inside the spec', () => {
  it.each(CONTROL_FIELDS)('rejects %s with the text of the design', (field) => {
    const problem = only({ ...baseSpec(), [field]: 'x' });
    expect(problem).toEqual({
      path: field,
      problem: `\`${field}\` is a control field of the tool input, not a field of the spec.`,
      fix: 'Control fields belong outside `spec`, at the top level of the tool input.',
    });
  });

  it('lists exactly the fields the tool input carries around the spec (TOOL-02)', () => {
    const schema = TOOL_INPUT_SCHEMAS.handoff_to_user as { properties: Record<string, unknown> };
    const around = Object.keys(schema.properties).filter((name) => name !== 'spec');
    expect([...CONTROL_FIELDS].sort()).toEqual(around.sort());
  });
});

describe('S3, value keys a step cites without declaring', () => {
  it('names the key, the list it was cited in and the keys that do exist', () => {
    const spec = baseSpec();
    spec['values'] = { endpoint_url: 'https://example.com/hooks', events: ['a'] };
    spec['steps'] = [{ text: 'Paste the URL.', values: ['endpoint_url', 'secret_token'] }];
    expect(only(spec)).toEqual({
      path: 'steps[0].values[1]',
      problem: '`secret_token` is not a key of values.',
      fix: 'Unknown value key `secret_token` in steps[0].values; declare it in `values` or remove it. Known keys: endpoint_url, events.',
    });
  });

  it('says so when the spec declares no values at all', () => {
    const spec = { ...baseSpec(), values: {}, steps: [{ text: 'Paste it.', values: ['nope'] }] };
    expect(only(spec).fix).toContain('Known keys: (none).');
  });
});

describe('S4, placeholders left from a runbook', () => {
  it.each([
    ['goal', (s: Record<string, unknown>) => (s['goal'] = 'Register {{service}} webhooks')],
    ['where', (s: Record<string, unknown>) => (s['where'] = '{{service}} → Webhooks')],
    ['why_human', (s: Record<string, unknown>) => (s['why_human'] = 'Only {{service}} knows.')],
    ['verify', (s: Record<string, unknown>) => (s['verify'] = 'curl {{service}}')],
    [
      'steps[0].text',
      (s: Record<string, unknown>) => (s['steps'] = [{ text: 'Open {{service}}' }]),
    ],
    [
      'steps[0].warning',
      (s: Record<string, unknown>) =>
        (s['steps'] = [{ text: 'Open it.', warning: 'Deletes {{service}}' }]),
    ],
    [
      'values.endpoint_url',
      (s: Record<string, unknown>) => (s['values'] = { endpoint_url: '{{service}}' }),
    ],
    [
      'values.events[1]',
      (s: Record<string, unknown>) => (s['values'] = { events: ['a', '{{service}}'] }),
    ],
  ])('rejects one in %s', (path, break_) => {
    const spec = baseSpec();
    break_(spec);
    expect(only(spec)).toEqual({
      path,
      problem: 'A runbook placeholder was never replaced.',
      fix: `Placeholder \`{{service}}\` found in ${path}. Placeholders exist only in runbooks; replace it with the real value or move it to \`values\`.`,
    });
  });

  it('does not echo a placeholder whose name is not a value name', () => {
    const problem = only({ ...baseSpec(), verify: 'curl {{ sk_live_0123456789abcdef }}' });
    expect(problem.fix).toBe(
      'Placeholder `{{…}}` found in verify. Placeholders exist only in runbooks; replace it with the real value or move it to `values`.',
    );
  });

  it('reports every placeholder of a text, not just the first', () => {
    const spec = { ...baseSpec(), verify: 'curl {{host}}/{{path}}' };
    expect(problemsOf(spec).map((problem) => problem.fix.slice(0, 32))).toEqual([
      'Placeholder `{{host}}` found in ',
      'Placeholder `{{path}}` found in ',
    ]);
  });
});

describe('S5, URL schemes outside the closed list', () => {
  it.each([
    ['url', (s: Record<string, unknown>) => (s['url'] = 'ftp://dashboard.stripe.com')],
    [
      'steps[0].url',
      (s: Record<string, unknown>) => (s['steps'] = [{ text: 'Open it.', url: 'ftp://x.test' }]),
    ],
  ])('rejects %s with the text of the design', (path, break_) => {
    const spec = baseSpec();
    break_(spec);
    expect(only(spec)).toEqual({
      path,
      problem: `\`${path}\` uses a scheme outside the closed list.`,
      fix: 'Scheme `ftp` is not allowed. Allowed: http, https, ms-settings:, x-apple.systempreferences:. Show other links as plain text in the step.',
    });
  });

  it('says so when there is no scheme at all', () => {
    const problem = only({ ...baseSpec(), url: 'dashboard.stripe.com/webhooks' });
    expect(problem.problem).toBe('`url` has no scheme.');
    expect(problem.fix).toBe(
      'No scheme found. Allowed: http, https, ms-settings:, x-apple.systempreferences:. Show other links as plain text in the step.',
    );
  });

  it.each([
    'https://x.test',
    'http://x.test',
    'ms-settings:privacy',
    'x-apple.systempreferences:x',
  ])('accepts %s', (url) => {
    expect(validateSpec({ ...baseSpec(), url }).ok).toBe(true);
  });
});

describe('S6, strings that are empty once trimmed', () => {
  it.each([
    ['goal', (s: Record<string, unknown>) => (s['goal'] = ' \t ')],
    ['where', (s: Record<string, unknown>) => (s['where'] = '   ')],
    ['why_human', (s: Record<string, unknown>) => (s['why_human'] = '   ')],
    ['verify', (s: Record<string, unknown>) => (s['verify'] = '   ')],
    ['steps[0].text', (s: Record<string, unknown>) => (s['steps'] = [{ text: '   ' }])],
    [
      'steps[0].warning',
      (s: Record<string, unknown>) => (s['steps'] = [{ text: 'Open it.', warning: '   ' }]),
    ],
    ['values.endpoint_url', (s: Record<string, unknown>) => (s['values'] = { endpoint_url: '  ' })],
    ['values.events[0]', (s: Record<string, unknown>) => (s['values'] = { events: ['  '] })],
    [
      'secrets.STRIPE_SECRET',
      (s: Record<string, unknown>) => (s['secrets'] = { STRIPE_SECRET: ' ' }),
    ],
  ])('rejects %s with the text of the design', (path, break_) => {
    const spec = baseSpec();
    break_(spec);
    expect(only(spec)).toEqual({
      path,
      problem: `\`${path}\` is empty after trimming.`,
      fix: `Field ${path} is empty.`,
    });
  });

  it('reports an empty string once, although the schema rejects it too', () => {
    // `minLength: 1` and S6 describe the same mistake; the pipeline keeps one problem.
    expect(only({ ...baseSpec(), goal: '' })).toEqual({
      path: 'goal',
      problem: '`goal` is empty after trimming.',
      fix: 'Field goal is empty.',
    });
  });

  it('accepts a value that is empty only in a draft spec derived from a runbook', () => {
    // The schema allows "" in values on purpose (schemas/README.md); S6 is what rejects it,
    // which is what makes a draft spec invalid until the agent fills it.
    const problem = only({ ...baseSpec(), values: { endpoint_url: '' } });
    expect(problem.path).toBe('values.endpoint_url');
  });
});

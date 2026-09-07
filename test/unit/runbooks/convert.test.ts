/**
 * Conversion of a runbook to a draft spec (TECHNICAL-DESIGN §4.5.4, DD-19).
 *
 * The contract test pins the whole item against the published example; these assert the
 * rules that make it, and above all the one the design cares about most: the draft is
 * **invalid on purpose**. That is checked against the real pipeline of T-013, not against a
 * restatement of it, so a future change to S6 cannot quietly make placeholder-shaped drafts
 * acceptable.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { validateSpec } from '../../../src/format';
import { convertRunbook, toRunbookMatch, type Runbook } from '../../../src/runbooks';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

function runbook(name: string, overrides: Record<string, unknown> = {}): Runbook {
  const base = JSON.parse(
    readFileSync(join(ROOT, 'fixtures', 'runbooks', 'valid', name), 'utf8'),
  ) as Record<string, unknown>;
  return { ...base, ...overrides } as unknown as Runbook;
}

const stripe = runbook('stripe-webhook.json');
const minimal = runbook('minimal-confirmed-by-user.json');
const twoRounds = runbook('two-rounds-with-annotations.json');

describe('the draft is invalid until the agent fills it (§4.5.4)', () => {
  it('fails S6 on every empty value, and on nothing else', () => {
    const { draft_spec } = convertRunbook(stripe);
    const result = validateSpec(draft_spec);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe('SPEC_INVALID');
    expect(!result.ok && result.error.problems).toEqual([
      {
        path: 'values.endpoint_url',
        problem: '`values.endpoint_url` is empty after trimming.',
        fix: 'Field values.endpoint_url is empty.',
      },
      {
        path: 'values.events',
        problem: '`values.events` is empty after trimming.',
        fix: 'Field values.events is empty.',
      },
    ]);
  });

  it('becomes valid as soon as the values carry something', () => {
    const { draft_spec } = convertRunbook(stripe);
    const filled = {
      ...draft_spec,
      values: { endpoint_url: 'https://example.test/webhooks/stripe', events: ['invoice.paid'] },
    };
    expect(validateSpec(filled).ok).toBe(true);
  });

  it('is valid straight away when the runbook declares no value at all', () => {
    expect(validateSpec(convertRunbook(minimal).draft_spec).ok).toBe(true);
  });
});

describe('placeholders (DD-19)', () => {
  it('turns {{name}} into [name] in step texts, warnings and verify', () => {
    const converted = convertRunbook(
      runbook('stripe-webhook.json', {
        verify: 'Send a test event to {{endpoint_url}} and check the signature.',
        steps: [
          {
            text: 'Paste {{endpoint_url}} into the field.',
            url: null,
            values: ['endpoint_url'],
            warning: 'Do not reuse {{endpoint_url}} for the test mode.',
            annotations: [],
          },
        ],
      }),
    );

    expect(converted.draft_spec.steps[0]?.text).toBe('Paste [endpoint_url] into the field.');
    expect(converted.draft_spec.steps[0]?.warning).toBe(
      'Do not reuse [endpoint_url] for the test mode.',
    );
    expect(converted.draft_spec.verify).toBe(
      'Send a test event to [endpoint_url] and check the signature.',
    );
  });

  it('adds every name it found to that step, in order, once', () => {
    const converted = convertRunbook(
      runbook('stripe-webhook.json', {
        steps: [
          {
            text: 'Paste {{events}} then {{endpoint_url}} then {{events}} again.',
            url: null,
            values: [],
            warning: null,
            annotations: [],
          },
        ],
      }),
    );
    expect(converted.draft_spec.steps[0]?.values).toEqual(['events', 'endpoint_url']);
  });

  it('omits values on a step that has no placeholder (the spec schema forbids an empty list)', () => {
    const steps = convertRunbook(stripe).draft_spec.steps;
    expect(steps[0]).toHaveProperty('values');
    expect(steps[2]).not.toHaveProperty('values');
    expect(Object.keys(steps[2] ?? {})).toEqual(['text']);
  });

  it('declares a placeholder the runbook forgot, so the draft never cites an unknown key', () => {
    const converted = convertRunbook(
      runbook('minimal-confirmed-by-user.json', {
        steps: [
          {
            text: 'Type {{account_id}} into the box.',
            url: null,
            values: [],
            warning: null,
            annotations: [],
          },
        ],
      }),
    );
    expect(converted.draft_spec.values).toEqual({ account_id: '' });
    expect(converted.values_to_fill).toEqual({ account_id: null });
    // S3 would have fired if `account_id` had been cited without being declared.
    const problems = validateSpec(converted.draft_spec);
    expect(!problems.ok && problems.error.problems.map((one) => one.path)).toEqual([
      'values.account_id',
    ]);
  });

  it('leaves a {{…}} that is not a value name exactly where it is', () => {
    const converted = convertRunbook(
      runbook('minimal-confirmed-by-user.json', {
        steps: [
          {
            text: 'Read {{ the terms }} and press Accept.',
            url: null,
            values: [],
            warning: null,
            annotations: [],
          },
        ],
      }),
    );
    expect(converted.draft_spec.steps[0]?.text).toBe('Read {{ the terms }} and press Accept.');
    expect(converted.draft_spec.values).toEqual({});
    // Which is exactly what S4 is there to report.
    const result = validateSpec(converted.draft_spec);
    expect(!result.ok && result.error.problems[0]?.problem).toBe(
      'A runbook placeholder was never replaced.',
    );
  });
});

describe('the fields the draft copies', () => {
  it('omits a null runbook field instead of sending it as null', () => {
    const draft = convertRunbook(minimal).draft_spec;
    expect(Object.keys(draft)).toEqual([
      'spec_version',
      'goal',
      'where',
      'why_human',
      'values',
      'steps',
    ]);
    expect(draft.spec_version).toBe(1);
  });

  it('keeps url, secrets, verify and lang when the runbook has them, in schema order', () => {
    expect(Object.keys(convertRunbook(stripe).draft_spec)).toEqual([
      'spec_version',
      'goal',
      'where',
      'url',
      'why_human',
      'values',
      'secrets',
      'steps',
      'verify',
      'lang',
    ]);
  });

  it('copies a step url and warning, and drops the runbook-only fields', () => {
    const step = convertRunbook(twoRounds).draft_spec.steps[1];
    expect(step).toEqual({
      text: 'Restart every machine from the machines page, one at a time.',
      url: 'https://fly.io/apps/myapp/machines',
      warning: 'Restarting drops in-flight jobs; do it outside business hours.',
    });
  });
});

describe('values_to_fill and annotations', () => {
  it('carries the description of each value, and null for a value in no step (RUN-04)', () => {
    expect(convertRunbook(twoRounds).values_to_fill).toEqual({
      app: 'Open the secrets page of {{app}} and delete DEPLOY_KEY.',
      region: null,
    });
  });

  it('keeps a value that appears in no step in the draft as well', () => {
    expect(convertRunbook(twoRounds).draft_spec.values).toEqual({ app: '', region: '' });
  });

  it('flattens the annotations of every step, in step order and in their own order', () => {
    expect(convertRunbook(twoRounds).annotations.map((one) => [one.kind, one.round])).toEqual([
      ['question', 1],
      ['reply', 1],
      ['error', 1],
      ['correction', 2],
      ['note', 2],
    ]);
  });

  it('leaves the placeholder in the description: it names the value, it is not filled here', () => {
    expect(convertRunbook(stripe).values_to_fill['events']).toBe('Select the events {{events}}.');
  });
});

describe('toRunbookMatch', () => {
  it('reports the path it was read from and the words that matched', () => {
    const item = toRunbookMatch({ path: '/home/me/.handoff/runbooks/a.json', runbook: stripe }, [
      'stripe',
    ]);
    expect(item.path).toBe('/home/me/.handoff/runbooks/a.json');
    expect(item.matched_words).toEqual(['stripe']);
    expect(item.trust).toBe('verified');
    expect(item.runs).toBe(1);
    expect(item.last_run_failed_at).toBeNull();
  });
});

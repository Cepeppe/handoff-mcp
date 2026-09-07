/**
 * The certain detector at ingress (TECHNICAL-DESIGN §5.5, SPEC-13, DET-04).
 *
 * Two properties matter more than any single location: the spec the caller holds is never
 * modified, and the matched text never comes back out. Both are asserted below on a spec
 * built from the synthetic values of `fixtures/secrets/positive.txt`, so a pattern change
 * and these tests cannot drift apart.
 */
import { describe, expect, it } from 'vitest';

import {
  maskSpecForText,
  scanSpec,
  scanSpecSpans,
  secretMask,
  type SecretTreated,
} from '../../../src/secrets';
import { validateSpec } from '../../../src/format';
import type { HandoffSpec } from '../../../src/format';

/** Synthetic, from the positive corpus; no value here has ever been valid anywhere. */
const STRIPE_KEY = 'sk_live_513WuSPGwLhT803pb64yO8gC';
const WEBHOOK_SECRET = 'whsec_xrPTzwSQHXrIMDirUBSZFL5wZW9O7jbi';
const GITHUB_TOKEN = 'ghp_ejBSdFv2HGHJZuxe1LkQ5IOCvYbK5hh79tns';
const SLACK_WEBHOOK_URL =
  'https://hooks.slack.com/services/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';

/** A spec with no secret in it, as the base every case below plants one in. */
function baseSpec(): Record<string, unknown> {
  return {
    spec_version: 1,
    goal: 'Register the Stripe webhook for payment events',
    where: 'Stripe Dashboard → Developers → Webhooks',
    why_human: 'Requires access to the production Stripe account.',
    values: { endpoint_url: 'https://api.myapp.example/webhooks/stripe' },
    // No step cites a value key: a case that replaces `values` must stay valid (S3).
    steps: [{ text: 'Click Add endpoint and paste the endpoint URL.' }],
  };
}

/**
 * Validates first, so every case runs on a spec the pipeline would have accepted: the
 * detector never sees anything else (§5.4 order, S7 last).
 */
function specOf(overrides: Record<string, unknown>): HandoffSpec {
  const result = validateSpec({ ...baseSpec(), ...overrides });
  if (!result.ok) throw new Error(`fixture spec is invalid: ${JSON.stringify(result.error)}`);
  return result.spec;
}

function scan(overrides: Record<string, unknown>): SecretTreated[] {
  return scanSpec(specOf(overrides));
}

describe('scanSpec locations', () => {
  it('reports a Stripe key in a value under its key, as the family and not the pattern id', () => {
    expect(scan({ values: { api_key: STRIPE_KEY } })).toEqual([
      { location: 'values.api_key', kind: 'api_key' },
    ]);
  });

  it('indexes an array value, so the location names the item that matched', () => {
    expect(
      scan({ values: { tokens: ['staging-mailer', GITHUB_TOKEN, 'production-mailer'] } }),
    ).toEqual([{ location: 'values.tokens[1]', kind: 'token' }]);
  });

  it('scans every field §5.5 names, and none of the others', () => {
    const spec = {
      goal: `Rotate ${STRIPE_KEY} in production`,
      where: `Vault at ${WEBHOOK_SECRET}`,
      why_human: `Only the owner may read ${GITHUB_TOKEN}.`,
      url: SLACK_WEBHOOK_URL,
      values: { note: `old key ${STRIPE_KEY}` },
      secrets: { [WEBHOOK_SECRET]: '.env' },
      steps: [
        { text: `Paste ${STRIPE_KEY} into the field.`, url: SLACK_WEBHOOK_URL },
        { text: 'Save the endpoint.', warning: `Never share ${WEBHOOK_SECRET}.` },
      ],
      verify: `Check that ${GITHUB_TOKEN} no longer works.`,
    };
    expect(scan(spec)).toEqual([
      { location: 'values.note', kind: 'api_key' },
      { location: 'goal', kind: 'api_key' },
      { location: 'where', kind: 'webhook_secret' },
      { location: 'why_human', kind: 'token' },
      { location: 'verify', kind: 'token' },
      { location: 'steps[0].text', kind: 'api_key' },
      { location: 'steps[1].warning', kind: 'webhook_secret' },
    ]);
  });

  it('reports every hit of a string, not only the first', () => {
    expect(scan({ values: { pair: `${STRIPE_KEY} and ${WEBHOOK_SECRET}` } })).toEqual([
      { location: 'values.pair', kind: 'api_key' },
      { location: 'values.pair', kind: 'webhook_secret' },
    ]);
  });

  it('reports nothing for a spec that carries no secret', () => {
    expect(scan({})).toEqual([]);
  });

  it('never returns the matched text', () => {
    const spec = specOf({ values: { api_key: STRIPE_KEY }, goal: `Rotate ${GITHUB_TOKEN}` });
    const reported = JSON.stringify(scanSpecSpans(spec));
    expect(reported).not.toContain(STRIPE_KEY);
    expect(reported).not.toContain(GITHUB_TOKEN);
  });
});

describe('maskSpecForText', () => {
  it('replaces a value that is a secret with the mask of its family', () => {
    const spec = specOf({ values: { api_key: STRIPE_KEY } });
    const masked = maskSpecForText(spec, scanSpecSpans(spec));
    expect(masked.values['api_key']).toBe('[treated as secret: api_key]');
    expect(secretMask('api_key')).toBe('[treated as secret: api_key]');
  });

  it('replaces only the matched span, so a step keeps its instruction', () => {
    const spec = specOf({
      steps: [{ text: `Paste ${STRIPE_KEY} into .env as STRIPE_SECRET_KEY.` }],
    });
    const masked = maskSpecForText(spec, scanSpecSpans(spec));
    expect(masked.steps[0]?.text).toBe(
      'Paste [treated as secret: api_key] into .env as STRIPE_SECRET_KEY.',
    );
  });

  it('masks two hits of the same string, and an item of an array value', () => {
    const spec = specOf({
      values: { pair: `${STRIPE_KEY} then ${WEBHOOK_SECRET}`, tokens: ['ok', GITHUB_TOKEN] },
    });
    const masked = maskSpecForText(spec, scanSpecSpans(spec));
    expect(masked.values['pair']).toBe(
      '[treated as secret: api_key] then [treated as secret: webhook_secret]',
    );
    expect(masked.values['tokens']).toEqual(['ok', '[treated as secret: token]']);
  });

  it('masks goal, where, why_human, verify and a warning', () => {
    const spec = specOf({
      goal: `Rotate ${STRIPE_KEY}`,
      where: `Vault ${WEBHOOK_SECRET}`,
      why_human: `Owner only: ${GITHUB_TOKEN}`,
      steps: [{ text: 'Save.', warning: `Never share ${WEBHOOK_SECRET}.` }],
      verify: `Check ${GITHUB_TOKEN}`,
    });
    const masked = maskSpecForText(spec, scanSpecSpans(spec));
    expect(masked.goal).toBe('Rotate [treated as secret: api_key]');
    expect(masked.where).toBe('Vault [treated as secret: webhook_secret]');
    expect(masked.why_human).toBe('Owner only: [treated as secret: token]');
    expect(masked.steps[0]?.warning).toBe('Never share [treated as secret: webhook_secret].');
    expect(masked.verify).toBe('Check [treated as secret: token]');
  });

  it('leaves the spec that travels on untouched, so the copy button copies the true value', () => {
    const spec = specOf({ values: { api_key: STRIPE_KEY } });
    const before = structuredClone(spec);
    const masked = maskSpecForText(spec, scanSpecSpans(spec));
    expect(spec).toEqual(before);
    expect(spec.values['api_key']).toBe(STRIPE_KEY);
    expect(masked).not.toBe(spec);
  });

  it('returns an equal copy when there is nothing to mask', () => {
    const spec = specOf({});
    expect(maskSpecForText(spec, scanSpecSpans(spec))).toEqual(spec);
  });
});

/**
 * "Errors never include spec values" (TECHNICAL-DESIGN §4.7.5, R-19).
 *
 * A spec value may have been treated as a secret, and an error travels to the agent and
 * into the log. So the pipeline is fed a spec whose every text is a unique sentinel and
 * whose every field is wrong in some way, and the whole rendered error is searched for
 * those sentinels.
 *
 * What an error *does* carry, by design and by the texts of §4.2: field names, keys of
 * `values` and `secrets`, a placeholder name that looks like a value name, and the scheme
 * of a rejected URL. None of those is a value, and each one is what makes the fix
 * actionable. The sentinels below are therefore only in the contents of the fields.
 */
import { describe, expect, it } from 'vitest';

import { errorJson, validateSpec } from '../../../src/format';

/** Contents of the spec. None of these may come back in an error. */
const SENTINELS = {
  goal: 'ZQXVAL-GOAL-01',
  where: 'ZQXVAL-WHERE-02',
  url: 'ZQXVAL-URL-03',
  whyHuman: 'ZQXVAL-WHY-04',
  value: 'ZQXVAL-VALUE-05',
  item: 'ZQXVAL-ITEM-06',
  secretDestination: 'ZQXVAL-DEST-07',
  text: 'ZQXVAL-TEXT-08',
  warning: 'ZQXVAL-WARN-09',
  stepUrl: 'ZQXVAL-STEPURL-10',
  verify: 'ZQXVAL-VERIFY-11',
  lang: 'ZQXVAL-LANG-12',
  unknownField: 'ZQXVAL-NOTES-13',
  apiKey: 'sk_live_ZQXVAL0123456789abcdef',
} as const;

/** Every field wrong, every text a sentinel. */
function sentinelSpec(): Record<string, unknown> {
  return {
    spec_version: 1,
    goal: `${SENTINELS.goal} `.repeat(40),
    where: `${SENTINELS.where} {{name}}`,
    url: `ftp://${SENTINELS.url}.test`,
    why_human: `${SENTINELS.whyHuman} `.repeat(100),
    values: {
      endpoint_url: `${SENTINELS.value} `.repeat(400),
      events: [`${SENTINELS.item} {{name}}`],
      api_key: SENTINELS.apiKey,
      retries: 3,
    },
    secrets: { STRIPE_WEBHOOK_SECRET: `${SENTINELS.secretDestination} `.repeat(200) },
    steps: [
      {
        text: `${SENTINELS.text} `.repeat(200),
        url: `ftp://${SENTINELS.stepUrl}.test`,
        values: ['undeclared_key'],
        warning: `${SENTINELS.warning} {{name}}`,
      },
    ],
    verify: `${SENTINELS.verify} {{name}}`,
    lang: SENTINELS.lang,
    notes: SENTINELS.unknownField,
  };
}

describe('an error never carries a value of the spec', () => {
  const result = validateSpec(sentinelSpec());
  const rendered = result.ok ? '' : errorJson(result.error);

  it('rejects the spec on many counts, so the search below has something to search', () => {
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.problems.length).toBeGreaterThanOrEqual(10);
  });

  it.each(Object.entries(SENTINELS))('never echoes the %s of the spec', (_name, sentinel) => {
    expect(rendered).not.toContain(sentinel);
  });

  it('still names the field, the keys and the scheme, which is what makes it actionable', () => {
    expect(rendered).toContain('values.endpoint_url');
    expect(rendered).toContain('undeclared_key');
    expect(rendered).toContain('Scheme `ftp` is not allowed.');
    expect(rendered).toContain('STRIPE_WEBHOOK_SECRET');
  });
});

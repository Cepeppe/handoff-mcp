/**
 * The `text_mode` outcome (TECHNICAL-DESIGN §4.3, §5.9, SRV-14..16).
 *
 * Two things are checked against something other than this module: the outcome validates
 * against the published schema, and `fixtures/outcomes/text-mode.json` — the file the app
 * and the Rust side read as the example of this status — is exactly what the factory
 * builds for the Stripe fixture. Nothing else keeps the fixture and the renderer together.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';
import type { AnySchema, ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';

import { validateSpec } from '../../../src/format';
import type { HandoffSpec } from '../../../src/format';
import { INSTRUCTIONS, ID_PLACEHOLDER } from '../../../src/mcp/generated/contract';
import { textModeOutcome } from '../../../src/textmode';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
for (const name of ['handoff-spec', 'handoff-outcome']) {
  ajv.addSchema(readJson(join(ROOT, 'schemas', `${name}.v1.schema.json`)) as AnySchema);
}
const validateOutcome = ajv.getSchema(
  'https://raw.githubusercontent.com/Cepeppe/handoff-mcp/main/schemas/handoff-outcome.v1.schema.json',
) as ValidateFunction;

function fixtureSpec(name: string): HandoffSpec {
  const result = validateSpec(readJson(join(ROOT, 'fixtures/specs/valid', `${name}.json`)));
  if (!result.ok) throw new Error(`fixture ${name} is invalid: ${JSON.stringify(result.error)}`);
  return result.spec;
}

describe('textModeOutcome', () => {
  it('validates against the published outcome schema', () => {
    const outcome = textModeOutcome(fixtureSpec('stripe-webhook'), 'stop_hook');
    expect(validateOutcome(outcome), ajv.errorsText(validateOutcome.errors)).toBe(true);
  });

  it('says there is no handoff and no app: null id, app_reachable false, not final', () => {
    const outcome = textModeOutcome(fixtureSpec('minimal'), 'no_stop_hook');
    expect(outcome.handoff_id).toBeNull();
    expect(outcome.app_reachable).toBe(false);
    expect(outcome.status).toBe('text_mode');
    expect(outcome.final).toBe(false);
  });

  it('carries every field of §4.3, with null or [] where nothing applies', () => {
    // The list is the schema's own `required`, so this asserts §4.3 and not a copy of it.
    const schema = readJson(join(ROOT, 'schemas/handoff-outcome.v1.schema.json')) as {
      required: string[];
    };
    const outcome = textModeOutcome(fixtureSpec('minimal'), 'stop_hook');
    expect(Object.keys(outcome).sort()).toEqual([...schema.required].sort());
    expect(outcome).toMatchObject({
      outcome_version: 1,
      round: 1,
      current_step: null,
      user_text: null,
      screenshot: null,
      context: null,
      skipped_steps: [],
      notes: [],
      verify: null,
      deferral_count: 0,
      resumed_from: null,
      already_delivered: false,
      runbooks: [],
    });
  });

  it('takes the instruction from the generated contract, with nothing left to substitute', () => {
    for (const variant of ['stop_hook', 'no_stop_hook'] as const) {
      const outcome = textModeOutcome(fixtureSpec('minimal'), variant);
      expect(outcome.instruction).toBe(INSTRUCTIONS.text_mode[variant]);
      expect(outcome.instruction).not.toContain(ID_PLACEHOLDER);
    }
  });

  it('reports the treated locations and masks them in spec_text, once for the same scan', () => {
    const key = 'sk_live_513WuSPGwLhT803pb64yO8gC';
    const result = validateSpec({
      spec_version: 1,
      goal: 'Create an API key for the staging environment',
      where: 'Resend Dashboard → API Keys',
      why_human: 'The key is shown once and must never pass through the agent.',
      values: { api_key: key },
      steps: [{ text: 'Copy the key into .env.staging.', values: ['api_key'] }],
    });
    if (!result.ok) throw new Error('spec is invalid');
    const outcome = textModeOutcome(result.spec, 'stop_hook');

    expect(outcome.secret_treated).toEqual([{ location: 'values.api_key', kind: 'api_key' }]);
    expect(outcome.spec_text).toContain('  - api_key: [treated as secret: api_key]');
    expect(outcome.spec_text).not.toContain(key);
    expect(result.spec.values['api_key']).toBe(key);
    expect(validateOutcome(outcome), ajv.errorsText(validateOutcome.errors)).toBe(true);
  });

  it('is exactly what fixtures/outcomes/text-mode.json records', () => {
    const fixture = readJson(join(ROOT, 'fixtures/outcomes/text-mode.json'));
    expect(fixture).toEqual(textModeOutcome(fixtureSpec('stripe-webhook'), 'stop_hook'));
  });
});

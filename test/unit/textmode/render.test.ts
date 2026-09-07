/**
 * The text-mode layout (TECHNICAL-DESIGN §5.9).
 *
 * The snapshots below are read against the block printed in §5.9, not regenerated when
 * they move: this text is what a user sees when the app is not running, and the only thing
 * that may change it is the design. The two specs are the two examples of the design
 * (REQUIREMENTS §4.5 and TECHNICAL-DESIGN §4.2), taken from the fixtures rather than
 * retyped, so that a change to a fixture shows up here.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { validateSpec } from '../../../src/format';
import type { HandoffSpec } from '../../../src/format';
import { maskSpecForText, scanSpecSpans } from '../../../src/secrets';
import { renderSpecText } from '../../../src/textmode';

const SPECS = join(fileURLToPath(new URL('../../../', import.meta.url)), 'fixtures/specs/valid');

function fixture(name: string): HandoffSpec {
  const parsed: unknown = JSON.parse(readFileSync(join(SPECS, `${name}.json`), 'utf8'));
  const result = validateSpec(parsed);
  if (!result.ok) throw new Error(`fixture ${name} is invalid: ${JSON.stringify(result.error)}`);
  return result.spec;
}

function specOf(overrides: Record<string, unknown>): HandoffSpec {
  const result = validateSpec({
    spec_version: 1,
    goal: 'Create an API key for the staging environment',
    where: 'Resend Dashboard → API Keys',
    why_human: 'The key is shown once and must never pass through the agent.',
    values: {},
    steps: [{ text: 'Press Create API Key.' }],
    ...overrides,
  });
  if (!result.ok) throw new Error(`spec is invalid: ${JSON.stringify(result.error)}`);
  return result.spec;
}

/** Masks and renders, the order `textModeOutcome` composes them in. */
function renderMasked(spec: HandoffSpec): string {
  return renderSpecText(maskSpecForText(spec, scanSpecSpans(spec)));
}

describe('renderSpecText, on the two design examples', () => {
  it('renders the Stripe webhook spec: url, array value, secrets and verification', () => {
    expect(renderSpecText(fixture('stripe-webhook'))).toMatchSnapshot();
  });

  it('renders the macOS screen-recording spec: an OS settings url and a step warning', () => {
    expect(renderSpecText(fixture('macos-screen-recording'))).toMatchSnapshot();
  });

  it('renders a spec whose value was treated as a secret', () => {
    const spec = specOf({
      values: { key_name: 'staging-mailer', api_key: 'sk_live_513WuSPGwLhT803pb64yO8gC' },
      steps: [
        { text: 'Press Create API Key and name it staging-mailer.', values: ['key_name'] },
        { text: 'Copy the key into .env.staging.', values: ['api_key'] },
      ],
      secrets: { RESEND_API_KEY: '.env.staging' },
      verify: 'Check that RESEND_API_KEY exists in .env.staging without reading its value.',
    });
    expect(renderMasked(spec)).toMatchSnapshot();
  });
});

describe('renderSpecText, section by section', () => {
  it('puts the target link after the place, in brackets', () => {
    const text = renderSpecText(specOf({ url: 'https://resend.com/api-keys' }));
    expect(text.split('\n')[1]).toBe(
      'Where: Resend Dashboard → API Keys  [https://resend.com/api-keys]',
    );
  });

  it('omits the brackets when the spec has no url', () => {
    expect(renderSpecText(specOf({})).split('\n')[1]).toBe('Where: Resend Dashboard → API Keys');
  });

  it('reads an array value as one line', () => {
    const text = renderSpecText(specOf({ values: { events: ['a.completed', 'b.paid'] } }));
    expect(text).toContain('  - events: a.completed, b.paid');
  });

  it('numbers the steps from one and appends only the segments a step has', () => {
    const text = renderSpecText(
      specOf({
        values: { app: 'myapp' },
        steps: [
          { text: 'Delete the secret DEPLOY_KEY.', values: ['app'] },
          {
            text: 'Restart every worker.',
            url: 'https://fly.io/apps/myapp/machines',
            warning: 'Restarting drops in-flight jobs.',
          },
          { text: 'Check the health endpoint.' },
        ],
      }),
    );
    const lines = text.split('\n');
    expect(lines).toContain('  1. Delete the secret DEPLOY_KEY.   (values: app)');
    expect(lines).toContain(
      '  2. Restart every worker.   [https://fly.io/apps/myapp/machines]   WARNING: Restarting drops in-flight jobs.',
    );
    expect(lines).toContain('  3. Check the health endpoint.');
  });

  it('omits an empty section rather than printing its heading alone', () => {
    const text = renderSpecText(fixture('minimal'));
    expect(text).not.toContain('Values (from the project):');
    expect(text).not.toContain('never paste them in chat');
    expect(text).not.toContain('Verification you must perform afterwards:');
    expect(text).toContain('Steps:');
  });

  it('never lets a certain secret reach the rendered text', () => {
    const key = 'sk_live_513WuSPGwLhT803pb64yO8gC';
    const spec = specOf({
      values: { api_key: key },
      steps: [{ text: `Paste ${key} into .env.staging.` }],
      verify: `Confirm ${key} was rotated.`,
    });
    const text = renderMasked(spec);
    expect(text).not.toContain(key);
    expect(text.match(/\[treated as secret: api_key\]/g)).toHaveLength(3);
  });
});

/**
 * Outcome rendering (TECHNICAL-DESIGN §4.3 MCP mapping, §4.7.4).
 *
 * Three things are pinned here: that `final` and `instruction` come from the published
 * contract and not from whatever handed the outcome over, that `<id>` never survives into
 * an instruction an agent has to follow, and that the image block appears only when the
 * user sent an image and the client can show one.
 */
import { describe, expect, it } from 'vitest';

import { resolveCapabilityRow, type ResolvedCapabilityRow } from '../../../src/adapters';
import { catalogueError } from '../../../src/format';
import {
  ID_PLACEHOLDER,
  INSTRUCTIONS,
  OUTCOME_STATUSES,
  STATUS_FINAL,
  type OutcomeStatus,
} from '../../../src/mcp/generated/contract';
import {
  hookVariant,
  instructionFor,
  renderError,
  renderOutcome,
  renderRunbooks,
  runbookMatchOutcome,
  type Outcome,
} from '../../../src/mcp/outcome';

const ID = 'hf_7k3m9p2q4r';

/** Claude Code: the Stop hook and images. */
const withHook: ResolvedCapabilityRow = resolveCapabilityRow({ agent: 'claude-code' });
/** Codex: neither, and the `unknown` row's defaults for what it does not state. */
const withoutHook: ResolvedCapabilityRow = resolveCapabilityRow({ agent: 'codex' });

/** The statuses that carry no handoff id, so nothing can be substituted into them. */
const WITHOUT_ID: readonly OutcomeStatus[] = ['runbook_match', 'text_mode'];

/** An outcome of the given status, with every field of §4.3 present. */
function outcomeOf(status: OutcomeStatus, over: Partial<Outcome> = {}): Outcome {
  return {
    outcome_version: 1,
    handoff_id: WITHOUT_ID.includes(status) ? null : ID,
    status,
    // Deliberately wrong: the renderer must overwrite both from the contract.
    final: !STATUS_FINAL[status],
    instruction: 'whatever the app said',
    round: 1,
    current_step: null,
    user_text: null,
    screenshot: null,
    context: null,
    skipped_steps: [],
    notes: [],
    secret_treated: [],
    verify: null,
    deferral_count: 0,
    resumed_from: null,
    app_reachable: true,
    already_delivered: false,
    runbooks: [],
    spec_text: null,
    ...over,
  };
}

/** The outcome as the agent receives it: the text block, parsed back. */
function textOf(result: { content: readonly unknown[] }): Outcome {
  const first = result.content[0] as { type: string; text: string };
  expect(first.type).toBe('text');
  return JSON.parse(first.text) as Outcome;
}

describe('the instruction variant', () => {
  it('follows the row, and nothing else', () => {
    expect(hookVariant(withHook)).toBe('stop_hook');
    expect(hookVariant(withoutHook)).toBe('no_stop_hook');
  });

  it('differs for deferred and parked, and only for those two (§4.7.4)', () => {
    const differ = OUTCOME_STATUSES.filter(
      (status) => INSTRUCTIONS[status].stop_hook !== INSTRUCTIONS[status].no_stop_hook,
    );
    expect(differ).toEqual(['deferred', 'parked']);
  });
});

describe('instructionFor', () => {
  it.each(OUTCOME_STATUSES)('leaves no placeholder in %s', (status) => {
    const handoffId = WITHOUT_ID.includes(status) ? null : ID;
    for (const variant of ['stop_hook', 'no_stop_hook'] as const) {
      const text = instructionFor(status, variant, handoffId);
      expect(text).not.toContain(ID_PLACEHOLDER);
      expect(text.length).toBeGreaterThan(0);
    }
  });

  it('substitutes every occurrence, not only the first', () => {
    // The no-hook `parked` text names the id twice.
    const source = INSTRUCTIONS.parked.no_stop_hook;
    expect(source.split(ID_PLACEHOLDER)).toHaveLength(3);
    expect(instructionFor('parked', 'no_stop_hook', ID)).toBe(
      source.replaceAll(ID_PLACEHOLDER, ID),
    );
  });

  it('carries no placeholder to substitute for the two statuses without an id', () => {
    for (const status of WITHOUT_ID) {
      for (const variant of ['stop_hook', 'no_stop_hook'] as const) {
        expect(INSTRUCTIONS[status][variant]).not.toContain(ID_PLACEHOLDER);
      }
    }
  });
});

describe('renderOutcome', () => {
  it.each(OUTCOME_STATUSES)('gives %s the contract final and instruction', (status) => {
    const result = renderOutcome(outcomeOf(status), withHook);
    const rendered = textOf(result);

    expect(rendered.status).toBe(status);
    expect(rendered.final).toBe(STATUS_FINAL[status]);
    expect(rendered.instruction).toBe(
      instructionFor(status, 'stop_hook', WITHOUT_ID.includes(status) ? null : ID),
    );
    expect(rendered.instruction).not.toBe('whatever the app said');
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual(rendered);
  });

  it('picks the hook variant from the row', () => {
    expect(textOf(renderOutcome(outcomeOf('deferred'), withHook)).instruction).toContain(
      'The Stop hook will stop you once if you forget.',
    );
    expect(textOf(renderOutcome(outcomeOf('deferred'), withoutHook)).instruction).toContain(
      'Nothing will remind you',
    );
  });

  it('changes nothing else about the outcome', () => {
    const outcome = outcomeOf('question', {
      current_step: { index: 2, total: 4, text: 'Select the events.' },
      user_text: 'which events?',
      round: 3,
      skipped_steps: [1],
      secret_treated: [{ location: 'values.api_key', kind: 'api_key' }],
      deferral_count: 1,
    });
    const rendered = textOf(renderOutcome(outcome, withHook));
    expect({ ...rendered, final: outcome.final, instruction: outcome.instruction }).toEqual(
      outcome,
    );
  });
});

describe('the image block', () => {
  const image = Buffer.from('a fake png').toString('base64');
  const screenshot = (mode: 'image' | 'text') => ({
    mode,
    text: mode === 'text' ? 'Select events to listen to' : null,
    image_attached: mode === 'image',
    width: 2880,
    height: 1800,
    redactions: 0,
    ocr_engine: mode === 'text' ? 'tesseract' : null,
  });

  it('is attached only when the user sent an image and the client can show one', () => {
    const result = renderOutcome(
      outcomeOf('screenshot', { screenshot: screenshot('image') }),
      withHook,
      image,
    );
    expect(result.content).toHaveLength(2);
    expect(result.content[1]).toEqual({ type: 'image', data: image, mimeType: 'image/png' });
  });

  it.each<[string, ResolvedCapabilityRow, 'image' | 'text', string | undefined]>([
    ['the client cannot show images', withoutHook, 'image', image],
    ['the user sent the extracted text instead', withHook, 'text', image],
    ['no image travelled with the outcome', withHook, 'image', undefined],
  ])('is absent when %s', (_name, row, mode, data) => {
    const result = renderOutcome(
      outcomeOf('screenshot', { screenshot: screenshot(mode) }),
      row,
      data,
    );
    expect(result.content).toHaveLength(1);
  });

  it('is absent from every outcome that carries no screenshot', () => {
    for (const status of OUTCOME_STATUSES) {
      expect(renderOutcome(outcomeOf(status), withHook, image).content).toHaveLength(1);
    }
  });
});

describe('renderError', () => {
  it('is isError, carries the catalogue JSON and declares no structured content', () => {
    const result = renderError(catalogueError('APP_DISCONNECTED'));
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(result.content).toHaveLength(1);

    const payload = JSON.parse((result.content[0] as { text: string }).text) as {
      error: { code: string; problems: { fix: string }[] };
    };
    expect(payload.error.code).toBe('APP_DISCONNECTED');
    expect(payload.error.problems[0]?.fix).toContain('Retry in a few seconds');
  });
});

describe('renderRunbooks', () => {
  it('answers { runbooks: [...] } in both the text block and the structured content', () => {
    const result = renderRunbooks([]);
    expect(result.isError).toBe(false);
    expect((result.content[0] as { text: string }).text).toBe('{"runbooks":[]}');
    expect(result.structuredContent).toEqual({ runbooks: [] });
  });
});

describe('runbookMatchOutcome', () => {
  it('opens no handoff, reports what the detector found and stays app_reachable', () => {
    const treated = [{ location: 'values.api_key', kind: 'api_key' }] as const;
    const outcome = runbookMatchOutcome([], treated, 'stop_hook');
    expect(outcome.handoff_id).toBeNull();
    expect(outcome.status).toBe('runbook_match');
    expect(outcome.final).toBe(false);
    expect(outcome.app_reachable).toBe(true);
    expect(outcome.spec_text).toBeNull();
    expect(outcome.secret_treated).toEqual(treated);
  });
});

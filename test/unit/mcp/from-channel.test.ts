/**
 * Reading an outcome the app sent, and the fix text of a channel that refuses
 * (TECHNICAL-DESIGN §4.3, §6.3, FM-10, FM-11).
 *
 * The published outcome schema is **closed** and every one of its twenty fields is required,
 * while §6.3 says the server tolerates unknown fields in a result. Both at once means: take
 * the app's fields, fill in what it left out, drop what the schema does not know. What is
 * checked here is that the result of that is always a complete outcome, because the tool
 * declares an `outputSchema` and an incomplete one would fail on the agent's side, where
 * there is nothing left to do about it.
 */
import { describe, expect, it } from 'vitest';

import {
  ERROR_TEXTS,
  OUTCOME_STATUSES,
  STATUS_FINAL,
  outcomeFromChannel,
  renderOutcome,
  serverOutcome,
  withChannelFailure,
} from '../../../src/mcp';
import { resolveCapabilityRow, type ResolvedCapabilityRow } from '../../../src/adapters';

/** The real Claude Code row: `images_in_results` and `stop_hook` are true (§5.6). */
const row: ResolvedCapabilityRow = resolveCapabilityRow({ agent: 'claude-code' });

const HANDOFF = 'hf_7k3m9p2q4r';

/** Every field of §4.3, so a test can take one away and see what fills it back in. */
const complete = {
  outcome_version: 1,
  handoff_id: HANDOFF,
  status: 'parked',
  final: true,
  instruction: 'whatever the app wrote here',
  round: 3,
  current_step: { index: 2, total: 4, text: 'Select the events.' },
  user_text: 'the user typed this',
  screenshot: null,
  context: null,
  skipped_steps: [1],
  notes: [{ step: 1, text: 'a note', at: '2026-09-07T10:12:03Z' }],
  secret_treated: [{ location: 'values.api_key', kind: 'api_key' }],
  verify: null,
  deferral_count: 2,
  resumed_from: { agent: 'Claude Code', project: '/dev/shop' },
  app_reachable: true,
  already_delivered: false,
  runbooks: [],
  spec_text: null,
};

describe('outcomeFromChannel', () => {
  it('keeps every field the app sent', () => {
    const outcome = outcomeFromChannel(complete);
    expect(outcome).toMatchObject({
      handoff_id: HANDOFF,
      status: 'parked',
      round: 3,
      user_text: 'the user typed this',
      deferral_count: 2,
      resumed_from: { agent: 'Claude Code', project: '/dev/shop' },
      skipped_steps: [1],
    });
  });

  it('recomputes final from the contract, never from what the app claimed', () => {
    // The app said `final: true` for a `parked`, which §4.3 says is not final.
    expect(outcomeFromChannel(complete)?.final).toBe(STATUS_FINAL.parked);
    expect(outcomeFromChannel(complete)?.final).toBe(false);
  });

  it('fills every field the app left out, so no field is ever absent (TOOL-13)', () => {
    const outcome = outcomeFromChannel({ status: 'verified' });
    expect(outcome).toBeDefined();
    for (const [name, value] of Object.entries(outcome ?? {})) {
      expect([name, value === undefined]).toEqual([name, false]);
    }
    expect(outcome).toMatchObject({
      handoff_id: null,
      round: 1,
      skipped_steps: [],
      notes: [],
      app_reachable: true,
      already_delivered: false,
      runbooks: [],
      spec_text: null,
    });
  });

  it('drops a field the closed schema does not know', () => {
    const outcome = outcomeFromChannel({ ...complete, surprise: 'from a newer app' });
    expect(outcome).toBeDefined();
    expect(Object.keys(outcome ?? {})).not.toContain('surprise');
  });

  it('reads every status of the contract, and nothing else', () => {
    for (const status of OUTCOME_STATUSES) {
      expect(outcomeFromChannel({ status })?.status).toBe(status);
    }
    expect(outcomeFromChannel({ status: 'moody' })).toBeUndefined();
    expect(outcomeFromChannel({})).toBeUndefined();
  });
});

describe('serverOutcome', () => {
  it('is a complete outcome about a handoff the app was not asked about', () => {
    const beat = serverOutcome('in_progress', HANDOFF);
    expect(beat.status).toBe('in_progress');
    expect(beat.handoff_id).toBe(HANDOFF);
    expect(beat.final).toBe(false);
    expect(beat.app_reachable).toBe(true);
    expect(beat.instruction).toContain(HANDOFF);
    expect(beat.instruction).not.toContain('<id>');
  });

  it('renders through the same contract as an outcome that crossed the channel', () => {
    const rendered = renderOutcome(serverOutcome('transferred_to_other_session', HANDOFF), row);
    const text = JSON.parse((rendered.content[0] as { text: string }).text) as {
      instruction: string;
      final: boolean;
    };
    expect(text.final).toBe(false);
    expect(text.instruction).toContain('Another session took over');
  });
});

describe('withChannelFailure (FM-10, FM-11)', () => {
  const base = renderOutcome(serverOutcome('in_progress', HANDOFF), row);

  it('adds nothing when the channel is merely absent', () => {
    expect(withChannelFailure(base, undefined)).toBe(base);
  });

  it.each(['CHANNEL_AUTH_FAILED', 'PROTOCOL_MISMATCH'] as const)(
    'appends the catalogue message and fix of %s as a second text block',
    (failure) => {
      const result = withChannelFailure(base, failure);
      expect(result.content).toHaveLength(base.content.length + 1);
      expect(result.content.at(-1)).toEqual({
        type: 'text',
        text: `${ERROR_TEXTS[failure].message} ${ERROR_TEXTS[failure].fix ?? ''}`,
      });
      // The outcome itself is untouched: the status is still what the agent branches on.
      expect(result.structuredContent).toEqual(base.structuredContent);
      expect(result.isError).toBe(false);
    },
  );
});

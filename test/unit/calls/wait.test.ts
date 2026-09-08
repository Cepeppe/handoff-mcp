/**
 * Blocking, the heartbeat, cancellation and re-attach, against a channel that is a stub
 * (TECHNICAL-DESIGN §5.7, §5.3, §8.2).
 *
 * The integration suite drives the same code over a real socket and a real app double; what
 * is easier to pin here is the timing and the bookkeeping: that the detach notification goes
 * out **before** the call returns, that a cancelled call is forgotten rather than left in the
 * table, that an event naming a call nobody waits on is ignored, and that a reconnection
 * resumes each waiting call with its own id.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  FINAL_HANDOFF_STATES,
  HANDOFF_STATES,
  InFlightCalls,
  readSnapshot,
} from '../../../src/calls';
import type { ChannelEvents, ChannelListener, JsonRpcParams } from '../../../src/channel';
import { createLogger } from '../../../src/log';
import type { ChannelPort } from '../../../src/mcp';

/** A channel that records what it was told and lets a test push events at will. */
class StubChannel implements ChannelPort {
  readonly sent: { method: string; params: JsonRpcParams }[] = [];
  readonly requests: { method: string; params: JsonRpcParams }[] = [];
  failure: undefined = undefined;
  answer: (method: string, params: JsonRpcParams) => Promise<JsonRpcParams> = () =>
    Promise.resolve({});

  private readonly listeners = new Map<string, Set<(payload: never) => void>>();

  isConnected(): boolean {
    return true;
  }

  request(method: string, params: JsonRpcParams = {}): Promise<JsonRpcParams> {
    this.requests.push({ method, params });
    return this.answer(method, params);
  }

  notify(method: string, params: JsonRpcParams = {}): boolean {
    this.sent.push({ method, params });
    return true;
  }

  on<K extends keyof ChannelEvents>(event: K, listener: ChannelListener<K>): () => void {
    const set = this.listeners.get(event) ?? new Set<(payload: never) => void>();
    const erased = listener as (payload: never) => void;
    set.add(erased);
    this.listeners.set(event, set);
    return () => set.delete(erased);
  }

  emit<K extends keyof ChannelEvents>(event: K, payload: ChannelEvents[K]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      (listener as unknown as (value: ChannelEvents[K]) => void)(payload);
    }
  }
}

const HANDOFF = 'hf_7k3m9p2q4r';
const CALL = 'call_2q7m8r1t';

function calls(channel: StubChannel): InFlightCalls {
  return new InFlightCalls({ channel, logger: createLogger('debug', () => undefined) });
}

/** A minimal outcome object; the pipeline, not this module, gives it its shape. */
const outcome = { status: 'parked', handoff_id: HANDOFF };

describe('waitForOutcome', () => {
  it('resolves with the outcome of the event that names the call', async () => {
    const channel = new StubChannel();
    const table = calls(channel);
    const waiting = table.waitForOutcome({
      handoff_id: HANDOFF,
      call_id: CALL,
      heartbeatAfterMs: 60_000,
      signal: new AbortController().signal,
    });
    expect(table.waiting).toBe(1);

    channel.emit('handoff.event', { call_id: CALL, handoff_id: HANDOFF, outcome });
    await expect(waiting).resolves.toEqual({
      kind: 'outcome',
      outcome,
      image: undefined,
      already_delivered: false,
    });
    expect(table.waiting).toBe(0);
    expect(channel.sent).toEqual([]);
  });

  it('carries the image that travelled beside the outcome (§6.6)', async () => {
    const channel = new StubChannel();
    const table = calls(channel);
    const waiting = table.waitForOutcome({
      handoff_id: HANDOFF,
      call_id: CALL,
      heartbeatAfterMs: 60_000,
      signal: new AbortController().signal,
    });

    channel.emit('handoff.event', {
      call_id: CALL,
      handoff_id: HANDOFF,
      outcome,
      image: 'aGVsbG8=',
    });
    await expect(waiting).resolves.toMatchObject({ image: 'aGVsbG8=' });
  });

  it('detaches at the deadline and only then answers in_progress (DD-24, TOOL-06)', async () => {
    vi.useFakeTimers();
    try {
      const channel = new StubChannel();
      const table = calls(channel);
      const waiting = table.waitForOutcome({
        handoff_id: HANDOFF,
        call_id: CALL,
        heartbeatAfterMs: 3_000,
        signal: new AbortController().signal,
      });

      vi.advanceTimersByTime(2_999);
      expect(channel.sent).toEqual([]);
      vi.advanceTimersByTime(1);

      expect(channel.sent).toEqual([
        {
          method: 'handoff.detach_call',
          params: { handoff_id: HANDOFF, call_id: CALL, reason: 'heartbeat' },
        },
      ]);
      await expect(waiting).resolves.toEqual({ kind: 'heartbeat' });
      expect(table.waiting).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('tells the app a cancelled call detached and forgets it (A-09, FM-07)', async () => {
    const channel = new StubChannel();
    const table = calls(channel);
    const controller = new AbortController();
    const waiting = table.waitForOutcome({
      handoff_id: HANDOFF,
      call_id: CALL,
      heartbeatAfterMs: 60_000,
      signal: controller.signal,
    });

    controller.abort();
    await expect(waiting).resolves.toEqual({ kind: 'cancelled' });
    expect(channel.sent[0]?.params).toMatchObject({ reason: 'cancelled' });
    expect(table.waiting).toBe(0);

    // The event that arrives afterwards names a call nobody is waiting on: it is dropped,
    // and above all it does not throw where there is nobody to catch it.
    channel.emit('handoff.event', { call_id: CALL, handoff_id: HANDOFF, outcome });
    expect(channel.sent).toHaveLength(1);
  });

  it('answers a signal that was already aborted without ever setting a timer', async () => {
    const channel = new StubChannel();
    const table = calls(channel);
    await expect(
      table.waitForOutcome({
        handoff_id: HANDOFF,
        call_id: CALL,
        heartbeatAfterMs: 60_000,
        signal: AbortSignal.abort(),
      }),
    ).resolves.toEqual({ kind: 'cancelled' });
    expect(table.waiting).toBe(0);
  });

  it('hands a displaced call transferred_to_other_session (TOOL-08)', async () => {
    const channel = new StubChannel();
    const table = calls(channel);
    const first = table.waitForOutcome({
      handoff_id: HANDOFF,
      call_id: CALL,
      heartbeatAfterMs: 60_000,
      signal: new AbortController().signal,
    });
    const second = table.waitForOutcome({
      handoff_id: HANDOFF,
      call_id: 'call_5w3n9k2v',
      heartbeatAfterMs: 60_000,
      signal: new AbortController().signal,
    });

    await expect(first).resolves.toEqual({ kind: 'transferred' });
    expect(table.waiting).toBe(1);

    channel.emit('handoff.event', { call_id: 'call_5w3n9k2v', handoff_id: HANDOFF, outcome });
    await expect(second).resolves.toMatchObject({ kind: 'outcome' });
  });

  it('remembers the call id of a handoff, so a continue re-attaches it (§6.3)', async () => {
    const channel = new StubChannel();
    const table = calls(channel);
    expect(table.callIdFor(HANDOFF)).toBeUndefined();

    const waiting = table.waitForOutcome({
      handoff_id: HANDOFF,
      call_id: CALL,
      heartbeatAfterMs: 60_000,
      signal: new AbortController().signal,
    });
    channel.emit('handoff.event', { call_id: CALL, handoff_id: HANDOFF, outcome });
    await waiting;

    // Still remembered after the call returned: that is when a continue needs it.
    expect(table.callIdFor(HANDOFF)).toBe(CALL);
  });
});

describe('re-attach after a reconnection (§5.3, FM-13)', () => {
  it('resumes every waiting call with its own id and keeps waiting when it re-attaches', async () => {
    const channel = new StubChannel();
    const table = calls(channel);
    const waiting = table.waitForOutcome({
      handoff_id: HANDOFF,
      call_id: CALL,
      heartbeatAfterMs: 60_000,
      signal: new AbortController().signal,
    });

    channel.answer = () => Promise.resolve({ state: 'active', outcome: null });
    channel.emit('connected', { session_ref: 'ses_4m7q2t9x', app_version: '1.0.0' });
    await Promise.resolve();
    await Promise.resolve();

    expect(channel.requests).toEqual([
      { method: 'handoff.resume', params: { call_id: CALL, handoff_id: HANDOFF } },
    ]);
    expect(table.waiting).toBe(1);

    channel.emit('handoff.event', { call_id: CALL, handoff_id: HANDOFF, outcome });
    await expect(waiting).resolves.toMatchObject({ kind: 'outcome' });
  });

  it('delivers the snapshot when the resume answers with one, marking a final one delivered', async () => {
    const channel = new StubChannel();
    const table = calls(channel);
    const waiting = table.waitForOutcome({
      handoff_id: HANDOFF,
      call_id: CALL,
      heartbeatAfterMs: 60_000,
      signal: new AbortController().signal,
    });

    channel.answer = () => Promise.resolve({ state: 'not_verified', outcome, image: 'aGVsbG8=' });
    channel.emit('connected', { session_ref: 'ses_4m7q2t9x', app_version: '1.0.0' });

    await expect(waiting).resolves.toEqual({
      kind: 'outcome',
      outcome,
      image: 'aGVsbG8=',
      already_delivered: true,
    });
  });

  it('gives up on a handoff the app no longer knows, and only on that answer', async () => {
    const channel = new StubChannel();
    const table = calls(channel);
    const waiting = table.waitForOutcome({
      handoff_id: HANDOFF,
      call_id: CALL,
      heartbeatAfterMs: 60_000,
      signal: new AbortController().signal,
    });

    // A channel error: the call is kept and retried at the next `connected`.
    channel.answer = () => Promise.reject(new Error('the channel is down'));
    channel.emit('connected', { session_ref: 'ses_4m7q2t9x', app_version: '1.0.0' });
    await Promise.resolve();
    await Promise.resolve();
    expect(table.waiting).toBe(1);

    channel.answer = () => Promise.reject(Object.assign(new Error('not_found'), { code: -32014 }));
    channel.emit('connected', { session_ref: 'ses_4m7q2t9x', app_version: '1.0.0' });
    await expect(waiting).resolves.toEqual({ kind: 'not_found' });
  });

  it('stops listening once closed', () => {
    const channel = new StubChannel();
    const table = calls(channel);
    const waiting = table.waitForOutcome({
      handoff_id: HANDOFF,
      call_id: CALL,
      heartbeatAfterMs: 60_000,
      signal: new AbortController().signal,
    });

    table.close();
    channel.emit('connected', { session_ref: 'ses_4m7q2t9x', app_version: '1.0.0' });
    expect(channel.requests).toEqual([]);

    // The call itself is still there: the SDK aborting its request is what ends it.
    expect(table.waiting).toBe(1);
    void waiting;
  });
});

describe('readSnapshot', () => {
  it('reads the three shapes of §5.7', () => {
    expect(readSnapshot({ state: 'active', outcome: null })).toEqual({
      state: 'active',
      outcome: null,
      image: undefined,
      final: false,
    });
    expect(readSnapshot({ state: 'verified', outcome })).toEqual({
      state: 'verified',
      outcome,
      image: undefined,
      final: true,
    });
    expect(readSnapshot({ state: 'awaiting_verification', outcome, image: 'aGk=' })).toMatchObject({
      final: false,
      image: 'aGk=',
    });
  });

  it('treats a state it does not know as non-final, so nothing is announced as final', () => {
    expect(readSnapshot({ state: 'sleeping', outcome })).toMatchObject({
      state: 'active',
      final: false,
    });
    expect(readSnapshot({})).toMatchObject({ state: 'active', outcome: null, final: false });
    // An outcome that is not an object is no outcome: the call attaches instead.
    expect(readSnapshot({ state: 'active', outcome: [] })).toMatchObject({ outcome: null });
  });

  it('classifies exactly the five final states of §8.1', () => {
    expect([...FINAL_HANDOFF_STATES].sort()).toEqual(
      ['abandoned', 'confirmed_by_user', 'failed', 'not_verified', 'verified'].sort(),
    );
    for (const state of HANDOFF_STATES) {
      expect(readSnapshot({ state }).final).toBe(FINAL_HANDOFF_STATES.includes(state));
    }
  });
});

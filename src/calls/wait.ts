/**
 * Blocking, the heartbeat, cancellation and re-attach (TECHNICAL-DESIGN §5.7, §5.3, §8.2,
 * TOOL-03..08, FM-06, FM-07, FM-13).
 *
 * A `handoff_to_user` call blocks until the user is done, which is longer than any agent
 * waits. §8.2 draws the four ways that wait can end, and this module is that diagram:
 *
 * - **`handoff.event`** names the call and carries its outcome. The ordinary end.
 * - **The heartbeat deadline** arrives first: the app is told the call is detaching
 *   (`handoff.detach_call { reason: "heartbeat" }`, DD-24) and the agent gets `in_progress`
 *   with the instruction to resume at once (TOOL-06).
 * - **The agent cancels** (`notifications/cancelled`, A-09): the app is told the same way
 *   with `reason: "cancelled"` and the call is forgotten. The SDK discards a result produced
 *   after an abort, so resolving here answers nobody; it only stops the promise dangling.
 * - **The channel is lost**: the entry is *kept*. When the connection returns every waiting
 *   call re-issues `handoff.resume` with its own `call_id` and either attaches again or is
 *   resolved by the snapshot (§5.3, FM-13). The user sees nothing but a banner in the tab.
 *
 * Two things this module refuses to do. It never builds an outcome: what it resolves with is
 * what the app sent, or a marker the pipeline turns into one, so `final` and the instruction
 * keep coming from the published contract (§4.3) and from one place. And it never reads the
 * clock to decide anything except when to set a timer: a call is late because its timer
 * fired, not because a comparison said so.
 */
import { applicationErrorName, type JsonRpcParams } from '../channel';
import type { Logger } from '../log';
import type { ChannelPort } from '../mcp/port';

import { InFlightTable, type InFlightCall } from './inflight';

/** The app-side handoff states of §8.1, as the channel snapshot reports them. */
export const HANDOFF_STATES = [
  'awaiting_spec',
  'active',
  'deferred',
  'parked',
  'awaiting_verification',
  'verified',
  'confirmed_by_user',
  'failed',
  'not_verified',
  'abandoned',
] as const;

export type HandoffState = (typeof HANDOFF_STATES)[number];

/**
 * §8.1: the five states a handoff never leaves on its own. A resume that lands on one of
 * them returns the outcome the app kept, with `already_delivered` (TOOL-07). `failed` and
 * `not_verified` are final and still continuable, which is a property of the agent's next
 * call rather than of this classification.
 */
export const FINAL_HANDOFF_STATES: readonly HandoffState[] = [
  'verified',
  'confirmed_by_user',
  'failed',
  'not_verified',
  'abandoned',
];

/** The snapshot `handoff.resume` answers with (§5.7). */
export interface ResumeSnapshot {
  readonly state: HandoffState;
  /** A final outcome, a queued undelivered event, or nothing: then the call attaches. */
  readonly outcome: Record<string, unknown> | null;
  /** The base64 PNG of a queued screenshot, when the queued outcome carries one (§6.6). */
  readonly image: string | undefined;
  readonly final: boolean;
}

/**
 * Reads a `handoff.resume` result. The server tolerates unknown fields in a result (§6.3),
 * so this takes what it needs and ignores the rest; a `state` it does not recognise counts
 * as non-final, which errs towards attaching and waiting rather than towards announcing a
 * final outcome nobody sent.
 */
export function readSnapshot(result: JsonRpcParams): ResumeSnapshot {
  const raw = result['state'];
  const known = (HANDOFF_STATES as readonly unknown[]).includes(raw);
  const state = (known ? raw : 'active') as HandoffState;
  const outcome = result['outcome'];
  const image = result['image'];
  return {
    state,
    outcome:
      typeof outcome === 'object' && outcome !== null && !Array.isArray(outcome)
        ? (outcome as Record<string, unknown>)
        : null,
    image: typeof image === 'string' ? image : undefined,
    final: FINAL_HANDOFF_STATES.includes(state),
  };
}

/** How a blocking call ended. The pipeline turns each of these into a tool result. */
export type WaitOutcome =
  | {
      readonly kind: 'outcome';
      readonly outcome: Record<string, unknown>;
      readonly image: string | undefined;
      /** True when a resume answered with the final outcome it had already delivered. */
      readonly already_delivered: boolean;
    }
  /** The heartbeat fired: `in_progress`, and the agent resumes at once (TOOL-06). */
  | { readonly kind: 'heartbeat' }
  /** The agent cancelled. Nothing is returned; the SDK discards a result after an abort. */
  | { readonly kind: 'cancelled' }
  /** A re-attach found the handoff gone: the one way a kept call stops being resumable. */
  | { readonly kind: 'not_found' }
  /** This server took the handoff over with another call of its own (TOOL-08). */
  | { readonly kind: 'transferred' };

/** One blocking wait, as the pipeline asks for it. */
export interface WaitRequest {
  readonly handoff_id: string;
  readonly call_id: string;
  /** How long after now the heartbeat fires (§5.6, `heartbeatAfterMs`). */
  readonly heartbeatAfterMs: number;
  /** `extra.signal` of the MCP request being served (A-09). */
  readonly signal: AbortSignal;
}

export interface InFlightCallsOptions {
  readonly channel: ChannelPort;
  readonly logger: Logger;
}

/** The two reasons §6.3 lets `handoff.detach_call` carry. */
type DetachReason = 'heartbeat' | 'cancelled';

/**
 * The in-flight calls of one server: the table of §5.7 with the two channel subscriptions
 * that drive it. One instance per `serve`, built before the channel is started so that no
 * event can arrive before there is somewhere to put it.
 */
export class InFlightCalls {
  private readonly table = new InFlightTable<WaitOutcome>();
  private readonly lastCallId = new Map<string, string>();
  private readonly channel: ChannelPort;
  private readonly logger: Logger;
  private readonly unsubscribe: (() => void)[] = [];

  constructor(options: InFlightCallsOptions) {
    this.channel = options.channel;
    this.logger = options.logger;
    this.unsubscribe.push(
      this.channel.on('handoff.event', (event) => {
        this.deliver(event.call_id, event.outcome, event.image);
      }),
      this.channel.on('connected', () => {
        this.reattachAll();
      }),
    );
  }

  /** How many calls are blocking right now. */
  get waiting(): number {
    return this.table.size;
  }

  /**
   * The call this server last attached to a handoff, whether or not it is still waiting.
   *
   * Only `handoff.open` and `handoff.resume` mint a `call_id`: everything else has to cite
   * one that was opened or resumed, which is the consistency rule the golden sequences are
   * built on and `test/contract/channel.test.ts` enforces. So a continue re-attaches the
   * call the question came back on rather than inventing one the app never saw start. Not
   * every handoff has one — a resume works from any session (TOOL-08), and this server may
   * never have opened the handoff it is continuing — and then the caller mints one, which
   * the app accepts because the connection, not the id, is what identifies the session.
   */
  callIdFor(handoffId: string): string | undefined {
    return this.lastCallId.get(handoffId);
  }

  /** Stops listening. The calls themselves end when the SDK aborts their requests. */
  close(): void {
    for (const off of this.unsubscribe.splice(0)) off();
  }

  /**
   * Blocks until the user is done, the heartbeat fires, the agent cancels or the handoff
   * turns out to be gone. The app already knows this `call_id`: the `handoff.open`,
   * `handoff.continue` or `handoff.resume` that carried it has been answered before we
   * start waiting.
   */
  waitForOutcome(request: WaitRequest): Promise<WaitOutcome> {
    const { handoff_id, call_id, heartbeatAfterMs, signal } = request;
    const started_at = Date.now();
    this.lastCallId.set(handoff_id, call_id);

    return new Promise<WaitOutcome>((resolve) => {
      let settled = false;
      // Undone in reverse when the call settles, whichever of the four ways ends it. A list
      // rather than named handles, so an ending that happens before the timer exists — an
      // agent that cancelled while we were still registering — undoes only what is there.
      const cleanup: (() => void)[] = [];

      const settle = (result: WaitOutcome): void => {
        if (settled) return;
        settled = true;
        for (const undo of cleanup.splice(0).reverse()) undo();
        this.table.detach(call_id);
        resolve(result);
      };

      const detach = (reason: DetachReason): void => {
        this.logger.debug('call_detached', { handoff_id, call_id, reason });
        this.channel.notify('handoff.detach_call', { handoff_id, call_id, reason });
      };

      const onAbort = (): void => {
        if (settled) return;
        detach('cancelled');
        settle({ kind: 'cancelled' });
      };

      const displaced = this.table.attach({
        call_id,
        handoff_id,
        started_at,
        deadline: started_at + heartbeatAfterMs,
        resolve: settle,
      });
      if (displaced !== undefined) {
        this.logger.debug('call_displaced', { handoff_id, call_id: displaced.call_id });
        displaced.resolve({ kind: 'transferred' });
      }

      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      cleanup.push(() => {
        signal.removeEventListener('abort', onAbort);
      });

      const timer = setTimeout(() => {
        detach('heartbeat');
        settle({ kind: 'heartbeat' });
      }, heartbeatAfterMs);
      // A blocking call outlives everything else here; it must not be the reason the
      // process stays up once the agent has gone.
      timer.unref();
      cleanup.push(() => {
        clearTimeout(timer);
      });
    });
  }

  /** An event names the call it belongs to; one that names none has already returned. */
  private deliver(callId: string, outcome: Record<string, unknown>, image?: string): void {
    const call = this.table.get(callId);
    if (call === undefined) {
      this.logger.debug('event_for_unknown_call', { call_id: callId });
      return;
    }
    call.resolve({ kind: 'outcome', outcome, image, already_delivered: false });
  }

  /**
   * The connection is back (§5.3, FM-13): every call that was waiting on the lost one
   * re-issues `handoff.resume` with its own `call_id`. The app either attaches it again — and
   * the wait continues where it left off — or answers with the snapshot, which is read here
   * exactly as a fresh resume reads it.
   */
  private reattachAll(): void {
    for (const call of this.table.waiting()) void this.reattach(call);
  }

  private async reattach(call: InFlightCall<WaitOutcome>): Promise<void> {
    const { call_id, handoff_id } = call;
    this.logger.debug('call_reattaching', { call_id, handoff_id });

    let result: JsonRpcParams;
    try {
      result = await this.channel.request('handoff.resume', { call_id, handoff_id });
    } catch (cause) {
      // `not_found` is the only answer that makes a kept call unresumable: the handoff is
      // gone and no later reconnection will bring it back. Anything else — the channel down
      // again, a timeout — is left alone and retried at the next `connected`.
      if (isNotFound(cause)) {
        this.logger.error('call_reattach_gone', { call_id, handoff_id });
        call.resolve({ kind: 'not_found' });
        return;
      }
      this.logger.debug('call_reattach_failed', { call_id, handoff_id });
      return;
    }

    const snapshot = readSnapshot(result);
    this.logger.debug('call_reattached', { call_id, handoff_id, state: snapshot.state });
    if (snapshot.outcome === null) return;
    // An event may have raced the snapshot; `resolve` is `settle`, which ignores a second
    // answer, so the first one home wins and neither leaks.
    call.resolve({
      kind: 'outcome',
      outcome: snapshot.outcome,
      image: snapshot.image,
      already_delivered: snapshot.final,
    });
  }
}

/** The `not_found` of §6.3, recognised by its code alone (§6.3, the T-018 note under T-020). */
function isNotFound(cause: unknown): boolean {
  if (typeof cause !== 'object' || cause === null) return false;
  const code = (cause as { code?: unknown }).code;
  return typeof code === 'number' && applicationErrorName(code) === 'not_found';
}

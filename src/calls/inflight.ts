/**
 * The in-flight call table (TECHNICAL-DESIGN §5.7, §2.3, TOOL-07, TOOL-08).
 *
 * One entry per blocking `handoff_to_user` invocation that is waiting for the user. The
 * table lives in memory and survives nothing: §2.3 says so on purpose, because the handoff
 * itself is in the app's database and `handoff.resume` rebuilds everything a new server
 * needs to know. What the table is for is the two things the app cannot do for us — resolve
 * the right call when an event names it, and re-attach the calls that were waiting when the
 * connection came back (§5.3, FM-13).
 *
 * **At most one waiting call per handoff in this server.** Calls are keyed by `call_id`,
 * because that is what `handoff.event` addresses, but a second call for a handoff this
 * server is already waiting on would leave two promises racing for one outcome. `attach`
 * therefore evicts the older one and hands it back to the caller, which resolves it with
 * `transferred_to_other_session` — the status §4.3 defines for exactly this, and the one the
 * app would itself have sent had the two calls come from different sessions (§5.7, TOOL-08).
 */

/** What a waiting call resolves with; the shape belongs to `wait.ts`. */
export type Resolve<T> = (value: T) => void;

export interface InFlightCall<T> {
  readonly call_id: string;
  readonly handoff_id: string;
  /** When the call started blocking, in epoch milliseconds. */
  readonly started_at: number;
  /** When the heartbeat fires, in epoch milliseconds (§5.7, TOOL-06a). */
  readonly deadline: number;
  readonly resolve: Resolve<T>;
}

/**
 * The table of §5.7. Generic in what a call resolves with so that the outcome type stays
 * with the pipeline that builds it and this module keeps no opinion about it.
 */
export class InFlightTable<T> {
  private readonly byCall = new Map<string, InFlightCall<T>>();
  private readonly byHandoff = new Map<string, string>();

  /** How many calls are waiting right now. */
  get size(): number {
    return this.byCall.size;
  }

  /**
   * Registers a waiting call and returns the call it displaced, if any: the previous
   * waiting call of the same handoff, already removed from the table and still holding an
   * unresolved promise. The caller owns telling it what happened.
   */
  attach(call: InFlightCall<T>): InFlightCall<T> | undefined {
    const displaced = this.forHandoff(call.handoff_id);
    if (displaced !== undefined) this.detach(displaced.call_id);
    this.byCall.set(call.call_id, call);
    this.byHandoff.set(call.handoff_id, call.call_id);
    return displaced;
  }

  /** The call an event names, or nothing when it names one that has already returned. */
  get(callId: string): InFlightCall<T> | undefined {
    return this.byCall.get(callId);
  }

  /** The call waiting on this handoff, if this server has one. */
  forHandoff(handoffId: string): InFlightCall<T> | undefined {
    const callId = this.byHandoff.get(handoffId);
    return callId === undefined ? undefined : this.byCall.get(callId);
  }

  /** Forgets a call. Returns it, so a caller can resolve it in the same expression. */
  detach(callId: string): InFlightCall<T> | undefined {
    const call = this.byCall.get(callId);
    if (call === undefined) return undefined;
    this.byCall.delete(callId);
    if (this.byHandoff.get(call.handoff_id) === callId) this.byHandoff.delete(call.handoff_id);
    return call;
  }

  /** Every waiting call, oldest first: the set to re-attach after a reconnection (§5.3). */
  waiting(): readonly InFlightCall<T>[] {
    return [...this.byCall.values()];
  }
}

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
 *
 * **The handoff of an open is learnt late, the call is registered early.** An open has no
 * handoff until the app answers, but it must be in the table *before* the request goes out:
 * the app answers and pushes the outcome in the same breath, a local socket delivers both in
 * one read, and a table filled after the answer was awaited is still empty when the outcome
 * lands. So a call may be registered with no handoff and `bind` names it afterwards.
 */

/** What a waiting call resolves with; the shape belongs to `wait.ts`. */
export type Resolve<T> = (value: T) => void;

export interface InFlightCall<T> {
  readonly call_id: string;
  /**
   * Empty until an **open** is answered: the handoff does not exist before that, and the
   * call is nonetheless registered first (see `bind`). A continue and a resume know it from
   * the start, because the agent named it.
   */
  handoff_id: string;
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
    this.byCall.set(call.call_id, call);
    return this.index(call);
  }

  /**
   * Names the handoff of a call that was registered before it had one — an open, which learns
   * its handoff from the answer. Returns what it displaced, exactly as `attach` does.
   *
   * A call that has already returned is not re-indexed: the event may have arrived in the
   * same read as the answer, which is the whole reason the call is registered first.
   */
  bind(callId: string, handoffId: string): InFlightCall<T> | undefined {
    const call = this.byCall.get(callId);
    if (call === undefined) return undefined;
    call.handoff_id = handoffId;
    return this.index(call);
  }

  /**
   * Puts the call in the one slot its handoff has, and hands back the one it pushed out.
   *
   * A call cannot displace itself: registering the same call twice — an open bound a second
   * time — leaves it exactly where it was and displaces nobody.
   */
  private index(call: InFlightCall<T>): InFlightCall<T> | undefined {
    if (call.handoff_id === '') return undefined;
    const held = this.forHandoff(call.handoff_id);
    this.byHandoff.set(call.handoff_id, call.call_id);
    if (held === undefined || held.call_id === call.call_id) return undefined;
    this.detach(held.call_id);
    return held;
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

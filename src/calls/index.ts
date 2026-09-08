/**
 * In-flight call table, heartbeat timers, resume and transfer bookkeeping.
 *
 * TECHNICAL-DESIGN §5.7, §8.2. `InFlightCalls` is the entry point: the tool pipeline sends
 * `handoff.open`, `handoff.continue` or `handoff.resume` and then hands the call to
 * `waitForOutcome`, which owns everything that happens until the call returns.
 */

export { InFlightTable } from './inflight';
export type { InFlightCall, Resolve } from './inflight';
export { FINAL_HANDOFF_STATES, HANDOFF_STATES, InFlightCalls, readSnapshot } from './wait';
export type {
  HandoffState,
  InFlightCallsOptions,
  ResumeSnapshot,
  WaitOutcome,
  WaitRequest,
} from './wait';

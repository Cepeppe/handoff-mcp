/**
 * Capability table, per-agent identity resolution and heartbeat arithmetic.
 *
 * TECHNICAL-DESIGN §5.6. `resolveCapabilityRow` is the entry point: everything else in
 * the server reads the row it returns and never the table itself, so an agent fact is
 * stated once, in `capabilities.json`, and the app receives it already resolved (ADPT-03).
 */

export {
  HEARTBEAT_MARGIN_MS,
  UNKNOWN_CLIENT_HEARTBEAT_MS,
  heartbeatAfterMs,
  resolveToolTimeout,
  toolTimeoutMs,
} from './heartbeat';
export type { ResolvedTimeout, TimeoutEnvironment, TimeoutSource } from './heartbeat';
export {
  CAPABILITIES_VERSION,
  CAPABILITY_TABLE,
  UNKNOWN_AGENT_ID,
  capabilityRowForHello,
  resolveCapabilityRow,
  resolveRow,
  unknownRow,
} from './resolve';
export type {
  CapabilityRow,
  HelloCapabilityRow,
  IdentityInput,
  ResolvedCapabilityRow,
  SupportLevel,
  UserRequestDelivery,
} from './resolve';

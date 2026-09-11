/**
 * Capability table, per-agent identity resolution, the session identity of an editor and
 * heartbeat arithmetic.
 *
 * TECHNICAL-DESIGN §5.6. `resolveCapabilityRow` is the entry point: everything else in
 * the server reads the row it returns and never the table itself, so an agent fact is
 * stated once, in `capabilities.json`, and the app receives it already resolved (ADPT-03).
 * `resolveSessionIdentity` is the one fact the table cannot state, because it belongs to the
 * session rather than to the agent (T-069).
 */

export {
  EDITOR_SESSION_IDENTITY,
  PARENT_PID_SESSION_IDENTITY,
  editorHost,
  isEditorExecutable,
  resolveSessionIdentity,
  workspaceFromRoots,
} from './editor';
export type { ClientRoot, EditorProcess, SessionIdentity, SessionIdentityKind } from './editor';
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

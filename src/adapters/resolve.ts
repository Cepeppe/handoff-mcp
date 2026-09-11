/**
 * The capability table and the identity resolution over it (TECHNICAL-DESIGN §5.6,
 * ADPT-01..05, DD-09).
 *
 * `capabilities.json` is bundled into the executable rather than read from disk, for the
 * same reason as the schema and the pattern file: the single-file build has no package
 * directory to read from at run time.
 *
 * The table is read by the **server** because it holds protocol and agent facts that must
 * hold for a user of the server without the app (ADPT-03). The app never sees the table:
 * it receives the already resolved row in `hello` and adapts only its UI, which is what
 * `capabilityRowForHello` builds.
 */
import capabilityFile from './capabilities.json';

/** The support levels of ADPT-01. `unsupported` exists for an agent that cannot block. */
export type SupportLevel = 'full' | 'base' | 'unsupported';

/** How a user-opened request reaches the agent (OPEN-03..08). */
export type UserRequestDelivery = 'clipboard_focus' | 'stop_hook';

/** One row of `capabilities.json`, `null` where the fact has not been measured yet. */
export interface CapabilityRow {
  readonly agent_id: string;
  readonly display_name: string;
  readonly status: 'supported' | 'planned';
  readonly support: SupportLevel;
  readonly match: { readonly env: string | null; readonly client_names: readonly string[] };
  readonly tool_timeout_ms_default: number | null;
  readonly per_server_timeout_field: string | null;
  readonly images_in_results: boolean | null;
  readonly stop_hook: boolean | null;
  readonly subagent_stop_hook: boolean | null;
  readonly session_identity: string;
  readonly user_request_delivery: readonly UserRequestDelivery[] | null;
  readonly cancellation_notifications: boolean | null;
  readonly heartbeat_after_ms: number | null;
}

/**
 * A row with every `null` already replaced by the `unknown` row's value for that field
 * (§5.6). Two fields stay nullable because the `unknown` row itself has no value for
 * them: no timeout is known for a client we do not know, and it declares no per-server
 * timeout field.
 */
export interface ResolvedCapabilityRow extends CapabilityRow {
  readonly images_in_results: boolean;
  readonly stop_hook: boolean;
  readonly subagent_stop_hook: boolean;
  readonly user_request_delivery: readonly UserRequestDelivery[];
  readonly cancellation_notifications: boolean;
  readonly heartbeat_after_ms: number;
}

/** The agent id of the fallback row. */
export const UNKNOWN_AGENT_ID = 'unknown';

/** The table as written in `capabilities.json`, in file order. */
export const CAPABILITY_TABLE: readonly CapabilityRow[] =
  capabilityFile.rows as readonly CapabilityRow[];

export const CAPABILITIES_VERSION: number = capabilityFile.capabilities_version;

/** The `unknown` row of a table: the fallback identity and the source of every default. */
export function unknownRow(table: readonly CapabilityRow[] = CAPABILITY_TABLE): CapabilityRow {
  const row = table.find((candidate) => candidate.agent_id === UNKNOWN_AGENT_ID);
  if (row === undefined) throw new Error('capability table has no unknown row');
  return row;
}

/**
 * What identity resolution is given: the installer-written `HANDOFF_AGENT` and the
 * `clientInfo.name` of the MCP `initialize` handshake. Both are optional — a server
 * started by hand has neither.
 */
export interface IdentityInput {
  readonly agent?: string | undefined;
  readonly clientName?: string | undefined;
}

/**
 * `clientInfo.name` is compared without case, because the value agents send is not
 * documented (A-08) and is recorded empirically per version; a capitalisation change in
 * an agent release must not silently demote a session to `unknown`. `HANDOFF_AGENT` is
 * compared the same way for symmetry, although the installer writes it itself.
 */
function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Identity resolution, in the order of §5.6:
 *
 * 1. `HANDOFF_AGENT` against `match.env`. Authoritative, because the installer knows
 *    which agent's configuration it wrote.
 * 2. `clientInfo.name` against `match.client_names`. A fallback for servers installed
 *    without our installer (npm users); the lists are empty until T-023 records them.
 * 3. The `unknown` row.
 *
 * A `HANDOFF_AGENT` naming no row does not stop the walk: the handshake is tried next and
 * the `unknown` row catches what is left. A value we do not recognise is a table that has
 * not caught up with the installer, not a reason to lose the agent's own answer.
 */
export function resolveRow(
  identity: IdentityInput,
  table: readonly CapabilityRow[] = CAPABILITY_TABLE,
): CapabilityRow {
  const { agent, clientName } = identity;

  if (agent !== undefined && agent.trim() !== '') {
    const byEnv = table.find((row) => row.match.env !== null && sameName(row.match.env, agent));
    if (byEnv !== undefined) return byEnv;
  }

  if (clientName !== undefined && clientName.trim() !== '') {
    const byClient = table.find((row) =>
      row.match.client_names.some((name) => sameName(name, clientName)),
    );
    if (byClient !== undefined) return byClient;
  }

  return unknownRow(table);
}

/**
 * Reads a field the `unknown` row is required to define. A `null` there would leave the
 * fallback itself undefined, so the table is broken and the server says so at startup
 * instead of inventing a value.
 */
function must<T>(value: T | null, field: string): T {
  if (value === null) throw new Error(`capability table: the unknown row has no ${field}`);
  return value;
}

/** Replaces every `null` of `row` with the value the `unknown` row gives that field. */
function withUnknownDefaults(row: CapabilityRow, fallback: CapabilityRow): ResolvedCapabilityRow {
  return {
    ...row,
    tool_timeout_ms_default: row.tool_timeout_ms_default ?? fallback.tool_timeout_ms_default,
    per_server_timeout_field: row.per_server_timeout_field ?? fallback.per_server_timeout_field,
    images_in_results:
      row.images_in_results ?? must(fallback.images_in_results, 'images_in_results'),
    stop_hook: row.stop_hook ?? must(fallback.stop_hook, 'stop_hook'),
    subagent_stop_hook:
      row.subagent_stop_hook ?? must(fallback.subagent_stop_hook, 'subagent_stop_hook'),
    user_request_delivery:
      row.user_request_delivery ?? must(fallback.user_request_delivery, 'user_request_delivery'),
    cancellation_notifications:
      row.cancellation_notifications ??
      must(fallback.cancellation_notifications, 'cancellation_notifications'),
    heartbeat_after_ms:
      row.heartbeat_after_ms ?? must(fallback.heartbeat_after_ms, 'heartbeat_after_ms'),
  };
}

/**
 * The row this session runs under: resolved by identity, then completed from the `unknown`
 * row. This is what the rest of the server reads; nothing else may consult the table.
 */
export function resolveCapabilityRow(
  identity: IdentityInput,
  table: readonly CapabilityRow[] = CAPABILITY_TABLE,
): ResolvedCapabilityRow {
  return withUnknownDefaults(resolveRow(identity, table), unknownRow(table));
}

/**
 * The `capability_row` of `hello` (§6.3, `protocol/channel/channel.v1.schema.json`): the
 * five fields the app needs to adapt its UI, plus the display name it shows in the tab.
 * The timeout travels already resolved — the app owns no agent facts (ADPT-03) — and is
 * `null` when nothing is known, which is exactly when the heartbeat falls back to 50 s.
 *
 * `session_identity` travels only when the session resolved to the editor key
 * (`ancestor_chain:editor`, `src/adapters/editor.ts`, T-069). It is a fact about the session
 * rather than about the agent — Cursor's editor and its CLI share one row — so it is the
 * resolved value and never the row's. A `hello` without it is keyed on the parent, as every
 * `hello` was before, so the app needs no version check to read it.
 */
export interface HelloCapabilityRow {
  readonly agent_id: string;
  readonly display_name: string;
  readonly support: SupportLevel;
  readonly images_in_results: boolean;
  readonly stop_hook: boolean;
  readonly tool_timeout_ms: number | null;
  readonly session_identity?: string;
}

export function capabilityRowForHello(
  row: ResolvedCapabilityRow,
  toolTimeoutMs: number | null,
  sessionIdentity?: string,
): HelloCapabilityRow {
  return {
    agent_id: row.agent_id,
    display_name: row.display_name,
    support: row.support,
    images_in_results: row.images_in_results,
    stop_hook: row.stop_hook,
    tool_timeout_ms: toolTimeoutMs,
    ...(sessionIdentity === undefined ? {} : { session_identity: sessionIdentity }),
  };
}

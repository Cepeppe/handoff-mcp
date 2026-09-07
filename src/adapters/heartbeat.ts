/**
 * Heartbeat arithmetic (TECHNICAL-DESIGN §5.6, §4.1 constants; TOOL-06, TOOL-06a).
 *
 * A `handoff_to_user` call blocks until the user is done, which is longer than any agent
 * will wait. Shortly before the agent's own tool timeout the server returns `in_progress`
 * with the instruction to call `resume`, so the call ends on our terms instead of being
 * cancelled on the agent's (§5.7). "Shortly before" is the whole of this module: how long
 * the agent waits, and how much margin we leave.
 *
 * Both numbers degrade safely. When nothing tells us the timeout we heartbeat at 50 s,
 * which is under the 60 s default of the MCP clients we do not know (TOOL-06a); when the
 * timeout is known we heartbeat a minute before it. A heartbeat that fires too early
 * costs one extra tool call; one that fires too late loses the call.
 */
import type { ResolvedCapabilityRow } from './resolve';

/** §4.1: the heartbeat fires this long before the known client timeout (TOOL-06a). */
export const HEARTBEAT_MARGIN_MS = 60_000;

/** §4.1: the heartbeat used when no timeout is known, and the floor of every other. */
export const UNKNOWN_CLIENT_HEARTBEAT_MS = 50_000;

/**
 * `MCP_TOOL_TIMEOUT` is Claude Code's own variable (A-03) and is only trusted for Claude
 * Code: another agent inheriting it from a shared shell would be described by a number
 * that does not govern it.
 */
const MCP_TOOL_TIMEOUT_AGENT_ID = 'claude-code';

/**
 * The two environment values that can carry a timeout, read by `readConfig` (`src/config`).
 * A `Config` satisfies this shape; a test can pass the two fields alone.
 */
export interface TimeoutEnvironment {
  /** `HANDOFF_TOOL_TIMEOUT_MS`, written by the installer to mirror what it configured. */
  readonly toolTimeoutMs?: number | undefined;
  /** `MCP_TOOL_TIMEOUT`, inherited from Claude Code's settings `env` block. */
  readonly mcpToolTimeoutMs?: number | undefined;
}

/** Which of the four sources of §5.6 answered. `none` means the timeout stays unknown. */
export type TimeoutSource = 'HANDOFF_TOOL_TIMEOUT_MS' | 'MCP_TOOL_TIMEOUT' | 'table' | 'none';

export interface ResolvedTimeout {
  /** The tool timeout of this session in milliseconds, `null` when nothing is known. */
  readonly ms: number | null;
  /** Where it came from. `doctor` prints it; nothing else branches on it. */
  readonly source: TimeoutSource;
}

/**
 * Tool-timeout resolution, in the order of §5.6:
 *
 * 1. `HANDOFF_TOOL_TIMEOUT_MS` — the installer wrote it because it configured that
 *    timeout, so it beats anything the table remembers.
 * 2. `MCP_TOOL_TIMEOUT`, for `claude-code` only (A-03).
 * 3. The row's `tool_timeout_ms_default`, the value documented for that agent.
 * 4. Nothing: `null`, and the heartbeat falls back to the row's `heartbeat_after_ms`.
 */
export function resolveToolTimeout(
  row: ResolvedCapabilityRow,
  env: TimeoutEnvironment = {},
): ResolvedTimeout {
  if (env.toolTimeoutMs !== undefined) {
    return { ms: env.toolTimeoutMs, source: 'HANDOFF_TOOL_TIMEOUT_MS' };
  }
  if (env.mcpToolTimeoutMs !== undefined && row.agent_id === MCP_TOOL_TIMEOUT_AGENT_ID) {
    return { ms: env.mcpToolTimeoutMs, source: 'MCP_TOOL_TIMEOUT' };
  }
  if (row.tool_timeout_ms_default !== null) {
    return { ms: row.tool_timeout_ms_default, source: 'table' };
  }
  return { ms: null, source: 'none' };
}

/** The resolved timeout alone, which is what `hello.capability_row.tool_timeout_ms` carries. */
export function toolTimeoutMs(
  row: ResolvedCapabilityRow,
  env: TimeoutEnvironment = {},
): number | null {
  return resolveToolTimeout(row, env).ms;
}

/**
 * How long after the start of a call the heartbeat fires.
 *
 * With a known timeout: `max(timeout − 60 s, 50 s)`. The floor matters for the short
 * timeouts, where subtracting a full minute would put the heartbeat at or before the
 * start of the call and the agent would never see an `in_progress`.
 *
 * With no known timeout: the row's own `heartbeat_after_ms`, which resolution has already
 * filled from the `unknown` row — 50 s. It is taken as written rather than floored,
 * because a row that names its heartbeat is stating a measured fact about that agent.
 */
export function heartbeatAfterMs(row: ResolvedCapabilityRow, env: TimeoutEnvironment = {}): number {
  const timeout = resolveToolTimeout(row, env).ms;
  if (timeout === null) return row.heartbeat_after_ms;
  return Math.max(timeout - HEARTBEAT_MARGIN_MS, UNKNOWN_CLIENT_HEARTBEAT_MS);
}

/**
 * Heartbeat arithmetic (TECHNICAL-DESIGN §5.6, §4.1; TOOL-06, TOOL-06a).
 *
 * The precedence table and the margin are asserted source by source, because the failure
 * they guard against is invisible: a heartbeat computed from the wrong number still
 * returns an outcome, it just returns it after the agent has already cancelled the call.
 */
import { describe, expect, it } from 'vitest';

import {
  HEARTBEAT_MARGIN_MS,
  UNKNOWN_CLIENT_HEARTBEAT_MS,
  heartbeatAfterMs,
  resolveCapabilityRow,
  resolveToolTimeout,
  toolTimeoutMs,
  type CapabilityRow,
  type ResolvedCapabilityRow,
} from '../../../src/adapters';

const claude = resolveCapabilityRow({ agent: 'claude-code' });
const codex = resolveCapabilityRow({ agent: 'codex' });
const unknown = resolveCapabilityRow({});

/** A row that documents a timeout of its own, which no shipped row does yet. */
function withDefault(row: ResolvedCapabilityRow, ms: number | null): ResolvedCapabilityRow {
  return { ...row, tool_timeout_ms_default: ms };
}

describe('§4.1 constants', () => {
  it('are the values the design fixes', () => {
    expect(HEARTBEAT_MARGIN_MS).toBe(60_000);
    expect(UNKNOWN_CLIENT_HEARTBEAT_MS).toBe(50_000);
  });
});

describe('timeout precedence', () => {
  it('1. HANDOFF_TOOL_TIMEOUT_MS beats everything', () => {
    const env = { toolTimeoutMs: 900_000, mcpToolTimeoutMs: 1_800_000 };
    expect(resolveToolTimeout(withDefault(claude, 300_000), env)).toEqual({
      ms: 900_000,
      source: 'HANDOFF_TOOL_TIMEOUT_MS',
    });
  });

  it('2. MCP_TOOL_TIMEOUT comes next, for claude-code only', () => {
    const env = { mcpToolTimeoutMs: 1_800_000 };
    expect(resolveToolTimeout(claude, env)).toEqual({
      ms: 1_800_000,
      source: 'MCP_TOOL_TIMEOUT',
    });
    expect(resolveToolTimeout(codex, env)).toEqual({ ms: null, source: 'none' });
    expect(resolveToolTimeout(unknown, env)).toEqual({ ms: null, source: 'none' });
  });

  it('2. a non-Claude agent still uses HANDOFF_TOOL_TIMEOUT_MS', () => {
    expect(resolveToolTimeout(codex, { toolTimeoutMs: 120_000 })).toEqual({
      ms: 120_000,
      source: 'HANDOFF_TOOL_TIMEOUT_MS',
    });
  });

  it('3. then the row default', () => {
    expect(resolveToolTimeout(withDefault(codex, 240_000), {})).toEqual({
      ms: 240_000,
      source: 'table',
    });
    expect(resolveToolTimeout(withDefault(claude, 240_000), { mcpToolTimeoutMs: 900_000 })).toEqual(
      { ms: 900_000, source: 'MCP_TOOL_TIMEOUT' },
    );
  });

  it('4. and nothing at all when no source answers', () => {
    expect(resolveToolTimeout(claude, {})).toEqual({ ms: null, source: 'none' });
    expect(resolveToolTimeout(unknown)).toEqual({ ms: null, source: 'none' });
    expect(toolTimeoutMs(unknown)).toBeNull();
  });
});

describe('heartbeat margin and floor', () => {
  it('fires a minute before a known timeout', () => {
    expect(heartbeatAfterMs(claude, { toolTimeoutMs: 1_800_000 })).toBe(1_740_000);
    expect(heartbeatAfterMs(claude, { mcpToolTimeoutMs: 1_800_000 })).toBe(1_740_000);
    expect(heartbeatAfterMs(withDefault(codex, 600_000))).toBe(540_000);
  });

  it('never goes below 50 s, whatever the arithmetic says', () => {
    expect(heartbeatAfterMs(claude, { toolTimeoutMs: 110_000 })).toBe(50_000);
    expect(heartbeatAfterMs(claude, { toolTimeoutMs: 60_000 })).toBe(50_000);
    expect(heartbeatAfterMs(claude, { toolTimeoutMs: 1 })).toBe(50_000);
  });

  it('crosses the floor exactly where the margin says it does', () => {
    expect(heartbeatAfterMs(claude, { toolTimeoutMs: 110_001 })).toBe(50_001);
    expect(heartbeatAfterMs(claude, { toolTimeoutMs: 110_000 })).toBe(50_000);
    expect(heartbeatAfterMs(claude, { toolTimeoutMs: 109_999 })).toBe(50_000);
  });

  it('falls back to 50 s for the unknown row (TOOL-06a)', () => {
    expect(heartbeatAfterMs(unknown)).toBe(UNKNOWN_CLIENT_HEARTBEAT_MS);
  });

  it('falls back to 50 s for any agent whose timeout nothing states', () => {
    expect(heartbeatAfterMs(claude)).toBe(50_000);
    expect(heartbeatAfterMs(codex)).toBe(50_000);
    expect(heartbeatAfterMs(resolveCapabilityRow({ agent: 'copilot' }))).toBe(50_000);
  });

  it("answers ten seconds before Cursor's 60 s cut, at the floor (T-069)", () => {
    expect(heartbeatAfterMs(resolveCapabilityRow({ agent: 'cursor' }))).toBe(50_000);
  });

  it('rises as soon as the installer states a timeout, including for unknown', () => {
    expect(heartbeatAfterMs(unknown, { toolTimeoutMs: 1_800_000 })).toBe(1_740_000);
  });

  it('takes a row heartbeat as written when no timeout is known', () => {
    const table: CapabilityRow[] = [
      {
        agent_id: 'unknown',
        display_name: 'MCP client',
        status: 'supported',
        support: 'base',
        match: { env: null, client_names: [] },
        tool_timeout_ms_default: null,
        per_server_timeout_field: null,
        images_in_results: false,
        stop_hook: false,
        subagent_stop_hook: false,
        session_identity: 'parent_pid',
        user_request_delivery: ['clipboard_focus'],
        cancellation_notifications: false,
        heartbeat_after_ms: 20_000,
      },
    ];
    expect(heartbeatAfterMs(resolveCapabilityRow({}, table))).toBe(20_000);
  });
});

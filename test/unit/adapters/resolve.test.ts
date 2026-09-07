/**
 * Identity resolution over the capability table (TECHNICAL-DESIGN §5.6, DD-09).
 *
 * The real table has empty `client_names` lists (A-08: nobody has measured them yet), so
 * step 2 of the resolution cannot be exercised against it. The synthetic table below is
 * the real one with two names planted, which is exactly the shape T-023 will produce.
 */
import { describe, expect, it } from 'vitest';

import {
  CAPABILITY_TABLE,
  capabilityRowForHello,
  resolveCapabilityRow,
  resolveRow,
  unknownRow,
  type CapabilityRow,
} from '../../../src/adapters';

/** The real table, with the client names the canary suite is expected to record. */
const MEASURED: readonly CapabilityRow[] = CAPABILITY_TABLE.map((row) =>
  row.agent_id === 'claude-code'
    ? { ...row, match: { ...row.match, client_names: ['claude-code', 'claude-ai'] } }
    : row,
);

describe('identity order', () => {
  it('takes HANDOFF_AGENT first: the installer knows what it wrote', () => {
    const row = resolveRow({ agent: 'codex', clientName: 'claude-code' }, MEASURED);
    expect(row.agent_id).toBe('codex');
  });

  it('falls back to clientInfo.name when HANDOFF_AGENT is absent', () => {
    expect(resolveRow({ clientName: 'claude-code' }, MEASURED).agent_id).toBe('claude-code');
    expect(resolveRow({ clientName: 'claude-ai' }, MEASURED).agent_id).toBe('claude-code');
  });

  it('falls back to the unknown row when neither is given', () => {
    expect(resolveRow({}, MEASURED).agent_id).toBe('unknown');
    expect(resolveRow({ agent: undefined, clientName: undefined }, MEASURED).agent_id).toBe(
      'unknown',
    );
  });

  it('resolves an env value that is not in the table to unknown', () => {
    expect(resolveRow({ agent: 'aider' }, MEASURED).agent_id).toBe('unknown');
    expect(resolveRow({ agent: 'claude' }, MEASURED).agent_id).toBe('unknown');
  });

  it('still tries the handshake when HANDOFF_AGENT names no row', () => {
    const row = resolveRow({ agent: 'claude-code-2', clientName: 'claude-code' }, MEASURED);
    expect(row.agent_id).toBe('claude-code');
  });

  it('treats a blank HANDOFF_AGENT as unset', () => {
    expect(resolveRow({ agent: '   ', clientName: 'claude-code' }, MEASURED).agent_id).toBe(
      'claude-code',
    );
  });

  it('compares names without case, because A-08 is not documented', () => {
    expect(resolveRow({ agent: 'Claude-Code' }, MEASURED).agent_id).toBe('claude-code');
    expect(resolveRow({ clientName: ' Claude-Code ' }, MEASURED).agent_id).toBe('claude-code');
  });

  it('never selects the unknown row by name: its match.env is null', () => {
    expect(
      CAPABILITY_TABLE.every((row) => row.agent_id !== 'unknown' || row.match.env === null),
    ).toBe(true);
    expect(resolveRow({ agent: 'unknown' }, MEASURED).agent_id).toBe('unknown');
  });

  it('resolves every shipped and planned agent by its own env value', () => {
    for (const row of CAPABILITY_TABLE) {
      if (row.match.env === null) continue;
      expect(resolveRow({ agent: row.match.env }).agent_id).toBe(row.agent_id);
    }
  });
});

describe('null fields fall back to the unknown row', () => {
  const unknown = unknownRow();

  it('gives a planned adapter the base behaviour of the unknown row', () => {
    const cursor = resolveCapabilityRow({ agent: 'cursor' });
    expect(cursor.agent_id).toBe('cursor');
    expect(cursor.images_in_results).toBe(unknown.images_in_results);
    expect(cursor.stop_hook).toBe(unknown.stop_hook);
    expect(cursor.subagent_stop_hook).toBe(unknown.subagent_stop_hook);
    expect(cursor.user_request_delivery).toEqual(unknown.user_request_delivery);
    expect(cursor.cancellation_notifications).toBe(unknown.cancellation_notifications);
    expect(cursor.heartbeat_after_ms).toBe(50_000);
  });

  it('keeps what a planned row already measured', () => {
    const codex = resolveCapabilityRow({ agent: 'codex' });
    expect(codex.stop_hook).toBe(false);
    expect(codex.subagent_stop_hook).toBe(false);
    expect(codex.user_request_delivery).toEqual(['clipboard_focus']);
    expect(codex.images_in_results).toBe(false);
  });

  it('keeps every value a supported row measured', () => {
    const claude = resolveCapabilityRow({ agent: 'claude-code' });
    expect(claude.images_in_results).toBe(true);
    expect(claude.stop_hook).toBe(true);
    expect(claude.subagent_stop_hook).toBe(true);
    expect(claude.cancellation_notifications).toBe(true);
    expect(claude.user_request_delivery).toEqual(['clipboard_focus', 'stop_hook']);
    expect(claude.per_server_timeout_field).toBe('timeout');
  });

  it('inherits the heartbeat of the unknown row on every agent', () => {
    for (const row of CAPABILITY_TABLE) {
      expect(resolveCapabilityRow({ agent: row.match.env ?? undefined }).heartbeat_after_ms).toBe(
        50_000,
      );
    }
  });

  it('leaves the two fields the unknown row cannot fill as null', () => {
    const resolved = resolveCapabilityRow({ agent: 'cursor' });
    expect(resolved.tool_timeout_ms_default).toBeNull();
    expect(resolved.per_server_timeout_field).toBeNull();
  });

  it('refuses a table whose unknown row is itself incomplete', () => {
    const broken = CAPABILITY_TABLE.map((row) =>
      row.agent_id === 'unknown' ? { ...row, images_in_results: null } : row,
    );
    expect(() => resolveCapabilityRow({ agent: 'cursor' }, broken)).toThrow(/images_in_results/u);
  });

  it('refuses a table with no unknown row at all', () => {
    const broken = CAPABILITY_TABLE.filter((row) => row.agent_id !== 'unknown');
    expect(() => resolveCapabilityRow({}, broken)).toThrow(/unknown row/u);
  });
});

describe('the hello projection', () => {
  it('carries the six fields of the golden register fixture and nothing else', () => {
    const hello = capabilityRowForHello(resolveCapabilityRow({ agent: 'claude-code' }), 1_800_000);
    expect(Object.keys(hello).sort()).toEqual([
      'agent_id',
      'display_name',
      'images_in_results',
      'stop_hook',
      'support',
      'tool_timeout_ms',
    ]);
  });

  it('sends the timeout already resolved, so the app owns no agent fact (ADPT-03)', () => {
    const row = resolveCapabilityRow({ agent: 'codex' });
    expect(capabilityRowForHello(row, null).tool_timeout_ms).toBeNull();
    expect(capabilityRowForHello(row, 600_000).tool_timeout_ms).toBe(600_000);
  });
});

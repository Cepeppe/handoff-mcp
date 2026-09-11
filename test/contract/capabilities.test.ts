/**
 * Contract test for the capability table (TECHNICAL-DESIGN §5.6).
 *
 * Two contracts meet here. The file must satisfy its own schema — the acceptance criterion
 * of T-015 — and the row the server resolves must satisfy the *other* schema, the
 * `capability_row` of `protocol/channel/channel.v1.schema.json`, because §5.6 says the
 * resolved row travels to the app in `hello`. A table that validates locally and produces
 * a `hello` the app rejects would only fail at the first real session.
 *
 * The rows are transcribed from the §5.6 excerpt and asserted field by field: the excerpt
 * is normative (§1.3) and the table is the one place where an agent fact is stated, so a
 * typo here is a wrong answer everywhere. The mutation block exists because a fixture
 * suite passes silently against a validator that accepts everything.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';
import type { AnySchema, ErrorObject, ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';

import {
  CAPABILITIES_VERSION,
  CAPABILITY_TABLE,
  capabilityRowForHello,
  resolveCapabilityRow,
  resolveRow,
  UNKNOWN_AGENT_ID,
} from '../../src/adapters';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TABLE_FILE = join(ROOT, 'src', 'adapters', 'capabilities.json');

const BASE = 'https://raw.githubusercontent.com/Cepeppe/handoff-mcp/main/';
const CHANNEL_ID = `${BASE}protocol/channel/channel.v1.schema.json`;

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function explain(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`).join('; ');
}

const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
// The channel schema refers to the three public schemas, so they have to be registered too.
for (const name of ['handoff-spec', 'handoff-outcome', 'handoff-runbook']) {
  ajv.addSchema(readJson(join(ROOT, 'schemas', `${name}.v1.schema.json`)) as AnySchema);
}
ajv.addSchema(readJson(join(ROOT, 'protocol', 'channel', 'channel.v1.schema.json')) as AnySchema);

const validateTable: ValidateFunction = ajv.compile(
  readJson(join(ROOT, 'src', 'adapters', 'capabilities.schema.json')) as AnySchema,
);

const validateHelloRow = ajv.getSchema(`${CHANNEL_ID}#/$defs/capability_row`);
if (!validateHelloRow) throw new Error('capability_row is not defined in the channel schema');

/** The agent ids of §5.6, in the committed adapter order of ADPT-06, `unknown` last. */
const AGENT_IDS = ['claude-code', 'codex', 'cursor', 'copilot', 'opencode', 'unknown'];

describe('capabilities.json', () => {
  it('validates against capabilities.schema.json', () => {
    const ok = validateTable(readJson(TABLE_FILE));
    expect(explain(validateTable.errors)).toBe('');
    expect(ok).toBe(true);
  });

  it('is the file the server compiled in', () => {
    const file = readJson(TABLE_FILE) as { capabilities_version: number; rows: unknown };
    expect(file.capabilities_version).toBe(CAPABILITIES_VERSION);
    expect(file.rows).toEqual(CAPABILITY_TABLE);
  });

  it('carries the six rows of §5.6 in the committed order', () => {
    expect(CAPABILITY_TABLE.map((row) => row.agent_id)).toEqual(AGENT_IDS);
  });

  it('has exactly one unknown row, and it is supported at base level', () => {
    const unknown = CAPABILITY_TABLE.filter((row) => row.agent_id === UNKNOWN_AGENT_ID);
    expect(unknown).toHaveLength(1);
    expect(unknown[0]?.status).toBe('supported');
    expect(unknown[0]?.support).toBe('base');
  });

  it('states the claude-code row as §5.6 prints it', () => {
    expect(CAPABILITY_TABLE.find((row) => row.agent_id === 'claude-code')).toEqual({
      agent_id: 'claude-code',
      display_name: 'Claude Code',
      status: 'supported',
      support: 'full',
      match: { env: 'claude-code', client_names: ['claude-code'] },
      tool_timeout_ms_default: null,
      per_server_timeout_field: 'timeout',
      images_in_results: true,
      stop_hook: true,
      subagent_stop_hook: true,
      session_identity: 'parent_pid',
      user_request_delivery: ['clipboard_focus', 'stop_hook'],
      cancellation_notifications: true,
      heartbeat_after_ms: null,
    });
  });

  it('states the unknown row as §5.6 prints it, heartbeat included', () => {
    expect(CAPABILITY_TABLE.find((row) => row.agent_id === UNKNOWN_AGENT_ID)).toEqual({
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
      heartbeat_after_ms: 50000,
    });
  });

  it('states the codex row as the T-066 canary measured it', () => {
    // Codex 0.153.4, 2026-09-10, `test/canary/agents/codex` and `docs/agent-facts.md`: no
    // end-of-turn hook that `codex exec` runs, images reach the model, the per-server field is
    // `tool_timeout_sec` in seconds, a timed-out call is abandoned rather than cancelled, and
    // the default timeout is only bounded from below (a 120 s call was not cut).
    expect(CAPABILITY_TABLE.find((row) => row.agent_id === 'codex')).toEqual({
      agent_id: 'codex',
      display_name: 'Codex CLI',
      status: 'supported',
      support: 'base',
      match: { env: 'codex', client_names: ['codex-mcp-client'] },
      tool_timeout_ms_default: null,
      per_server_timeout_field: 'tool_timeout_sec',
      images_in_results: true,
      stop_hook: false,
      subagent_stop_hook: false,
      session_identity: 'parent_pid',
      user_request_delivery: ['clipboard_focus'],
      cancellation_notifications: false,
      heartbeat_after_ms: null,
    });
  });

  it('states the opencode row as the T-074 canary measured it', () => {
    // OpenCode 1.18.29, 2026-09-11, `test/canary/agents/opencode` and `docs/agent-facts.md`: no
    // end-of-turn hook to register, images reach a model that reads them, the per-server field
    // is `timeout` in milliseconds, a timed-out call is cancelled (the MCP SDK's own request
    // timeout), and the default is a measured 60 s rather than a lower bound.
    expect(CAPABILITY_TABLE.find((row) => row.agent_id === 'opencode')).toEqual({
      agent_id: 'opencode',
      display_name: 'OpenCode',
      status: 'supported',
      support: 'base',
      match: { env: 'opencode', client_names: ['opencode'] },
      tool_timeout_ms_default: 60000,
      per_server_timeout_field: 'timeout',
      images_in_results: true,
      stop_hook: false,
      subagent_stop_hook: false,
      session_identity: 'parent_pid',
      user_request_delivery: ['clipboard_focus'],
      cancellation_notifications: true,
      heartbeat_after_ms: null,
    });
  });

  it('states the cursor row as the T-069 measurements found it', () => {
    // Cursor 3.20.10 and its CLI 2026.09.10-fd3934a, 2026-09-11, `test/canary/agents/cursor`
    // and `docs/agent-facts.md`: the editor sends cursor-vscode and the CLI sends Cursor,
    // neither reads a timeout from an MCP entry, the CLI cuts a call at the MCP SDK's 60 s with
    // a cancellation, images reach the model, and no hook of Cursor reaches this server's
    // hook. The row keys the editor surface on the chain; each session resolves its own.
    expect(CAPABILITY_TABLE.find((row) => row.agent_id === 'cursor')).toEqual({
      agent_id: 'cursor',
      display_name: 'Cursor',
      status: 'supported',
      support: 'base',
      match: { env: 'cursor', client_names: ['cursor-vscode', 'Cursor'] },
      tool_timeout_ms_default: 60000,
      per_server_timeout_field: null,
      images_in_results: true,
      stop_hook: false,
      subagent_stop_hook: false,
      session_identity: 'ancestor_chain:editor',
      user_request_delivery: ['clipboard_focus'],
      cancellation_notifications: true,
      heartbeat_after_ms: null,
    });
  });

  it('keeps every planned adapter at base support with unmeasured fields null', () => {
    const planned = CAPABILITY_TABLE.filter((row) => row.status === 'planned');
    expect(planned.map((row) => row.agent_id)).toEqual(['copilot']);
    for (const row of planned) {
      expect(row.support).toBe('base');
      expect(row.tool_timeout_ms_default).toBeNull();
      expect(row.images_in_results).toBeNull();
      expect(row.heartbeat_after_ms).toBeNull();
      expect(row.match.env).toBe(row.agent_id);
    }
  });

  it('records a client name only where the canary suite measured one (A-08)', () => {
    // `claude-code` is what Claude Code 2.1.263 sends in the `initialize` handshake (measured
    // on 2026-09-08), `codex-mcp-client` what Codex 0.153.4 sends (2026-09-10), `opencode`
    // what OpenCode 1.18.29 sends (2026-09-11), and Cursor's editor sends `cursor-vscode` and
    // its CLI `Cursor` (3.20.10 and 2026.09.10-fd3934a, 2026-09-11), all by `test/canary` and
    // written down in `docs/agent-facts.md`. Copilot has not shipped, so its list holds no guess.
    const measured: Readonly<Record<string, readonly string[]>> = {
      'claude-code': ['claude-code'],
      codex: ['codex-mcp-client'],
      cursor: ['cursor-vscode', 'Cursor'],
      opencode: ['opencode'],
    };
    for (const row of CAPABILITY_TABLE) {
      expect(row.match.client_names, row.agent_id).toEqual(measured[row.agent_id] ?? []);
    }
  });

  it('keeps each measured client name resolving to its own row without HANDOFF_AGENT', () => {
    // The point of measuring it (§5.6 step 2): an npm user who wrote the MCP entry by hand
    // gets the agent's row instead of `unknown`.
    expect(resolveRow({ clientName: 'claude-code' }).agent_id).toBe('claude-code');
    expect(resolveRow({ clientName: 'codex-mcp-client' }).agent_id).toBe('codex');
    expect(resolveRow({ clientName: 'opencode' }).agent_id).toBe('opencode');
    expect(resolveRow({ clientName: 'cursor-vscode' }).agent_id).toBe('cursor');
    expect(resolveRow({ clientName: 'Cursor' }).agent_id).toBe('cursor');
  });

  it('keys the editor-hosted agents on the ancestor chain (ADPT-02, R-12)', () => {
    const identity = Object.fromEntries(
      CAPABILITY_TABLE.map((row) => [row.agent_id, row.session_identity]),
    );
    expect(identity).toEqual({
      'claude-code': 'parent_pid',
      codex: 'parent_pid',
      cursor: 'ancestor_chain:editor',
      copilot: 'ancestor_chain:editor',
      opencode: 'parent_pid',
      unknown: 'parent_pid',
    });
  });
});

describe('the schema refuses a broken row', () => {
  /** Applies one mutation to the first row of a fresh copy and returns what ajv said. */
  function rejects(mutate: (row: Record<string, unknown>) => void): string {
    const file = readJson(TABLE_FILE) as { rows: Record<string, unknown>[] };
    const row = file.rows[0];
    if (row === undefined) throw new Error('the table has no rows');
    mutate(row);
    expect(validateTable(file)).toBe(false);
    return explain(validateTable.errors);
  }

  it('refuses a missing column', () => {
    const message = rejects((row) => {
      Reflect.deleteProperty(row, 'stop_hook');
    });
    expect(message).toContain('stop_hook');
  });

  it('refuses an unknown column', () => {
    const message = rejects((row) => {
      row['images'] = true;
    });
    expect(message).toContain('additional');
  });

  it('refuses a support level nobody implements', () => {
    expect(
      rejects((row) => {
        row['support'] = 'partial';
      }),
    ).not.toBe('');
  });

  it('refuses a null session_identity', () => {
    expect(
      rejects((row) => {
        row['session_identity'] = null;
      }),
    ).not.toBe('');
  });

  it('refuses a zero timeout default', () => {
    expect(
      rejects((row) => {
        row['tool_timeout_ms_default'] = 0;
      }),
    ).not.toBe('');
  });

  it('refuses an agent id that is not a table key', () => {
    expect(
      rejects((row) => {
        row['agent_id'] = 'Claude Code';
      }),
    ).not.toBe('');
  });

  it('refuses a user_request_delivery the app cannot perform', () => {
    expect(
      rejects((row) => {
        row['user_request_delivery'] = ['email'];
      }),
    ).not.toBe('');
  });
});

describe('the resolved row is the object hello carries', () => {
  it('validates against capability_row of the channel schema, for every agent', () => {
    for (const row of CAPABILITY_TABLE) {
      const resolved = resolveCapabilityRow({ agent: row.match.env ?? undefined });
      const hello = capabilityRowForHello(resolved, 1_800_000);
      expect(validateHelloRow(hello), explain(validateHelloRow.errors)).toBe(true);
    }
  });

  it('validates with the session identity an editor-hosted session adds to it (T-069)', () => {
    const resolved = resolveCapabilityRow({ agent: 'cursor' });
    const hello = capabilityRowForHello(resolved, 60_000, 'ancestor_chain:editor');
    expect(validateHelloRow(hello), explain(validateHelloRow.errors)).toBe(true);
    expect(hello.session_identity).toBe('ancestor_chain:editor');
  });

  it('validates with a null timeout, the case where the heartbeat falls back to 50 s', () => {
    const hello = capabilityRowForHello(resolveCapabilityRow({}), null);
    expect(validateHelloRow(hello), explain(validateHelloRow.errors)).toBe(true);
    expect(hello).toEqual({
      agent_id: 'unknown',
      display_name: 'MCP client',
      support: 'base',
      images_in_results: false,
      stop_hook: false,
      tool_timeout_ms: null,
    });
  });

  it('matches the golden hello of fixtures/channel/f01-register.jsonl', () => {
    const first = readFileSync(join(ROOT, 'fixtures', 'channel', 'f01-register.jsonl'), 'utf8')
      .split(/\r?\n/)
      .at(0);
    if (first === undefined) throw new Error('the register fixture is empty');
    const golden = (JSON.parse(first) as { msg: { params: { capability_row: unknown } } }).msg
      .params.capability_row;
    const resolved = resolveCapabilityRow({ agent: 'claude-code' });
    expect(capabilityRowForHello(resolved, 1_800_000)).toEqual(golden);
  });
});

/**
 * The deterministic half of the OpenCode canary (T-074, TECHNICAL-DESIGN §11.5).
 *
 * An OpenCode run happens only on demand. What is tested here is what decides whether such a
 * run means anything: the command line, the inline configuration that declares our server, the
 * environment that keeps the user's own configuration out, the way OpenCode's JSON events
 * become the shared transcript, how `opencode` is found, and the scenario set.
 */
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CAPABILITY_TABLE } from '../../../src/adapters';
import { parseScenario } from '../../fake-app';
import { CODEX_SCENARIOS } from '../../canary/agents/codex/index.ts';
import { DEGRADED_PATH_SCRIPT } from '../../canary/agents/codex/degraded.ts';
import { OPENCODE_DEGRADED_PATH_SCRIPT } from '../../canary/agents/opencode/degraded.ts';
import { OPENCODE_SCENARIOS } from '../../canary/agents/opencode/index.ts';
import {
  NPM_OPENCODE_LAUNCHER,
  opencodeCommandFrom,
  opencodeToolName,
  parseOpenCodeEvents,
} from '../../canary/agents/opencode/runner.ts';
import { opencodeRow } from '../../canary/agents/opencode/scenario.ts';
import {
  OPENCODE_DEFAULT_MODEL,
  OPENCODE_ISOLATION_ENV,
  OPENCODE_SESSION_TITLE,
  opencodeArgs,
  opencodeChildEnvironment,
  opencodeConfig,
  opencodeDeleteArgs,
  type OpenCodeWorkspaceOptions,
} from '../../canary/agents/opencode/workspace.ts';
import { SCENARIOS } from '../../canary/scenarios/index.ts';

const workspace: OpenCodeWorkspaceOptions = {
  serverBundle: 'C:\\repo\\dist\\handoff-mcp.cjs',
  home: 'C:\\temp\\run\\home',
  project: 'C:\\temp\\run\\project',
  configHome: 'C:\\temp\\run\\config',
};

describe('the opencode command line', () => {
  const args = opencodeArgs({ prompt: 'do the thing', model: OPENCODE_DEFAULT_MODEL });

  it('is opencode run printing JSON events, with the prompt last', () => {
    expect(args[0]).toBe('run');
    expect(args[args.indexOf('--format') + 1]).toBe('json');
    expect(args.at(-1)).toBe('do the thing');
  });

  it('loads no external plugin and keeps the prompt out of the session title', () => {
    expect(args).toContain('--pure');
    expect(args[args.indexOf('--title') + 1]).toBe(OPENCODE_SESSION_TITLE);
  });

  it('runs on the pinned model, a free one, so a canary spends nothing', () => {
    expect(args[args.indexOf('-m') + 1]).toBe(OPENCODE_DEFAULT_MODEL);
    expect(OPENCODE_DEFAULT_MODEL).toMatch(/^openrouter\/.+:free$/u);
  });

  it('deletes the run session by its id, since opencode run has no ephemeral mode', () => {
    expect(opencodeDeleteArgs('ses_1')).toEqual(['session', 'delete', 'ses_1']);
  });
});

describe('the inline configuration that declares our server', () => {
  it('is one local server: node, the bundle and serve, with the five canary names', () => {
    expect(opencodeConfig(workspace)).toEqual({
      mcp: {
        handoff: {
          type: 'local',
          command: [process.execPath, 'C:\\repo\\dist\\handoff-mcp.cjs', 'serve'],
          environment: {
            HANDOFF_AGENT: 'opencode',
            HANDOFF_HOME: 'C:\\temp\\run\\home',
            HANDOFF_CANARY: '1',
            HANDOFF_PROBE: 'canary',
            HANDOFF_PROBE_TOKEN: 'canary',
          },
        },
      },
    });
  });

  it('writes the timeout only when a scenario measures it, and in milliseconds', () => {
    expect(opencodeConfig(workspace).mcp['handoff']).not.toHaveProperty('timeout');
    expect(opencodeConfig({ ...workspace, timeoutMs: 20_000 }).mcp['handoff']?.timeout).toBe(
      20_000,
    );
  });
});

describe('the environment of the opencode child', () => {
  const env = opencodeChildEnvironment(workspace, {
    CLAUDECODE: '1',
    PATH: '/usr/bin',
    PWD: '/c/repo',
    HANDOFF_HOME: 'C:/real/.handoff',
    XDG_CONFIG_HOME: 'C:/real/.config',
    OPENCODE_CONFIG: 'C:/mine/opencode.json',
    OPENCODE_CONFIG_DIR: 'C:/mine',
    opencode_permission: '{"*":"allow"}',
    UNSET: undefined,
  });

  it('declares our server inline, so nothing is written where OpenCode reads', () => {
    expect(JSON.parse(env['OPENCODE_CONFIG_CONTENT'] ?? '')).toEqual(opencodeConfig(workspace));
  });

  it('moves the global configuration to the run folder, which keeps the user servers out', () => {
    expect(env['XDG_CONFIG_HOME']).toBe(workspace.configHome);
  });

  it('points PWD at the run folder, because OpenCode starts its servers from PWD', () => {
    // Measured: with PWD inherited from the harness's shell, the server started in the
    // checkout although the process's working directory was the run's folder (A-24).
    expect(env['PWD']).toBe(workspace.project);
  });

  it('drops every OPENCODE_ variable of the parent and sets the isolation switches', () => {
    expect(env).not.toHaveProperty('OPENCODE_CONFIG');
    expect(env).not.toHaveProperty('OPENCODE_CONFIG_DIR');
    expect(env).not.toHaveProperty('opencode_permission');
    expect(OPENCODE_ISOLATION_ENV).toMatchObject({
      OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      OPENCODE_DISABLE_CLAUDE_CODE: '1',
      OPENCODE_DISABLE_SHARE: '1',
    });
    for (const [name, value] of Object.entries(OPENCODE_ISOLATION_ENV)) {
      expect(env[name], name).toBe(value);
    }
  });

  it('drops CLAUDECODE, keeps the rest, and points HANDOFF_HOME at the run folder', () => {
    // OpenCode hands its whole environment to the servers it starts (measured), so what is
    // left here is what the server sees.
    expect(env).not.toHaveProperty('CLAUDECODE');
    expect(env).not.toHaveProperty('UNSET');
    expect(env['PATH']).toBe('/usr/bin');
    expect(env['HANDOFF_HOME']).toBe(workspace.home);
  });
});

describe('the OpenCode JSON transcript', () => {
  const at = Date.UTC(2026, 8, 11, 1, 0, 0);
  const lines = [
    '{"type":"step_start","timestamp":1,"sessionID":"ses_a","part":{"type":"step-start"}}',
    '{"type":"tool_use","timestamp":2,"sessionID":"ses_a","part":{"type":"tool","tool":"handoff_handoff_runbooks","callID":"call_1","state":{"status":"completed","input":{"where":"w","goal":"g"},"output":"{\\"runbooks\\":[]}","time":{"start":10,"end":12}}}}',
    '{"type":"tool_use","timestamp":3,"sessionID":"ses_a","part":{"type":"tool","tool":"handoff_sleep_ms","callID":"call_2","state":{"status":"error","input":{"ms":120000},"error":"MCP error -32001: Request timed out","time":{"start":100,"end":20094}}}}',
    '{"type":"step_finish","timestamp":4,"sessionID":"ses_a","part":{"type":"step-finish","reason":"tool-calls","tokens":{"input":100,"output":5},"cost":0}}',
    '{"type":"text","timestamp":5,"sessionID":"ses_a","part":{"type":"text","text":"DONE"}}',
    '{"type":"step_finish","timestamp":6,"sessionID":"ses_a","part":{"type":"step-finish","reason":"stop","tokens":{"input":120,"output":1},"cost":0.001}}',
    'not json',
  ].map((line, index) => ({ line, at: at + index * 1000 }));
  const parsed = parseOpenCodeEvents(lines);

  it('keeps every JSON event, stamped with the instant it arrived, and the session', () => {
    expect(parsed.transcript).toHaveLength(6);
    expect(parsed.transcript[0]?.['received_at']).toBe('2026-09-11T01:00:00.000Z');
    expect(parsed.sessionId).toBe('ses_a');
  });

  it('names our tools the way Claude Code names them, and leaves a built-in tool alone', () => {
    expect(parsed.toolUses.map((use) => use.name)).toEqual([
      'mcp__handoff__handoff_runbooks',
      'mcp__handoff__sleep_ms',
    ]);
    expect(parsed.toolUses[0]?.input).toEqual({ where: 'w', goal: 'g' });
    expect(opencodeToolName('bash')).toBe('bash');
  });

  it('gives each call its output, and a failed one its error', () => {
    expect(parsed.toolResults[0]).toEqual({
      tool_use_id: 'call_1',
      isError: false,
      text: '{"runbooks":[]}',
    });
    expect(parsed.toolResults[1]).toEqual({
      tool_use_id: 'call_2',
      isError: true,
      text: 'MCP error -32001: Request timed out',
    });
  });

  it('makes a result from the last text once a step has finished, with tokens and price', () => {
    expect(parsed.result).toMatchObject({
      type: 'result',
      is_error: false,
      result: 'DONE',
      num_turns: 2,
      total_cost_usd: 0.001,
      usage: { input_tokens: 220, output_tokens: 6 },
    });
  });

  it('has no result when no step finished, and an error result with the provider message', () => {
    expect(
      parseOpenCodeEvents([{ line: '{"type":"step_start","sessionID":"s","part":{}}' }]).result,
    ).toBeUndefined();
    const refused = parseOpenCodeEvents([
      {
        line: '{"type":"error","sessionID":"s","error":{"name":"APIError","data":{"message":"rate-limited upstream"}}}',
      },
    ]);
    expect(refused.result?.is_error).toBe(true);
    expect(refused.result?.result).toBe('rate-limited upstream');
    expect(refused.sessionId).toBe('s');
  });
});

describe('finding opencode', () => {
  const platform = (windows: boolean, present: readonly string[] = []) => ({
    windows,
    exists: (path: string) => present.includes(path),
  });

  it('starts a native executable directly', () => {
    expect(opencodeCommandFrom(['C:/OpenCode/opencode.exe'], platform(true))).toEqual({
      command: 'C:/OpenCode/opencode.exe',
      prefix: [],
      shell: false,
    });
  });

  it('bypasses the npm shim for the executable beside it, so no shell quotes the prompt', () => {
    // Forward slashes: a Windows path with backslashes does not parse on the macOS leg (T-039).
    const launcher = join('C:/npm', ...NPM_OPENCODE_LAUNCHER);
    expect(
      opencodeCommandFrom(['C:/npm/opencode', 'C:/npm/opencode.cmd'], platform(true, [launcher])),
    ).toEqual({ command: launcher, prefix: [], shell: false });
  });

  it('falls back to the shell only when that executable is not beside the shim', () => {
    expect(opencodeCommandFrom(['C:/npm/opencode.cmd'], platform(true))).toEqual({
      command: 'C:/npm/opencode.cmd',
      prefix: [],
      shell: true,
    });
  });

  it('starts an extensionless binary elsewhere, and asks PATH when nothing was found', () => {
    expect(opencodeCommandFrom(['/usr/local/bin/opencode'], platform(false)).command).toBe(
      '/usr/local/bin/opencode',
    );
    expect(opencodeCommandFrom([], platform(true))).toEqual({
      command: 'opencode',
      prefix: [],
      shell: false,
    });
  });
});

describe('the OpenCode scenario set', () => {
  it('has ids of its own, prefixed opencode-, unique across every agent', () => {
    const ids = [...SCENARIOS, ...CODEX_SCENARIOS, ...OPENCODE_SCENARIOS].map(
      (scenario) => scenario.id,
    );
    expect(new Set(ids).size).toBe(ids.length);
    for (const scenario of OPENCODE_SCENARIOS) expect(scenario.id).toMatch(/^opencode-/u);
  });

  it('gives each a prompt naming our server, what it covers, and a bounded run', () => {
    for (const scenario of OPENCODE_SCENARIOS) {
      expect(scenario.options.prompt, scenario.id).toContain('MCP server handoff');
      expect(scenario.covers.length, scenario.id).toBeGreaterThan(0);
      expect(scenario.options.timeoutMs ?? 300_000, scenario.id).toBeLessThanOrEqual(330_000);
    }
  });

  it('covers E2E-8, the degraded path and the facts the opencode row is made of', () => {
    const covered = new Set(OPENCODE_SCENARIOS.flatMap((scenario) => scenario.covers));
    for (const id of ['E2E-8', 'FM-03', 'FM-04', 'A-04', 'A-07', 'A-08', 'A-09']) {
      expect(covered.has(id), id).toBe(true);
    }
  });

  it('compares against the opencode row the server bundles, not a copy of it', () => {
    const row = CAPABILITY_TABLE.find((candidate) => candidate.agent_id === 'opencode');
    expect(opencodeRow()).toEqual({
      client_names: row?.match.client_names,
      images_in_results: row?.images_in_results,
      stop_hook: row?.stop_hook,
      cancellation_notifications: row?.cancellation_notifications,
      tool_timeout_ms_default: row?.tool_timeout_ms_default,
    });
  });

  it('drives the overlay with the Codex script, under a name of its own', () => {
    expect(OPENCODE_DEGRADED_PATH_SCRIPT.name).toBe('opencode-degraded-path');
    expect(OPENCODE_DEGRADED_PATH_SCRIPT.actions).toEqual(DEGRADED_PATH_SCRIPT.actions);
    const scenario = parseScenario(
      {
        scenario: OPENCODE_DEGRADED_PATH_SCRIPT.name,
        why: OPENCODE_DEGRADED_PATH_SCRIPT.why,
        actions: OPENCODE_DEGRADED_PATH_SCRIPT.actions,
      },
      OPENCODE_DEGRADED_PATH_SCRIPT.name,
    );
    expect(scenario.send).toEqual([
      'onOpen',
      'awaitMessage',
      'onResume',
      'emitEvent',
      'onResume',
      'emitEvent',
    ]);
  });
});

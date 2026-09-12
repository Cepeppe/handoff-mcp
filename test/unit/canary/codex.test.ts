/**
 * The deterministic half of the Codex canary (T-066, TECHNICAL-DESIGN §11.5).
 *
 * A Codex run costs real usage and happens only on demand. What is tested here is what
 * decides whether such a run means anything: the command line and its isolation flags, the
 * way our server is declared through `-c`, how Codex's JSONL becomes the shared transcript,
 * how `codex` is found, the `--agent` parser, and the overlay script of the degraded path —
 * down to the instruction phrases it tells the two variants apart by.
 */
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CAPABILITY_TABLE } from '../../../src/adapters';
import { INSTRUCTIONS } from '../../../src/mcp/generated/contract';
import { channelViolation, parseScenario } from '../../fake-app';
import {
  CONFIRMED_OUTCOME,
  DEFERRED_OUTCOME,
  DEGRADED_PATH_SCRIPT,
  HOOK_PHRASE,
  NO_HOOK_PHRASE,
} from '../../canary/agents/codex/degraded.ts';
import { CODEX_SCENARIOS } from '../../canary/agents/codex/index.ts';
import {
  NPM_CODEX_LAUNCHER,
  codexCommandFrom,
  parseCodexEvents,
} from '../../canary/agents/codex/runner.ts';
import { codexRow, samePath } from '../../canary/agents/codex/scenario.ts';
import {
  CODEX_APPROVAL_MODE,
  CODEX_DEFAULT_MODEL,
  CODEX_DISABLED_FEATURES,
  codexArgs,
  codexChildEnvironment,
  codexServerEnv,
  tomlInlineTable,
  tomlString,
  type CodexWorkspaceOptions,
} from '../../canary/agents/codex/workspace.ts';
import { CANARY_AGENTS, parseCanaryArguments } from '../../canary/cli.ts';
import { SCENARIOS } from '../../canary/scenarios/index.ts';

const workspace: CodexWorkspaceOptions = {
  serverBundle: 'C:\\repo\\dist\\handoff-mcp.cjs',
  home: 'C:\\temp\\run\\home',
  project: 'C:\\temp\\run\\project',
};

const args = codexArgs({ prompt: 'do the thing', model: CODEX_DEFAULT_MODEL, workspace });

/** The values given to `-c`, in order. */
function overrides(line: readonly string[]): string[] {
  return line.flatMap((argument, index) => (argument === '-c' ? [line[index + 1] ?? ''] : []));
}

describe('the codex command line', () => {
  it('is codex exec printing JSON events, with the prompt last', () => {
    expect(args.slice(0, 2)).toEqual(['exec', '--json']);
    expect(args.at(-1)).toBe('do the thing');
  });

  it('never omits --ignore-user-config, which keeps the user own MCP servers out', () => {
    // A -c override of mcp_servers merges with the user's servers; only this flag drops them.
    expect(args).toContain('--ignore-user-config');
    expect(
      codexArgs({ prompt: 'x', model: 'm', workspace: { ...workspace, toolTimeoutSec: 5 } }),
    ).toContain('--ignore-user-config');
  });

  it('leaves no session behind and runs outside a repository', () => {
    expect(args).toContain('--ephemeral');
    expect(args).toContain('--skip-git-repo-check');
  });

  it('turns off apps and plugins, the roads to the user accounts, and the tools nobody measures', () => {
    expect(CODEX_DISABLED_FEATURES).toContain('apps');
    expect(CODEX_DISABLED_FEATURES).toContain('plugins');
    for (const feature of CODEX_DISABLED_FEATURES) {
      const at = args.findIndex(
        (argument, index) => argument === '--disable' && args[index + 1] === feature,
      );
      expect(at, feature).toBeGreaterThan(-1);
    }
  });

  it('starts Codex in the project folder, read-only, on the pinned model', () => {
    expect(args[args.indexOf('-C') + 1]).toBe(workspace.project);
    expect(args[args.indexOf('-s') + 1]).toBe('read-only');
    expect(args[args.indexOf('-m') + 1]).toBe(CODEX_DEFAULT_MODEL);
    expect(overrides(args)).toContain('model_reasoning_effort="low"');
  });

  it('declares our server as node, the bundle and serve, and approves its tools', () => {
    const values = overrides(args);
    expect(values).toContain(`mcp_servers.handoff.command=${JSON.stringify(process.execPath)}`);
    expect(values).toContain(
      'mcp_servers.handoff.args=["C:\\\\repo\\\\dist\\\\handoff-mcp.cjs","serve"]',
    );
    // Without it, codex exec refuses every tool that is not annotated read-only.
    expect(CODEX_APPROVAL_MODE).toBe('approve');
    expect(values).toContain('mcp_servers.handoff.default_tools_approval_mode="approve"');
  });

  it('writes tool_timeout_sec only when a scenario measures it, and in seconds', () => {
    expect(overrides(args).some((value) => value.includes('tool_timeout_sec'))).toBe(false);
    const measured = codexArgs({
      prompt: 'x',
      model: 'm',
      workspace: { ...workspace, toolTimeoutSec: 20 },
    });
    expect(overrides(measured)).toContain('mcp_servers.handoff.tool_timeout_sec=20');
  });
});

describe('the env block of our entry', () => {
  it('carries the codex id, the isolated home, the canary switch and the A-23 pair', () => {
    expect(codexServerEnv(workspace)).toEqual({
      HANDOFF_AGENT: 'codex',
      HANDOFF_HOME: 'C:\\temp\\run\\home',
      HANDOFF_CANARY: '1',
      HANDOFF_PROBE: 'canary',
      HANDOFF_PROBE_TOKEN: 'canary',
    });
  });

  it('is a TOML inline table whose Windows paths keep their backslashes', () => {
    expect(tomlString('C:\\x')).toBe('"C:\\\\x"');
    expect(tomlString('say "hi"')).toBe('"say \\"hi\\""');
    expect(tomlInlineTable({ A: 'x', B: 'C:\\y' })).toBe('{A="x",B="C:\\\\y"}');
    expect(overrides(args)).toContain(
      `mcp_servers.handoff.env=${tomlInlineTable(codexServerEnv(workspace))}`,
    );
  });
});

describe('the environment of the codex child', () => {
  const env = codexChildEnvironment(workspace, {
    CLAUDECODE: '1',
    PATH: '/usr/bin',
    HANDOFF_HOME: 'C:/real/.handoff',
    UNSET: undefined,
  });

  it('drops CLAUDECODE and points HANDOFF_HOME at the run folder', () => {
    expect(env).not.toHaveProperty('CLAUDECODE');
    expect(env['HANDOFF_HOME']).toBe(workspace.home);
  });

  it('keeps the rest and drops what is unset', () => {
    expect(env['PATH']).toBe('/usr/bin');
    expect(env).not.toHaveProperty('UNSET');
  });
});

describe('the Codex JSONL transcript', () => {
  const at = Date.UTC(2026, 8, 10, 21, 0, 0);
  const lines = [
    '{"type":"thread.started","thread_id":"t"}',
    '{"type":"item.completed","item":{"id":"item_0","type":"error","message":"a warning"}}',
    '{"type":"turn.started"}',
    '{"type":"item.completed","item":{"id":"item_2","type":"mcp_tool_call","server":"handoff","tool":"handoff_runbooks","arguments":{"where":"w","goal":"g"},"result":{"content":[{"type":"text","text":"{\\"runbooks\\":[]}"}],"structured_content":{"runbooks":[]}},"error":null,"status":"completed"}}',
    '{"type":"item.completed","item":{"id":"item_3","type":"mcp_tool_call","server":"handoff","tool":"sleep_ms","arguments":{"ms":120000},"result":null,"error":{"message":"timed out awaiting tools/call after 20s"},"status":"failed"}}',
    '{"type":"item.completed","item":{"id":"item_4","type":"mcp_tool_call","server":"handoff","tool":"image_probe","arguments":{},"result":{"content":[{"type":"text","text":"one colour"},{"type":"image","data":"AAAA","mimeType":"image/png"}]},"error":null,"status":"completed"}}',
    '{"type":"item.completed","item":{"id":"item_5","type":"agent_message","text":"DONE"}}',
    '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":2}}',
    'Reading additional input from stdin...',
  ].map((line, index) => ({ line, at: at + index * 1000 }));
  const parsed = parseCodexEvents(lines);

  it('keeps every JSON event, stamped with the instant it arrived, and drops the rest', () => {
    expect(parsed.transcript).toHaveLength(8);
    expect(parsed.transcript[0]?.['received_at']).toBe('2026-09-10T21:00:00.000Z');
  });

  it('turns every mcp_tool_call into a tool use named the way Claude Code names it', () => {
    expect(parsed.toolUses.map((use) => use.name)).toEqual([
      'mcp__handoff__handoff_runbooks',
      'mcp__handoff__sleep_ms',
      'mcp__handoff__image_probe',
    ]);
    expect(parsed.toolUses[0]?.input).toEqual({ where: 'w', goal: 'g' });
  });

  it('gives each call its result text, an error its message, and an image block nothing', () => {
    expect(parsed.toolResults[0]).toEqual({
      tool_use_id: 'item_2',
      isError: false,
      text: '{"runbooks":[]}',
    });
    expect(parsed.toolResults[1]?.isError).toBe(true);
    expect(parsed.toolResults[1]?.text).toContain('timed out awaiting tools/call after 20s');
    expect(parsed.toolResults[2]?.text).toBe('one colour');
  });

  it('makes a result message from the last agent message once a turn has ended', () => {
    expect(parsed.result).toMatchObject({
      type: 'result',
      is_error: false,
      result: 'DONE',
      num_turns: 1,
      usage: { input_tokens: 10, output_tokens: 2 },
    });
  });

  it('has no result when no turn ended, and an error result when one failed', () => {
    expect(parseCodexEvents([{ line: '{"type":"thread.started"}' }]).result).toBeUndefined();
    expect(
      parseCodexEvents([{ line: '{"type":"turn.failed","error":{"message":"x"}}' }]).result
        ?.is_error,
    ).toBe(true);
  });
});

describe('finding codex', () => {
  const platform = (windows: boolean, present: readonly string[] = []) => ({
    windows,
    execPath: 'NODE',
    exists: (path: string) => present.includes(path),
  });

  it('starts the native executable directly', () => {
    expect(codexCommandFrom(['C:/Codex/bin/codex.exe'], platform(true))).toEqual({
      command: 'C:/Codex/bin/codex.exe',
      prefix: [],
      shell: false,
    });
  });

  it('bypasses an npm shim for its launcher, so no shell quotes the prompt', () => {
    // Forward slashes: a Windows path with backslashes does not parse on the macOS leg (T-039).
    const launcher = join('C:/npm', ...NPM_CODEX_LAUNCHER);
    expect(
      codexCommandFrom(['C:/npm/codex', 'C:/npm/codex.cmd'], platform(true, [launcher])),
    ).toEqual({ command: 'NODE', prefix: [launcher], shell: false });
  });

  it('falls back to the shell only when the launcher is not beside the shim', () => {
    expect(codexCommandFrom(['C:/npm/codex.cmd'], platform(true))).toEqual({
      command: 'C:/npm/codex.cmd',
      prefix: [],
      shell: true,
    });
  });

  it('runs a named JavaScript launcher with this Node, and an extensionless binary elsewhere', () => {
    expect(codexCommandFrom(['/opt/codex.js'], platform(false))).toEqual({
      command: 'NODE',
      prefix: ['/opt/codex.js'],
      shell: false,
    });
    expect(codexCommandFrom(['/usr/local/bin/codex'], platform(false)).command).toBe(
      '/usr/local/bin/codex',
    );
    expect(codexCommandFrom([], platform(true))).toEqual({
      command: 'codex',
      prefix: [],
      shell: false,
    });
  });
});

describe('the pnpm canary command line', () => {
  it('runs everything of every agent by default', () => {
    expect(parseCanaryArguments([])).toEqual({
      list: false,
      agent: undefined,
      wanted: [],
      error: undefined,
    });
  });

  it('keeps one agent with --agent, in either spelling, and ignores a bare --', () => {
    expect(parseCanaryArguments(['--agent', 'codex', 'codex-observe'])).toMatchObject({
      agent: 'codex',
      wanted: ['codex-observe'],
    });
    expect(parseCanaryArguments(['--agent=claude-code', '--', 'observe'])).toMatchObject({
      agent: 'claude-code',
      wanted: ['observe'],
    });
    expect(parseCanaryArguments(['--list']).list).toBe(true);
  });

  it('refuses an agent it cannot run, rather than running nothing', () => {
    expect(parseCanaryArguments(['--agent', 'gemini-cli']).error).toContain('gemini-cli');
    expect(parseCanaryArguments(['--agent']).error).toBeDefined();
    expect(CANARY_AGENTS).toEqual([
      'claude-code',
      'codex',
      'opencode',
      'cursor',
      'copilot',
      'kilo-code',
    ]);
  });
});

describe('the Codex scenario set', () => {
  it('has ids of its own, prefixed codex-, unique across both agents', () => {
    const ids = [...SCENARIOS, ...CODEX_SCENARIOS].map((scenario) => scenario.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const scenario of CODEX_SCENARIOS) expect(scenario.id).toMatch(/^codex-/u);
  });

  it('gives each a prompt naming our server, what it covers, and a bounded run', () => {
    for (const scenario of CODEX_SCENARIOS) {
      expect(scenario.options.prompt, scenario.id).toContain('MCP server handoff');
      expect(scenario.covers.length, scenario.id).toBeGreaterThan(0);
      expect(scenario.options.timeoutMs ?? 300_000, scenario.id).toBeLessThanOrEqual(330_000);
    }
  });

  it('covers E2E-8, the degraded path and the facts the codex row is made of', () => {
    const covered = new Set(CODEX_SCENARIOS.flatMap((scenario) => scenario.covers));
    for (const id of ['E2E-8', 'FM-03', 'FM-04', 'A-04', 'A-07', 'A-08', 'A-09']) {
      expect(covered.has(id), id).toBe(true);
    }
  });

  it('compares against the codex row the server bundles, not a copy of it', () => {
    const row = CAPABILITY_TABLE.find((candidate) => candidate.agent_id === 'codex');
    expect(codexRow()).toEqual({
      client_names: row?.match.client_names,
      images_in_results: row?.images_in_results,
      stop_hook: row?.stop_hook,
      cancellation_notifications: row?.cancellation_notifications,
    });
  });

  it('compares folders the way the file system does', () => {
    expect(samePath('C:/Temp/Run/project/', 'c:/temp/run/PROJECT', true)).toBe(true);
    expect(samePath('/tmp/a', '/tmp/A', false)).toBe(false);
    expect(samePath('', '/tmp/a')).toBe(false);
  });
});

describe('the overlay script of the degraded path', () => {
  it('is a scenario fake-app accepts, in the order the flow needs', () => {
    const scenario = parseScenario(
      {
        scenario: DEGRADED_PATH_SCRIPT.name,
        why: DEGRADED_PATH_SCRIPT.why,
        actions: DEGRADED_PATH_SCRIPT.actions,
      },
      DEGRADED_PATH_SCRIPT.name,
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

  it('sends outcomes the channel schema accepts once the handoff id is filled in', () => {
    for (const outcome of [DEFERRED_OUTCOME, CONFIRMED_OUTCOME]) {
      const message = {
        jsonrpc: '2.0',
        method: 'handoff.event',
        params: {
          call_id: 'call_2q7m8r1t',
          handoff_id: 'hf_7k3m9p2q4r',
          outcome: { ...outcome, handoff_id: 'hf_7k3m9p2q4r' },
        },
      };
      expect(channelViolation(message), outcome.status).toBeUndefined();
    }
  });

  it('tells the two instruction variants apart by phrases only one of them carries', () => {
    expect(INSTRUCTIONS.deferred.no_stop_hook).toContain(NO_HOOK_PHRASE);
    expect(INSTRUCTIONS.deferred.no_stop_hook).not.toContain(HOOK_PHRASE);
    expect(INSTRUCTIONS.deferred.stop_hook).toContain(HOOK_PHRASE);
    expect(INSTRUCTIONS.deferred.stop_hook).not.toContain(NO_HOOK_PHRASE);
  });
});

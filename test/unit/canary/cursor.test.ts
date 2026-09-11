/**
 * The deterministic half of the Cursor canary (T-069, TECHNICAL-DESIGN §11.5).
 *
 * A Cursor run happens by hand and rarely: every CLI run spends one of the account's requests.
 * What is tested here is what decides whether such a run means anything: the files the run's
 * project carries, the command line, the environment, the way the CLI's stream-json becomes the
 * shared transcript, how the CLI is found behind its `.cmd` shim, the editor's launch, and the
 * scenario set. Fixture paths are built with `join`, so the suite reads the same on every
 * platform of CI.
 */
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CAPABILITY_TABLE } from '../../../src/adapters';
import { parseScenario } from '../../fake-app';
import { CODEX_SCENARIOS } from '../../canary/agents/codex/index.ts';
import { DEGRADED_PATH_SCRIPT } from '../../canary/agents/codex/degraded.ts';
import { CURSOR_DEGRADED_PATH_SCRIPT } from '../../canary/agents/cursor/degraded.ts';
import { CURSOR_EDITOR_REGISTER_SCRIPT } from '../../canary/agents/cursor/editor.ts';
import {
  cursorEditorArgs,
  cursorEditorEnvironment,
  cursorEditorPath,
  serverHelloReceived,
} from '../../canary/agents/cursor/editor-runner.ts';
import { CURSOR_SCENARIOS } from '../../canary/agents/cursor/index.ts';
import {
  cursorCliVersion,
  cursorCommandFrom,
  cursorToolCall,
  cursorToolName,
  cursorToolResult,
  cursorVersionRank,
  newEntries,
  parseCursorEvents,
} from '../../canary/agents/cursor/runner.ts';
import { cursorRow } from '../../canary/agents/cursor/scenario.ts';
import {
  CURSOR_DEFAULT_MODEL,
  CURSOR_MCP_PERMISSION,
  cursorArgs,
  cursorChildEnvironment,
  cursorProjectFiles,
  hookCommand,
  type HookRecorder,
} from '../../canary/agents/cursor/workspace.ts';
import { OPENCODE_SCENARIOS } from '../../canary/agents/opencode/index.ts';
import { SCENARIOS } from '../../canary/scenarios/index.ts';

const recorder: HookRecorder = {
  script: 'C:\\repo\\test\\canary\\agents\\cursor\\record-hook.mjs',
  out: 'C:\\temp\\run\\hooks.jsonl',
};

const plain = {
  serverBundle: 'C:\\repo\\dist\\handoff-mcp.cjs',
  home: 'C:\\temp\\run\\home',
  project: 'C:\\temp\\run\\project',
};

function parse(text: string | undefined): unknown {
  return JSON.parse(text ?? 'null') as unknown;
}

describe('the project a run carries', () => {
  const files = cursorProjectFiles({ ...plain, hookRecorder: recorder });

  it('declares our server in its mcp.json: node, the bundle and serve, with the five canary names', () => {
    expect(parse(files['.cursor/mcp.json'])).toEqual({
      mcpServers: {
        handoff: {
          command: process.execPath,
          args: [plain.serverBundle, 'serve'],
          env: {
            HANDOFF_AGENT: 'cursor',
            HANDOFF_HOME: plain.home,
            HANDOFF_CANARY: '1',
            HANDOFF_PROBE: 'canary',
            HANDOFF_PROBE_TOKEN: 'canary',
          },
        },
      },
    });
  });

  it('allows our tools and nothing else, because print mode refuses a tool that is not read-only', () => {
    expect(CURSOR_MCP_PERMISSION).toBe('Mcp(handoff:*)');
    expect(parse(files['.cursor/cli.json'])).toEqual({
      permissions: { allow: ['Mcp(handoff:*)'], deny: [] },
    });
  });

  it("declares the recorder as Cursor's stop hook and as Claude Code's Stop hook", () => {
    expect(parse(files['.cursor/hooks.json'])).toEqual({
      version: 1,
      hooks: { stop: [{ command: hookCommand(recorder, 'cursor-stop') }] },
    });
    expect(parse(files['.claude/settings.json'])).toEqual({
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: hookCommand(recorder, 'claude-stop') }] }],
      },
    });
  });

  it('declares no hook when the scenario records none', () => {
    expect(Object.keys(cursorProjectFiles(plain)).sort()).toEqual([
      '.cursor/cli.json',
      '.cursor/mcp.json',
    ]);
  });

  it('writes the hook paths with forward slashes, which no shell reads as an escape', () => {
    expect(hookCommand(recorder, 'cursor-stop')).toBe(
      'node "C:/repo/test/canary/agents/cursor/record-hook.mjs" "C:/temp/run/hooks.jsonl" cursor-stop',
    );
  });
});

describe('the agent command line', () => {
  const args = cursorArgs({
    prompt: 'say hi',
    model: CURSOR_DEFAULT_MODEL,
    project: plain.project,
  });

  it('is print mode with stream-json events, the prompt last', () => {
    expect(args.slice(0, 3)).toEqual(['-p', '--output-format', 'stream-json']);
    expect(args.at(-1)).toBe('say hi');
  });

  it('approves the project server and trusts the project for this run, and never forces', () => {
    expect(args).toContain('--approve-mcps');
    expect(args).toContain('--trust');
    expect(args).not.toContain('--force');
    expect(args).not.toContain('--yolo');
  });

  it("runs on Cursor's auto model, in the run's project", () => {
    expect(CURSOR_DEFAULT_MODEL).toBe('auto');
    expect(args[args.indexOf('--model') + 1]).toBe('auto');
    expect(args[args.indexOf('--workspace') + 1]).toBe(plain.project);
  });
});

describe('the environment of the agent child', () => {
  it('drops CLAUDECODE, keeps the rest, and points HANDOFF_HOME at the run folder', () => {
    expect(
      cursorChildEnvironment(plain, {
        PATH: 'p',
        CLAUDECODE: '1',
        USERDOMAIN: 'D',
        HANDOFF_HOME: 'elsewhere',
        UNSET: undefined,
      }),
    ).toEqual({ PATH: 'p', USERDOMAIN: 'D', HANDOFF_HOME: plain.home });
  });
});

const RUNBOOKS_ARGS = {
  name: 'handoff-handoff_runbooks',
  args: { where: 'Stripe dashboard', goal: 'Add a webhook endpoint' },
  toolCallId: 'c1',
  providerIdentifier: 'handoff',
  toolName: 'handoff_runbooks',
};

const EVENTS: readonly Record<string, unknown>[] = [
  {
    type: 'system',
    subtype: 'init',
    apiKeySource: 'login',
    cwd: plain.project,
    session_id: 's1',
    model: 'Auto',
    permissionMode: 'default',
  },
  {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: 'call it' }] },
    session_id: 's1',
  },
  {
    type: 'tool_call',
    subtype: 'started',
    call_id: 'c1',
    tool_call: { mcpToolCall: { args: RUNBOOKS_ARGS } },
    session_id: 's1',
    timestamp_ms: 5_000,
  },
  {
    type: 'tool_call',
    subtype: 'completed',
    call_id: 'c1',
    tool_call: {
      mcpToolCall: {
        args: RUNBOOKS_ARGS,
        result: { success: { content: [{ text: { text: '{"runbooks":[]}' } }], isError: false } },
      },
    },
    session_id: 's1',
    timestamp_ms: 5_400,
  },
  {
    type: 'tool_call',
    subtype: 'completed',
    call_id: 'c2',
    tool_call: { shellToolCall: { args: { command: 'ls' }, result: { success: { stdout: 'x' } } } },
    env: 'PLANTED_VARIABLE=planted-value',
    session_id: 's1',
    timestamp_ms: 6_100,
  },
  {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'blue' }] },
    session_id: 's1',
  },
  {
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 9_000,
    result: 'blue',
    session_id: 's1',
    request_id: 'r1',
  },
];

describe("the CLI's stream-json transcript", () => {
  const lines = [
    ...EVENTS.map((event, index) => ({ line: JSON.stringify(event), at: 1_000 + index })),
    { line: 'not json at all' },
  ];
  const parsed = parseCursorEvents(lines);

  it('keeps every JSON event, stamped with the instant it arrived, and the session', () => {
    expect(parsed.transcript).toHaveLength(EVENTS.length);
    expect(parsed.transcript[0]?.['received_at']).toBe(new Date(1_000).toISOString());
    expect(parsed.sessionId).toBe('s1');
  });

  it('names our tools the way Claude Code names them, and a built-in tool by its kind', () => {
    expect(parsed.toolUses.map((use) => use.name)).toEqual([
      'mcp__handoff__handoff_runbooks',
      'shellToolCall',
    ]);
    expect(parsed.toolUses[0]?.input).toEqual(RUNBOOKS_ARGS.args);
  });

  it('gives each completed call the text of its content and whether it failed', () => {
    expect(parsed.toolResults[0]).toEqual({
      tool_use_id: 'c1',
      isError: false,
      text: '{"runbooks":[]}',
    });
  });

  it('drops the environment snapshot a completed shell call carries', () => {
    expect(parsed.transcript.some((event) => 'env' in event)).toBe(false);
    expect(JSON.stringify(parsed.transcript)).not.toContain('planted-value');
  });

  it('takes the result event as the result', () => {
    expect(parsed.result?.result).toBe('blue');
    expect(parseCursorEvents([]).result).toBeUndefined();
  });

  it('reads the in-memory shape of a call too, and a server name with a scope on it', () => {
    const call = cursorToolCall({
      tool: {
        case: 'mcpToolCall',
        value: {
          args: { providerIdentifier: 'handoff::mcpScope:project', toolName: 'handoff_to_user' },
        },
      },
    });
    expect(call?.kind).toBe('mcpToolCall');
    expect(cursorToolName(call?.kind ?? '', call?.body ?? {})).toBe(
      'mcp__handoff__handoff_to_user',
    );
    expect(cursorToolName('mcpToolCall', { args: { name: 'handoff-handoff_verify' } })).toBe(
      'mcp__handoff__handoff_verify',
    );
  });

  it('reports a refused, a failed and a flagged call as errors, with what Cursor said', () => {
    expect(
      cursorToolResult({ result: { rejected: { reason: 'User rejected MCP: handoff-x' } } }),
    ).toEqual({ isError: true, text: 'User rejected MCP: handoff-x' });
    expect(
      cursorToolResult({ result: { error: { error: 'MCP error -32001: Request timed out' } } }),
    ).toEqual({ isError: true, text: 'MCP error -32001: Request timed out' });
    expect(
      cursorToolResult({
        result: { success: { content: [{ text: { text: 'no' } }], isError: true } },
      }),
    ).toEqual({ isError: true, text: 'no' });
    expect(cursorToolResult({})).toBeUndefined();
  });
});

describe('finding the Cursor Agent CLI', () => {
  const install = join('opt', 'cursor-agent');
  const versions = join(install, 'versions');
  const newest = join(versions, '2026.09.10-fd3934a');

  it('ranks the version folders the way its own launcher does', () => {
    expect(cursorVersionRank('2026.09.10-fd3934a')).toBe(20260910);
    expect(cursorVersionRank('2026.9.1-aaaaaaa')).toBe(20260901);
    expect(cursorVersionRank('latest')).toBeUndefined();
  });

  it('bypasses the .cmd shim for the node.exe and index.js of the newest version folder', () => {
    const command = cursorCommandFrom([join(install, 'agent.cmd')], {
      windows: true,
      exists: (path) => path.startsWith(versions),
      list: (folder) =>
        folder === versions ? ['2026.08.01-aaaaaaa', '2026.09.10-fd3934a', 'notes.txt'] : [],
    });
    expect(command).toEqual({
      command: join(newest, 'node.exe'),
      prefix: [join(newest, 'index.js')],
      shell: false,
    });
    expect(cursorCliVersion(command)).toBe('2026.09.10-fd3934a');
  });

  it('falls back to the shell only when no version folder is beside the shim', () => {
    expect(
      cursorCommandFrom([join(install, 'agent.cmd')], {
        windows: true,
        exists: () => false,
        list: () => [],
      }),
    ).toEqual({ command: join(install, 'agent.cmd'), prefix: [], shell: true });
  });

  it('starts a launcher that is not a shim directly, and names the CLI when nothing was found', () => {
    const elsewhere = { windows: false, exists: () => false, list: () => [] };
    expect(cursorCommandFrom([join('usr', 'bin', 'cursor-agent')], elsewhere)).toEqual({
      command: join('usr', 'bin', 'cursor-agent'),
      prefix: [],
      shell: false,
    });
    expect(cursorCommandFrom([], elsewhere)).toEqual({
      command: 'agent',
      prefix: [],
      shell: false,
    });
    expect(cursorCliVersion({ command: 'agent', prefix: [], shell: false })).toBeNull();
  });

  it('removes only what a run added to the folders it leaves state in', () => {
    expect(newEntries(['a', 'b'], ['a', 'b', 'c'])).toEqual(['c']);
    expect(newEntries(['a'], [])).toEqual([]);
  });
});

describe("the editor's launch", () => {
  it('gives the editor a user-data and an extensions folder of its own, the project last', () => {
    expect(cursorEditorArgs({ userData: 'U', extensions: 'E', project: 'P' })).toEqual([
      '--user-data-dir',
      'U',
      '--extensions-dir',
      'E',
      '--new-window',
      'P',
    ]);
  });

  it("moves the home folder to the run's, which is where the editor looks for mcp.json", () => {
    expect(
      cursorEditorEnvironment(
        { home: 'H' },
        { PATH: 'p', CLAUDECODE: '1', USERPROFILE: 'real', UNSET: undefined },
      ),
    ).toEqual({ PATH: 'p', USERPROFILE: 'H', HOME: 'H' });
  });

  it('finds the editor where each platform installs it, unless told otherwise', () => {
    expect(cursorEditorPath({ LOCALAPPDATA: 'L' }, 'win32')).toBe(
      join('L', 'Programs', 'cursor', 'Cursor.exe'),
    );
    expect(cursorEditorPath({}, 'darwin')).toBe('/Applications/Cursor.app/Contents/MacOS/Cursor');
    expect(cursorEditorPath({ HANDOFF_CANARY_CURSOR_EDITOR: ' X ' }, 'win32')).toBe('X');
  });

  it("waits for a server's hello, and a hook's does not count", () => {
    const hook = { method: 'hello', params: { role: 'hook' } };
    const server = { method: 'hello', params: { role: 'server' } };
    const transcript = (received: unknown[]) => ({
      received,
      sent: [],
      violations: [],
      remaining: 0,
    });
    expect(serverHelloReceived(undefined)).toBe(false);
    expect(serverHelloReceived(transcript([hook]))).toBe(false);
    expect(serverHelloReceived(transcript([hook, server]))).toBe(true);
  });
});

describe('the Cursor scenario set', () => {
  it('has ids of its own, prefixed cursor-, unique across every agent', () => {
    const ids = [...SCENARIOS, ...CODEX_SCENARIOS, ...OPENCODE_SCENARIOS, ...CURSOR_SCENARIOS].map(
      (scenario) => scenario.id,
    );
    expect(new Set(ids).size).toBe(ids.length);
    for (const scenario of CURSOR_SCENARIOS) expect(scenario.id).toMatch(/^cursor-/u);
  });

  it('starts with the editor, which spends no request, and bounds every CLI run', () => {
    expect(CURSOR_SCENARIOS[0]?.surface).toBe('editor');
    for (const scenario of CURSOR_SCENARIOS) {
      expect(scenario.covers.length, scenario.id).toBeGreaterThan(0);
      if (scenario.surface !== 'cli') continue;
      expect(scenario.options.prompt, scenario.id).toContain('MCP server handoff');
      expect(scenario.options.timeoutMs ?? 300_000, scenario.id).toBeLessThanOrEqual(300_000);
    }
  });

  it('covers E2E-8, the degraded path, the editor identity and the facts the cursor row is made of', () => {
    const covered = new Set(CURSOR_SCENARIOS.flatMap((scenario) => scenario.covers));
    for (const id of [
      'E2E-8',
      'FM-03',
      'FM-04',
      'A-04',
      'A-07',
      'A-08',
      'A-09',
      'R-12',
      'SRV-18',
    ]) {
      expect(covered.has(id), id).toBe(true);
    }
  });

  it('compares against the cursor row the server bundles, not a copy of it', () => {
    const row = CAPABILITY_TABLE.find((candidate) => candidate.agent_id === 'cursor');
    expect(cursorRow()).toEqual({
      client_names: row?.match.client_names,
      images_in_results: row?.images_in_results,
      stop_hook: row?.stop_hook,
      cancellation_notifications: row?.cancellation_notifications,
      tool_timeout_ms_default: row?.tool_timeout_ms_default,
      session_identity: row?.session_identity,
    });
  });

  it('drives the overlay with the Codex script for the degraded path, and with none for the editor', () => {
    expect(CURSOR_DEGRADED_PATH_SCRIPT.name).toBe('cursor-degraded-path');
    expect(CURSOR_DEGRADED_PATH_SCRIPT.actions).toEqual(DEGRADED_PATH_SCRIPT.actions);
    const editor = parseScenario(
      {
        scenario: CURSOR_EDITOR_REGISTER_SCRIPT.name,
        why: CURSOR_EDITOR_REGISTER_SCRIPT.why,
        actions: CURSOR_EDITOR_REGISTER_SCRIPT.actions,
      },
      CURSOR_EDITOR_REGISTER_SCRIPT.name,
    );
    expect(editor.send).toEqual([]);
  });
});

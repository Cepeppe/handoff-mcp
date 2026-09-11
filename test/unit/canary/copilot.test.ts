/**
 * The deterministic half of the GitHub Copilot canary (T-072, TECHNICAL-DESIGN §11.5).
 *
 * A Copilot run happens by hand and rarely: every CLI run spends the account's AI credits. What
 * is tested here is what decides whether such a run means anything: the Copilot folder and the
 * project a run carries, the command line, the environment, the way the CLI's session events
 * become the shared transcript, how the native CLI is found behind its npm shim, VS Code's
 * launch with its starter extension, and the scenario set. Fixture paths are built with `join`,
 * so the suite reads the same on every platform of CI.
 */
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CAPABILITY_TABLE } from '../../../src/adapters';
import { parseScenario } from '../../fake-app';
import { CODEX_SCENARIOS } from '../../canary/agents/codex/index.ts';
import { DEGRADED_PATH_SCRIPT } from '../../canary/agents/codex/degraded.ts';
import { COPILOT_DEGRADED_PATH_SCRIPT } from '../../canary/agents/copilot/degraded.ts';
import { COPILOT_EDITOR_REGISTER_SCRIPT } from '../../canary/agents/copilot/editor.ts';
import {
  VSCODE_STARTER_MANIFEST,
  VSCODE_STARTER_SCRIPT,
  serverHelloReceived,
  vscodeArgs,
  vscodeEnvironment,
  vscodeMcpConfig,
  vscodePath,
  vscodeUserSettings,
} from '../../canary/agents/copilot/editor-runner.ts';
import { COPILOT_SCENARIOS } from '../../canary/agents/copilot/index.ts';
import {
  copilotCommandFrom,
  copilotToolName,
  copilotToolResult,
  copilotVersionOf,
  parseCopilotEvents,
} from '../../canary/agents/copilot/runner.ts';
import { copilotRow } from '../../canary/agents/copilot/scenario.ts';
import {
  COPILOT_DEFAULT_MODEL,
  copilotArgs,
  copilotChildEnvironment,
  copilotHomeFiles,
  copilotProjectFiles,
  copilotUserHomeFiles,
  hookCommand,
  type HookRecorder,
} from '../../canary/agents/copilot/workspace.ts';
import { CURSOR_SCENARIOS } from '../../canary/agents/cursor/index.ts';
import { OPENCODE_SCENARIOS } from '../../canary/agents/opencode/index.ts';
import { SCENARIOS } from '../../canary/scenarios/index.ts';

const recorder: HookRecorder = {
  script: 'C:\\repo\\test\\canary\\agents\\copilot\\record-hook.mjs',
  out: 'C:\\temp\\run\\hooks.jsonl',
};

const plain = {
  serverBundle: 'C:\\repo\\dist\\handoff-mcp.cjs',
  home: 'C:\\temp\\run\\home',
  project: 'C:\\temp\\run\\project',
};

const CANARY_ENV = {
  HANDOFF_AGENT: 'copilot',
  HANDOFF_HOME: plain.home,
  HANDOFF_CANARY: '1',
  HANDOFF_PROBE: 'canary',
  HANDOFF_PROBE_TOKEN: 'canary',
};

function parse(text: string | undefined): unknown {
  return JSON.parse(text ?? 'null') as unknown;
}

describe('the Copilot folder a run carries', () => {
  it('declares our server in its mcp-config.json the way the installer does: local, node, the bundle and serve, every tool', () => {
    expect(parse(copilotHomeFiles(plain)['mcp-config.json'])).toEqual({
      mcpServers: {
        handoff: {
          type: 'local',
          command: process.execPath,
          args: [plain.serverBundle, 'serve'],
          env: CANARY_ENV,
          tools: ['*'],
        },
      },
    });
  });

  it('writes the per-server timeout only for the scenario that measures it, in milliseconds', () => {
    const config = parse(copilotHomeFiles({ ...plain, timeoutMs: 20_000 })['mcp-config.json']) as {
      mcpServers: { handoff: { timeout?: number } };
    };
    expect(config.mcpServers.handoff.timeout).toBe(20_000);
  });

  it('trusts the project, and declares no hook when the scenario records none', () => {
    expect(parse(copilotHomeFiles(plain)['config.json'])).toEqual({
      trustedFolders: [plain.project],
    });
    expect(copilotProjectFiles(plain)).toEqual({});
  });

  it("declares the recorder as the CLI's sessionStart, agentStop and sessionEnd hooks, for either shell", () => {
    const config = parse(copilotHomeFiles({ ...plain, hookRecorder: recorder })['config.json']) as {
      hooks: Record<string, { type: string; bash: string; powershell: string }[]>;
    };
    expect(Object.keys(config.hooks)).toEqual(['sessionStart', 'agentStop', 'sessionEnd']);
    expect(config.hooks['agentStop']).toEqual([
      {
        type: 'command',
        bash: hookCommand(recorder, 'copilot-agent-stop'),
        powershell: hookCommand(recorder, 'copilot-agent-stop'),
        timeoutSec: 30,
      },
    ]);
  });

  it('declares the recorder as a Claude Code Stop hook of the project, to see whether the CLI runs it', () => {
    expect(
      parse(copilotProjectFiles({ ...plain, hookRecorder: recorder })['.claude/settings.json']),
    ).toEqual({
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: hookCommand(recorder, 'claude-stop') }] }],
      },
    });
  });

  it("declares it in the run's home folder too, where Baton's Claude Code adapter writes its own", () => {
    expect(
      parse(copilotUserHomeFiles({ ...plain, hookRecorder: recorder })['.claude/settings.json']),
    ).toEqual({
      hooks: {
        Stop: [
          { hooks: [{ type: 'command', command: hookCommand(recorder, 'claude-stop-user') }] },
        ],
      },
    });
    expect(copilotUserHomeFiles(plain)).toEqual({});
  });

  it('writes the hook paths with forward slashes, which no shell reads as an escape', () => {
    expect(hookCommand(recorder, 'claude-stop')).toBe(
      'node "C:/repo/test/canary/agents/copilot/record-hook.mjs" "C:/temp/run/hooks.jsonl" claude-stop',
    );
  });
});

describe('the agent command line', () => {
  const args = copilotArgs({
    prompt: 'say hi',
    model: COPILOT_DEFAULT_MODEL,
    usageFile: 'C:\\temp\\run\\usage.json',
  });

  it('is print mode with the prompt, and one JSON session event per line', () => {
    expect(args.slice(0, 2)).toEqual(['-p', 'say hi']);
    expect(args[args.indexOf('--output-format') + 1]).toBe('json');
  });

  it('allows our tools and nothing else, refuses the shell and every write, and never allows all', () => {
    expect(args).toContain('--allow-tool=handoff');
    expect(args).toContain('--deny-tool=shell');
    expect(args).toContain('--deny-tool=write');
    expect(args).toContain('--disable-builtin-mcps');
    expect(args.some((arg) => /allow-all|--yolo/u.test(arg))).toBe(false);
  });

  it('asks the user nothing, reads no instructions of the machine, updates nothing, exports nothing', () => {
    for (const flag of [
      '--no-ask-user',
      '--no-custom-instructions',
      '--no-auto-update',
      '--no-remote-export',
    ]) {
      expect(args, flag).toContain(flag);
    }
  });

  it("runs on Copilot's auto model and writes what it cost", () => {
    expect(COPILOT_DEFAULT_MODEL).toBe('auto');
    expect(args[args.indexOf('--model') + 1]).toBe('auto');
    expect(args[args.indexOf('--usage-output-file') + 1]).toBe('C:\\temp\\run\\usage.json');
  });
});

describe('the environment of the agent child', () => {
  it("drops CLAUDECODE and every COPILOT_ of the parent's, moves COPILOT_HOME and the home folder, and turns updates off", () => {
    expect(
      copilotChildEnvironment(
        {
          home: plain.home,
          copilotHome: 'C:\\temp\\run\\copilot-home',
          userHome: 'C:\\temp\\run\\user-home',
        },
        {
          PATH: 'p',
          CLAUDECODE: '1',
          USERDOMAIN: 'D',
          USERPROFILE: 'C:\\Users\\someone',
          COPILOT_HOME: 'C:\\Users\\someone\\.copilot',
          COPILOT_GITHUB_TOKEN: 'planted',
          copilot_model: 'x',
          HANDOFF_HOME: 'elsewhere',
          UNSET: undefined,
        },
      ),
    ).toEqual({
      PATH: 'p',
      USERDOMAIN: 'D',
      USERPROFILE: 'C:\\temp\\run\\user-home',
      HOME: 'C:\\temp\\run\\user-home',
      COPILOT_HOME: 'C:\\temp\\run\\copilot-home',
      COPILOT_AUTO_UPDATE: 'false',
      HANDOFF_HOME: plain.home,
    });
  });
});

const EVENTS: readonly Record<string, unknown>[] = [
  {
    type: 'session.mcp_servers_loaded',
    data: { servers: [{ name: 'handoff', status: 'connected', source: 'user' }] },
  },
  {
    type: 'assistant.message',
    data: { messageId: 'm1', content: '', toolRequests: [{ toolCallId: 'c1', name: 'x' }] },
  },
  {
    type: 'tool.execution_start',
    timestamp: '2026-09-11T10:00:00.000Z',
    data: {
      toolCallId: 'c1',
      toolName: 'handoff-handoff_runbooks',
      arguments: { where: 'Stripe dashboard', goal: 'Add a webhook endpoint' },
      mcpServerName: 'handoff',
      mcpToolName: 'handoff_runbooks',
    },
  },
  {
    type: 'tool.execution_complete',
    timestamp: '2026-09-11T10:00:00.400Z',
    data: { toolCallId: 'c1', success: true, result: { content: '{"runbooks":[]}' } },
  },
  { type: 'tool.execution_start', data: { toolCallId: 'c2', toolName: 'view' } },
  {
    type: 'tool.execution_complete',
    data: { toolCallId: 'c2', success: false, error: { message: 'Permission denied' } },
  },
  { type: 'assistant.message', data: { messageId: 'm2', content: 'blue' } },
  { type: 'assistant.message', data: { messageId: 'm3', content: '   ' } },
  { type: 'result', sessionId: 's1', exitCode: 0, usage: { totalNanoAiu: 488_934_000 } },
];

describe("the CLI's session events", () => {
  const lines = [
    ...EVENTS.map((event, index) => ({ line: JSON.stringify(event), at: 1_000 + index })),
    { line: 'not json at all' },
    { line: '{"no":"type"}' },
  ];
  const parsed = parseCopilotEvents(lines);

  it('keeps every JSON event with a type, stamped with the instant it arrived', () => {
    expect(parsed.transcript).toHaveLength(EVENTS.length);
    expect(parsed.transcript[0]?.['received_at']).toBe(new Date(1_000).toISOString());
  });

  it('names our tools the way Claude Code names them, and a built-in tool by its own name', () => {
    expect(parsed.toolUses.map((use) => use.name)).toEqual([
      'mcp__handoff__handoff_runbooks',
      'view',
    ]);
    expect(parsed.toolUses[0]?.input).toEqual({
      where: 'Stripe dashboard',
      goal: 'Add a webhook endpoint',
    });
  });

  it('gives each completed call the text of its result, or of its error, and whether it failed', () => {
    expect(parsed.toolResults).toEqual([
      { tool_use_id: 'c1', isError: false, text: '{"runbooks":[]}' },
      { tool_use_id: 'c2', isError: true, text: 'Permission denied' },
    ]);
  });

  it('takes the last assistant message with any text as the reply, and the servers the CLI loaded', () => {
    expect(parsed.reply).toBe('blue');
    expect(parsed.servers).toEqual([{ name: 'handoff', status: 'connected' }]);
    expect(parseCopilotEvents([]).reply).toBeUndefined();
  });

  it('keeps the exit code and the usage of the closing result event, which carries no text', () => {
    expect(parsed.final).toEqual({ exitCode: 0, usage: { totalNanoAiu: 488_934_000 } });
    expect(parseCopilotEvents([]).final).toBeUndefined();
  });

  it('reads a tool of our server from its prefixed name too', () => {
    expect(copilotToolName({ toolName: 'handoff-handoff_to_user' })).toBe(
      'mcp__handoff__handoff_to_user',
    );
    expect(copilotToolResult({ toolCallId: 'x' })).toEqual({ isError: true, text: '' });
  });
});

describe('finding the Copilot CLI', () => {
  const npm = join('Users', 'someone', 'AppData', 'Roaming', 'npm');
  const nested = join(
    npm,
    'node_modules',
    '@github',
    'copilot',
    'node_modules',
    '@github',
    'copilot-win32-x64',
    'copilot.exe',
  );
  const hoisted = join(npm, 'node_modules', '@github', 'copilot-win32-x64', 'copilot.exe');
  const windows = (present: string) => ({
    windows: true,
    name: 'win32',
    arch: 'x64',
    exists: (path: string) => path === present,
  });

  it("bypasses the .cmd shim for the platform package's native binary, nested or hoisted", () => {
    expect(
      copilotCommandFrom([join(npm, 'copilot'), join(npm, 'copilot.cmd')], windows(nested)),
    ).toEqual({
      command: nested,
      shell: false,
    });
    expect(copilotCommandFrom([join(npm, 'copilot.cmd')], windows(hoisted))).toEqual({
      command: hoisted,
      shell: false,
    });
  });

  it('falls back to the shell only when no binary is beside the shim', () => {
    expect(copilotCommandFrom([join(npm, 'copilot.cmd')], windows('nothing'))).toEqual({
      command: join(npm, 'copilot.cmd'),
      shell: true,
    });
  });

  it('starts a launcher that is not a shim directly, and names the CLI when nothing was found', () => {
    const elsewhere = { windows: false, name: 'linux', arch: 'x64', exists: () => false };
    expect(copilotCommandFrom([join('usr', 'bin', 'copilot')], elsewhere)).toEqual({
      command: join('usr', 'bin', 'copilot'),
      shell: false,
    });
    expect(copilotCommandFrom([], elsewhere)).toEqual({ command: 'copilot', shell: false });
  });

  it('reads the version the CLI prints', () => {
    expect(copilotVersionOf('GitHub Copilot CLI 1.0.83.\n')).toBe('1.0.83');
    expect(copilotVersionOf('nothing here')).toBeNull();
  });
});

describe("VS Code's launch", () => {
  it('gives VS Code a user-data and an extensions folder of its own, the starter, no trust prompt, the project last', () => {
    expect(vscodeArgs({ userData: 'U', extensions: 'E', starter: 'S', project: 'P' })).toEqual([
      '--user-data-dir',
      'U',
      '--extensions-dir',
      'E',
      '--extensionDevelopmentPath=S',
      '--disable-workspace-trust',
      '--new-window',
      'P',
    ]);
  });

  it("moves the home folder to the run's", () => {
    expect(
      vscodeEnvironment(
        { home: 'H' },
        { PATH: 'p', CLAUDECODE: '1', USERPROFILE: 'real', UNSET: undefined },
      ),
    ).toEqual({ PATH: 'p', USERPROFILE: 'H', HOME: 'H' });
  });

  it('finds VS Code where each platform installs it, unless told otherwise', () => {
    expect(vscodePath({ LOCALAPPDATA: 'L' }, 'win32')).toBe(
      join('L', 'Programs', 'Microsoft VS Code', 'Code.exe'),
    );
    expect(vscodePath({}, 'darwin')).toBe(
      '/Applications/Visual Studio Code.app/Contents/MacOS/Code',
    );
    expect(vscodePath({ HANDOFF_CANARY_VSCODE: ' X ' }, 'win32')).toBe('X');
  });

  it("declares our server in the profile's mcp.json as VS Code spells it", () => {
    expect(vscodeMcpConfig(plain)).toEqual({
      servers: {
        handoff: {
          type: 'stdio',
          command: process.execPath,
          args: [plain.serverBundle, 'serve'],
          env: CANARY_ENV,
        },
      },
    });
  });

  it('turns off everything that would put a dialog or a download in the way', () => {
    expect(vscodeUserSettings()).toMatchObject({
      'security.workspace.trust.enabled': false,
      'update.mode': 'none',
      'telemetry.telemetryLevel': 'off',
    });
  });

  it('starts the servers of the profile with the argument that skips the trust prompt, and nothing else', () => {
    expect(VSCODE_STARTER_MANIFEST.activationEvents).toEqual(['onStartupFinished']);
    expect(VSCODE_STARTER_MANIFEST.main).toBe('./extension.js');
    expect(VSCODE_STARTER_SCRIPT).toContain("executeCommand('workbench.mcp.startServer', '*', {");
    expect(VSCODE_STARTER_SCRIPT).toContain('autoTrustChanges: true');
    expect(VSCODE_STARTER_SCRIPT.match(/executeCommand/gu)).toHaveLength(1);
  });

  it("waits for a server's hello, and a hook's does not count", () => {
    const transcript = (received: unknown[]) => ({
      received,
      sent: [],
      violations: [],
      remaining: 0,
    });
    expect(serverHelloReceived(undefined)).toBe(false);
    expect(serverHelloReceived(transcript([{ method: 'hello', params: { role: 'hook' } }]))).toBe(
      false,
    );
    expect(serverHelloReceived(transcript([{ method: 'hello', params: { role: 'server' } }]))).toBe(
      true,
    );
  });
});

describe('the Copilot scenario set', () => {
  it('has ids of its own, prefixed copilot-, unique across every agent', () => {
    const ids = [
      ...SCENARIOS,
      ...CODEX_SCENARIOS,
      ...OPENCODE_SCENARIOS,
      ...CURSOR_SCENARIOS,
      ...COPILOT_SCENARIOS,
    ].map((scenario) => scenario.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const scenario of COPILOT_SCENARIOS) expect(scenario.id).toMatch(/^copilot-/u);
  });

  it('starts with VS Code, which spends no credit, and bounds every CLI run', () => {
    expect(COPILOT_SCENARIOS[0]?.surface).toBe('editor');
    for (const scenario of COPILOT_SCENARIOS) {
      expect(scenario.covers.length, scenario.id).toBeGreaterThan(0);
      if (scenario.surface !== 'cli') continue;
      expect(scenario.options.prompt, scenario.id).toContain('MCP server handoff');
      expect(scenario.options.timeoutMs ?? 300_000, scenario.id).toBeLessThanOrEqual(300_000);
    }
  });

  it('covers E2E-8, the degraded path, the editor identity and the facts the copilot row is made of', () => {
    const covered = new Set(COPILOT_SCENARIOS.flatMap((scenario) => scenario.covers));
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

  it('compares against the copilot row the server bundles, not a copy of it', () => {
    const row = CAPABILITY_TABLE.find((candidate) => candidate.agent_id === 'copilot');
    expect(copilotRow()).toEqual({
      client_names: row?.match.client_names,
      images_in_results: row?.images_in_results,
      stop_hook: row?.stop_hook,
      cancellation_notifications: row?.cancellation_notifications,
      tool_timeout_ms_default: row?.tool_timeout_ms_default,
      session_identity: row?.session_identity,
    });
  });

  it('drives the overlay with the Codex script for the degraded path, and with none for VS Code', () => {
    expect(COPILOT_DEGRADED_PATH_SCRIPT.name).toBe('copilot-degraded-path');
    expect(COPILOT_DEGRADED_PATH_SCRIPT.actions).toEqual(DEGRADED_PATH_SCRIPT.actions);
    const editor = parseScenario(
      {
        scenario: COPILOT_EDITOR_REGISTER_SCRIPT.name,
        why: COPILOT_EDITOR_REGISTER_SCRIPT.why,
        actions: COPILOT_EDITOR_REGISTER_SCRIPT.actions,
      },
      COPILOT_EDITOR_REGISTER_SCRIPT.name,
    );
    expect(editor.send).toEqual([]);
  });
});

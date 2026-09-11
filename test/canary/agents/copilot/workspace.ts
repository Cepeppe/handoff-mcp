/**
 * The Copilot folder, the project, the command line and the environment of one GitHub Copilot
 * CLI run (T-072, TECHNICAL-DESIGN §11.5, ADPT-06 item 3). The Copilot twin of
 * `../cursor/workspace.ts`, and pure for the same reason: `test/unit/canary/copilot.test.ts`
 * pins every shape here without a real agent, so a malformed file cannot make every Copilot
 * canary fail for a reason that has nothing to do with Copilot.
 *
 * Measured against the Copilot CLI 1.0.83 on 2026-09-11 (`docs/agent-facts.md`):
 *
 * 1. **The whole Copilot folder is the run's.** `COPILOT_HOME` moves `~/.copilot` — its
 *    `mcp-config.json`, its `config.json`, its sessions and its logs — while the CLI still signs
 *    in through the owner's gh login, which lives elsewhere (T-071). So the user's own MCP
 *    servers, hooks and history never meet a canary, and whatever a run leaves behind goes with
 *    the run's folder.
 * 2. **Our server is declared the way the installer declares it**, in that folder's
 *    `mcp-config.json` under `mcpServers`: a `local` entry with `tools: ["*"]` and, for the
 *    scenario that measures it, the per-server `timeout` in milliseconds.
 * 3. **One allowance.** `--allow-tool=handoff` approves our server's tools and nothing else;
 *    `--deny-tool` refuses the shell and every file write, the built-in GitHub server is off,
 *    and `--allow-all-tools` is never passed.
 * 4. **Hooks of the run's own**, when a scenario records them: `sessionStart`, `agentStop` and
 *    `sessionEnd` in the folder's `config.json`, and a Claude Code `Stop` hook in the project's
 *    `.claude/settings.json` and in the home folder's, to see whether the CLI runs those as its
 *    own too — measured: it runs both, with Claude Code's own payload. The project is listed in
 *    `trustedFolders`, so nothing of the project's is ignored for being untrusted.
 * 5. **The home folder is the run's** as well (`USERPROFILE`, `HOME`), because the CLI reads
 *    Claude Code's `~/.claude/settings.json` as a source of hooks: without it, the user's own
 *    hooks would run beside a canary's.
 */
import { PROBE_ENV_VALUE } from '../../workspace.ts';

/** The name our server is declared under. The CLI calls the tools `handoff-<tool>`. */
export const COPILOT_MCP_SERVER_NAME = 'handoff';

/** The `HANDOFF_AGENT` an installer writes for Copilot (§5.6), and the table's key. */
export const COPILOT_AGENT_ID = 'copilot';

/**
 * The model every Copilot canary runs on unless `HANDOFF_CANARY_COPILOT_MODEL` says otherwise:
 * `auto`, Copilot's own choice and the only one the Free plan the owner keeps offers (T-071).
 */
export const COPILOT_DEFAULT_MODEL = 'auto';

/** What a run allows: every tool of our server, and nothing else. */
export const COPILOT_TOOL_ALLOWANCE = COPILOT_MCP_SERVER_NAME;

/** What a run refuses outright: the shell and every file write. */
export const COPILOT_DENIED_TOOLS = ['shell', 'write'] as const;

/** Where the recording hook writes, and the file it runs. */
export interface HookRecorder {
  readonly script: string;
  readonly out: string;
}

export interface CopilotWorkspaceOptions {
  /** Absolute path of the built bundle, `dist/handoff-mcp.cjs`. */
  readonly serverBundle: string;
  /** The temporary `HANDOFF_HOME` of this run. */
  readonly home: string;
  /** The temporary project folder the CLI works in. */
  readonly project: string;
  /** The per-server `timeout` of our entry, in milliseconds (A-04); nothing writes none. */
  readonly timeoutMs?: number;
  /** The recording hook, for a scenario that records hooks; nothing declares no hook. */
  readonly hookRecorder?: HookRecorder;
}

/** One stdio server as the CLI's `mcp-config.json` spells it (`copilot mcp add --json`). */
export interface CopilotMcpEntry {
  readonly type: 'local';
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly tools: readonly string[];
  readonly timeout?: number;
}

export interface CopilotMcpConfig {
  readonly mcpServers: Readonly<Record<string, CopilotMcpEntry>>;
}

/** The `env` of our entry: the five names of the Claude canary, with Copilot's id. */
export function copilotServerEnv(options: { readonly home: string }): Record<string, string> {
  return {
    HANDOFF_AGENT: COPILOT_AGENT_ID,
    HANDOFF_HOME: options.home,
    HANDOFF_CANARY: '1',
    HANDOFF_PROBE: PROBE_ENV_VALUE,
    HANDOFF_PROBE_TOKEN: PROBE_ENV_VALUE,
  };
}

/** The `mcp-config.json` that declares our server: `node <bundle> serve` and the environment. */
export function copilotMcpConfig(options: {
  readonly serverBundle: string;
  readonly home: string;
  readonly timeoutMs?: number;
}): CopilotMcpConfig {
  return {
    mcpServers: {
      [COPILOT_MCP_SERVER_NAME]: {
        type: 'local',
        command: process.execPath,
        args: [options.serverBundle, 'serve'],
        env: copilotServerEnv(options),
        tools: ['*'],
        ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
      },
    },
  };
}

/**
 * The command a hook runs: `node`, the recorder, the file it writes, and which declaration ran
 * it. Paths are written with forward slashes, which Node accepts on Windows and which neither
 * of the two shells the CLI may run the command through reads as an escape.
 */
export function hookCommand(recorder: HookRecorder, label: string): string {
  const slash = (path: string): string => path.split('\\').join('/');
  return `node "${slash(recorder.script)}" "${slash(recorder.out)}" ${label}`;
}

/** One command hook, in the shape of `.github/hooks/*.json`: the same command for either shell. */
export function copilotHook(recorder: HookRecorder, label: string): Record<string, unknown> {
  const command = hookCommand(recorder, label);
  return { type: 'command', bash: command, powershell: command, timeoutSec: 30 };
}

/** The Copilot folder's `config.json`: the project trusted, and the recording hooks when asked. */
export function copilotConfig(options: {
  readonly project: string;
  readonly hookRecorder?: HookRecorder;
}): Record<string, unknown> {
  const recorder = options.hookRecorder;
  return {
    trustedFolders: [options.project],
    ...(recorder === undefined
      ? {}
      : {
          hooks: {
            sessionStart: [copilotHook(recorder, 'copilot-session-start')],
            agentStop: [copilotHook(recorder, 'copilot-agent-stop')],
            sessionEnd: [copilotHook(recorder, 'copilot-session-end')],
          },
        }),
  };
}

/** A Claude Code `.claude/settings.json` with a `Stop` hook, to see whether the CLI runs it. */
export function claudeHookSettings(recorder: HookRecorder, label = 'claude-stop'): unknown {
  return {
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: hookCommand(recorder, label) }] }],
    },
  };
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** The files of the run's Copilot folder, as `relative path → JSON text`. */
export function copilotHomeFiles(options: CopilotWorkspaceOptions): Record<string, string> {
  return {
    'mcp-config.json': json(copilotMcpConfig(options)),
    'config.json': json(copilotConfig(options)),
  };
}

/** The files of the run's project, as `relative path → JSON text`: a hook, or nothing. */
export function copilotProjectFiles(options: CopilotWorkspaceOptions): Record<string, string> {
  return options.hookRecorder === undefined
    ? {}
    : { '.claude/settings.json': json(claudeHookSettings(options.hookRecorder)) };
}

/**
 * The files of the run's home folder, as `relative path → JSON text`: the user-level Claude Code
 * `Stop` hook, which is the one Baton's Claude Code adapter writes, or nothing.
 */
export function copilotUserHomeFiles(options: CopilotWorkspaceOptions): Record<string, string> {
  return options.hookRecorder === undefined
    ? {}
    : {
        '.claude/settings.json': json(claudeHookSettings(options.hookRecorder, 'claude-stop-user')),
      };
}

/**
 * The `copilot -p` command line. `--output-format json` prints one session event per line;
 * `--usage-output-file` writes what the run cost. Nothing a run does may reach the user: no
 * question to the user, no custom instructions of the machine, no update, no export of the
 * session to GitHub.
 */
export function copilotArgs(options: {
  readonly prompt: string;
  readonly model: string;
  readonly usageFile: string;
}): string[] {
  return [
    '-p',
    options.prompt,
    '--output-format',
    'json',
    `--allow-tool=${COPILOT_TOOL_ALLOWANCE}`,
    ...COPILOT_DENIED_TOOLS.map((tool) => `--deny-tool=${tool}`),
    '--disable-builtin-mcps',
    '--no-ask-user',
    '--no-custom-instructions',
    '--no-auto-update',
    '--no-remote-export',
    '--model',
    options.model,
    '--usage-output-file',
    options.usageFile,
  ];
}

/**
 * The environment of the `copilot` child: the parent's, without `CLAUDECODE` and without any
 * `COPILOT_*` of the parent's, with `COPILOT_HOME` and the home folder moved to the run's
 * folders, updates off, and `HANDOFF_HOME` pointing at the run's folder so that nothing the CLI
 * starts can reach `~/.handoff/`. A `COPILOT_GITHUB_TOKEN` of the parent goes with the rest of
 * `COPILOT_*`: the run signs in through the gh login, as the owner's own sessions do (T-071),
 * and that login lives neither in `~/.copilot` nor in the home folder.
 */
export function copilotChildEnvironment(
  options: { readonly home: string; readonly copilotHome: string; readonly userHome: string },
  parent: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const child: Record<string, string> = {};
  for (const [name, value] of Object.entries(parent)) {
    if (value === undefined) continue;
    if (name === 'CLAUDECODE') continue;
    if (name.toUpperCase().startsWith('COPILOT_')) continue;
    child[name] = value;
  }
  child['COPILOT_HOME'] = options.copilotHome;
  child['COPILOT_AUTO_UPDATE'] = 'false';
  child['HANDOFF_HOME'] = options.home;
  child['USERPROFILE'] = options.userHome;
  child['HOME'] = options.userHome;
  return child;
}

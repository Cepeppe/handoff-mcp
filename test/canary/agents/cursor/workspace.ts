/**
 * The project, the command line and the environment of one Cursor Agent CLI run (T-069,
 * TECHNICAL-DESIGN §11.5, ADPT-06 item 2). The Cursor twin of `../opencode/workspace.ts`, and
 * pure for the same reason: `test/unit/canary/cursor.test.ts` pins every shape here without a
 * real agent, so a malformed file cannot make every Cursor canary fail for a reason that has
 * nothing to do with Cursor.
 *
 * Measured against the CLI 2026.09.10-fd3934a on 2026-09-11 (`docs/agent-facts.md`):
 *
 * 1. **Our server is declared in the run's own project**, `<project>/.cursor/mcp.json`, which
 *    the CLI reads from its workspace. A project server is refused until it is approved ("has
 *    not been approved"), so every run passes `--approve-mcps`.
 * 2. **One allowance, the narrowest there is.** In print mode the CLI refuses an MCP tool that
 *    is not annotated read-only — T-068 watched it wait two minutes and report `User rejected
 *    MCP` — unless a permission rule allows it. `<project>/.cursor/cli.json` allows
 *    `Mcp(handoff:*)`: our server's tools and nothing else. `--force` would allow every shell
 *    command and file write as well, and is never passed.
 * 3. **Hooks of the run's own**, when a scenario records them: `<project>/.cursor/hooks.json`
 *    declares Cursor's `stop` hook and `<project>/.claude/settings.json` a Claude Code `Stop`
 *    hook, both running `record-hook.mjs`, because Cursor runs Claude Code's hooks as its own
 *    (T-068).
 * 4. **`--trust`**, so the run's folder is trusted without a prompt, and `--workspace` names it.
 *
 * What it cannot isolate: the CLI has no switch that leaves the user's own
 * `~/.cursor/mcp.json`, `~/.cursor/hooks.json` or `~/.claude/settings.json` out. None of the
 * three existed on the machine these facts were measured on; where one does, its servers or
 * hooks run beside the canary's. Every run also leaves its conversation under `~/.cursor/`,
 * which the runner deletes afterwards.
 */
import { PROBE_ENV_VALUE } from '../../workspace.ts';

/** The name our server is declared under. Cursor calls the tools `handoff-<tool>`. */
export const CURSOR_MCP_SERVER_NAME = 'handoff';

/** The `HANDOFF_AGENT` an installer writes for Cursor (§5.6), and the table's key. */
export const CURSOR_AGENT_ID = 'cursor';

/**
 * The model every Cursor canary runs on unless `HANDOFF_CANARY_CURSOR_MODEL` says otherwise:
 * Cursor's own `auto`, the CLI's default and the one the Free plan the owner keeps offers
 * without question (T-068).
 */
export const CURSOR_DEFAULT_MODEL = 'auto';

/** The one permission rule a run carries: every tool of our server, and nothing else. */
export const CURSOR_MCP_PERMISSION = `Mcp(${CURSOR_MCP_SERVER_NAME}:*)`;

/** Where the recording hook writes, and the file it runs. */
export interface HookRecorder {
  readonly script: string;
  readonly out: string;
}

export interface CursorWorkspaceOptions {
  /** Absolute path of the built bundle, `dist/handoff-mcp.cjs`. */
  readonly serverBundle: string;
  /** The temporary `HANDOFF_HOME` of this run. */
  readonly home: string;
  /** The temporary project folder the CLI works in. */
  readonly project: string;
  /** The recording hook, for a scenario that records hooks; nothing declares no hook. */
  readonly hookRecorder?: HookRecorder;
}

/** One stdio server as Cursor's `mcp.json` spells it. */
export interface CursorMcpEntry {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

export interface CursorMcpConfig {
  readonly mcpServers: Readonly<Record<string, CursorMcpEntry>>;
}

/** The `env` of our entry: the five names of the Claude canary, with Cursor's id. */
export function cursorServerEnv(options: { readonly home: string }): Record<string, string> {
  return {
    HANDOFF_AGENT: CURSOR_AGENT_ID,
    HANDOFF_HOME: options.home,
    HANDOFF_CANARY: '1',
    HANDOFF_PROBE: PROBE_ENV_VALUE,
    HANDOFF_PROBE_TOKEN: PROBE_ENV_VALUE,
  };
}

/** The `mcp.json` that declares our server: `node <bundle> serve` and the environment. */
export function cursorMcpConfig(options: {
  readonly serverBundle: string;
  readonly home: string;
}): CursorMcpConfig {
  return {
    mcpServers: {
      [CURSOR_MCP_SERVER_NAME]: {
        command: process.execPath,
        args: [options.serverBundle, 'serve'],
        env: cursorServerEnv(options),
      },
    },
  };
}

/** The project's `cli.json`: the one permission rule, and nothing denied. */
export function cursorCliConfig(): {
  readonly permissions: { readonly allow: readonly string[]; readonly deny: readonly string[] };
} {
  return { permissions: { allow: [CURSOR_MCP_PERMISSION], deny: [] } };
}

/**
 * The command a hook runs: `node`, the recorder, the file it writes, and which declaration ran
 * it. Paths are written with forward slashes, which Node accepts on Windows and which no shell
 * Cursor may run the command through reads as an escape.
 */
export function hookCommand(recorder: HookRecorder, label: string): string {
  const slash = (path: string): string => path.split('\\').join('/');
  return `node "${slash(recorder.script)}" "${slash(recorder.out)}" ${label}`;
}

/** Cursor's own `hooks.json`: a `stop` hook, in the shape its validator asks for. */
export function cursorHooksConfig(recorder: HookRecorder): unknown {
  return { version: 1, hooks: { stop: [{ command: hookCommand(recorder, 'cursor-stop') }] } };
}

/** A Claude Code `.claude/settings.json` with a `Stop` hook, which Cursor runs as its own. */
export function claudeHookSettings(recorder: HookRecorder): unknown {
  return {
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: hookCommand(recorder, 'claude-stop') }] }],
    },
  };
}

/** Every file a run writes into its project, as `relative path → JSON text`. */
export function cursorProjectFiles(options: CursorWorkspaceOptions): Record<string, string> {
  const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
  const files: Record<string, string> = {
    '.cursor/mcp.json': json(cursorMcpConfig(options)),
    '.cursor/cli.json': json(cursorCliConfig()),
  };
  if (options.hookRecorder !== undefined) {
    files['.cursor/hooks.json'] = json(cursorHooksConfig(options.hookRecorder));
    files['.claude/settings.json'] = json(claudeHookSettings(options.hookRecorder));
  }
  return files;
}

/**
 * The `agent -p` command line, the prompt last. `stream-json` prints one event per line on
 * stdout; `--approve-mcps` approves the project's server and `--trust` the project, both for
 * this run only.
 */
export function cursorArgs(options: {
  readonly prompt: string;
  readonly model: string;
  readonly project: string;
}): string[] {
  return [
    '-p',
    '--output-format',
    'stream-json',
    '--approve-mcps',
    '--trust',
    '--model',
    options.model,
    '--workspace',
    options.project,
    options.prompt,
  ];
}

/**
 * The environment of the `agent` child: the parent's, without `CLAUDECODE`, and with
 * `HANDOFF_HOME` pointing at the run's folder, so that nothing the CLI starts — its server or a
 * hook — can reach `~/.handoff/`. The CLI hands its servers a filtered set of these (measured:
 * `USERDOMAIN` and `USERNAME` are in it, `CLAUDECODE` is not); a hook sees more.
 */
export function cursorChildEnvironment(
  options: { readonly home: string },
  parent: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const child: Record<string, string> = {};
  for (const [name, value] of Object.entries(parent)) {
    if (value === undefined) continue;
    if (name === 'CLAUDECODE') continue;
    child[name] = value;
  }
  child['HANDOFF_HOME'] = options.home;
  return child;
}

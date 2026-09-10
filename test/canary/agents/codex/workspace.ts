/**
 * The command line and the environment of one `codex exec` run (T-066, TECHNICAL-DESIGN
 * §11.5, ADPT-06 item 1). The Codex twin of `../../workspace.ts`, and pure for the same
 * reason: `test/unit/canary/codex.test.ts` pins every shape here without a real agent, so a
 * malformed override cannot make every Codex canary fail for a reason that has nothing to
 * do with Codex.
 *
 * Codex has no `--mcp-config` and no `--strict-mcp-config`. What keeps a run off the user's
 * own configuration, measured against Codex 0.153.4 on 2026-09-10, is three things that are
 * never optional here:
 *
 * 1. **`--ignore-user-config`.** It skips `~/.codex/config.toml` and keeps the login. A
 *    `-c mcp_servers.…` override *merges* with the servers a user declared (measured with a
 *    throw-away `CODEX_HOME`), so the override alone would not keep them out.
 * 2. **`--disable apps` and `--disable plugins`.** Both are on by default, and they are how a
 *    Codex session reaches the user's connected accounts. The browser and computer-use
 *    tools, image generation and sub-agents go as well: none of them is what a canary
 *    measures, and each can reach or spend something.
 * 3. **`--ephemeral`**, so a run leaves nothing in the user's session history.
 *
 * Our server is declared through `-c` overrides, one key at a time, and one of them is not
 * about isolation: `default_tools_approval_mode = "approve"`. Codex asks for an approval
 * before every call to a tool that is not annotated read-only, and `codex exec` answers that
 * request with a refusal ("MCP tool call requires approval, but approval policy is never").
 * `handoff_runbooks` is read-only; `handoff_to_user`, `handoff_verify` and the probe's tools
 * are not.
 */
import { PROBE_ENV_VALUE } from '../../workspace.ts';

/** The name our server is declared under. Codex reports a call as that server and a tool. */
export const CODEX_MCP_SERVER_NAME = 'handoff';

/** The `HANDOFF_AGENT` the installer writes for Codex (§5.6), and the table's key. */
export const CODEX_AGENT_ID = 'codex';

/**
 * The model every Codex canary runs on unless `HANDOFF_CANARY_CODEX_MODEL` says otherwise:
 * the one Codex's own model list describes as fast and affordable. Pinned for the same two
 * reasons as the Claude one — two runs stay comparable, and the cost stays bounded.
 */
export const CODEX_DEFAULT_MODEL = 'gpt-5.6-luna';

/** A canary asks for one tool call and a one-word answer; it needs no deliberation. */
export const CODEX_REASONING_EFFORT = 'low';

/** The features a canary run turns off. `apps` and `plugins` are the isolation. */
export const CODEX_DISABLED_FEATURES: readonly string[] = [
  'apps',
  'plugins',
  'browser_use',
  'browser_use_external',
  'computer_use',
  'in_app_browser',
  'image_generation',
  'multi_agent',
];

/** `default_tools_approval_mode` of our entry: without it `codex exec` refuses our tools. */
export const CODEX_APPROVAL_MODE = 'approve';

export interface CodexWorkspaceOptions {
  /** Absolute path of the built bundle, `dist/handoff-mcp.cjs`. */
  readonly serverBundle: string;
  /** The temporary `HANDOFF_HOME` of this run. */
  readonly home: string;
  /** The temporary project folder Codex is started in (`-C`). */
  readonly project: string;
  /** The per-server `tool_timeout_sec`, in seconds, written only when a scenario measures it. */
  readonly toolTimeoutSec?: number;
}

/**
 * A TOML basic string. JSON's escapes — the quote, the backslash and `\uXXXX` for a control
 * character — are all TOML escapes too, so a Windows path keeps its backslashes.
 */
export function tomlString(value: string): string {
  return JSON.stringify(value);
}

/** A TOML inline table of strings, `{A="x",B="y"}`. Every key used here is a bare key. */
export function tomlInlineTable(entries: Readonly<Record<string, string>>): string {
  const pairs = Object.entries(entries).map(([key, value]) => `${key}=${tomlString(value)}`);
  return `{${pairs.join(',')}}`;
}

/** The `env` block of our entry: the five names of the Claude canary, with Codex's id. */
export function codexServerEnv(options: CodexWorkspaceOptions): Record<string, string> {
  return {
    HANDOFF_AGENT: CODEX_AGENT_ID,
    HANDOFF_HOME: options.home,
    HANDOFF_CANARY: '1',
    HANDOFF_PROBE: PROBE_ENV_VALUE,
    HANDOFF_PROBE_TOKEN: PROBE_ENV_VALUE,
  };
}

/**
 * The `-c` overrides that declare our server, one key each: `node <bundle> serve`, the `env`
 * block, the approval mode, and the per-server timeout when a scenario measures it.
 */
export function codexServerOverrides(options: CodexWorkspaceOptions): string[] {
  const key = `mcp_servers.${CODEX_MCP_SERVER_NAME}`;
  return [
    '-c',
    `${key}.command=${tomlString(process.execPath)}`,
    '-c',
    `${key}.args=[${tomlString(options.serverBundle)},"serve"]`,
    '-c',
    `${key}.env=${tomlInlineTable(codexServerEnv(options))}`,
    '-c',
    `${key}.default_tools_approval_mode=${tomlString(CODEX_APPROVAL_MODE)}`,
    ...(options.toolTimeoutSec === undefined
      ? []
      : ['-c', `${key}.tool_timeout_sec=${String(options.toolTimeoutSec)}`]),
  ];
}

/**
 * The `codex exec` command line, the prompt last. `--json` prints one event per line on
 * stdout, `--skip-git-repo-check` lets it run in a temporary folder that is no repository,
 * and `-s read-only` is the sandbox for any shell command the model might try: a canary
 * asks for tool calls and nothing else.
 */
export function codexArgs(options: {
  readonly prompt: string;
  readonly model: string;
  readonly workspace: CodexWorkspaceOptions;
}): string[] {
  return [
    'exec',
    '--json',
    '--ephemeral',
    '--ignore-user-config',
    '--skip-git-repo-check',
    '-C',
    options.workspace.project,
    '-m',
    options.model,
    '-c',
    `model_reasoning_effort=${tomlString(CODEX_REASONING_EFFORT)}`,
    '-s',
    'read-only',
    ...CODEX_DISABLED_FEATURES.flatMap((feature) => ['--disable', feature]),
    ...codexServerOverrides(options.workspace),
    options.prompt,
  ];
}

/**
 * The environment of the `codex` child: the parent's, without `CLAUDECODE` — the harness is
 * normally started from a Claude Code session and nothing of it belongs in a Codex one —
 * and with the run's `HANDOFF_HOME`. Codex hands its MCP servers a whitelist of its own plus
 * the entry's `env` block, so our server gets `HANDOFF_HOME` through that block, not from
 * here.
 */
export function codexChildEnvironment(
  options: CodexWorkspaceOptions,
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

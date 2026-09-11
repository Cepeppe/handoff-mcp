/**
 * Configuration from the environment (TECHNICAL-DESIGN §5.12, §5.3).
 *
 * This module is the **only** place in `src/` that touches `process.env`, and
 * `test/unit/env-names.test.ts` enforces that by grepping the tree. The reason is A-23:
 * Claude Code strips variables whose name contains `TOKEN`, `SECRET`, `PASSWORD`, `KEY`
 * or `AUTH` from servers declared in project scope, so every name we read has to be
 * checked against that list — which is only possible if they are all declared here.
 *
 * Reading is pure and total: `readConfig` never throws and never logs. A value it cannot
 * use is reported in `ignored` and the caller (`serve`, `doctor`) decides what to say
 * about it, so nothing writes to stderr before the CLI has chosen its level.
 */
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { DEFAULT_LOG_LEVEL, LOG_LEVELS, type LogLevel } from './log';

/**
 * Every environment variable the server reads, in the order §5.3 lists them. Four of them
 * are the agent's, not ours, and are read where the agent already sets them:
 * `MCP_TOOL_TIMEOUT` and `CLAUDE_PROJECT_DIR` (Claude Code), `WORKSPACE_FOLDER_PATHS`
 * (Cursor's editor) and `VSCODE_PID` (every editor of the VS Code family), the last two since
 * T-069. The last two of the list are Windows' own, and name the pipe (§5.8, DD-26). They are
 * configuration in the same sense as the rest — something outside the process decides them
 * and the server only reads them — and they are here for the reason the module comment
 * gives: every name has to pass the A-23 check, which is only possible if they are all
 * declared in one place.
 */
export const ENV_VAR_NAMES = [
  'HANDOFF_AGENT',
  'HANDOFF_TOOL_TIMEOUT_MS',
  'MCP_TOOL_TIMEOUT',
  'HANDOFF_HOME',
  'CLAUDE_PROJECT_DIR',
  'HANDOFF_MCP_LOG',
  'HANDOFF_CANARY',
  'WORKSPACE_FOLDER_PATHS',
  'VSCODE_PID',
  'USERDOMAIN',
  'USERNAME',
] as const;

export type EnvVarName = (typeof ENV_VAR_NAMES)[number];

/**
 * The substrings A-23 says Claude Code strips from the environment of a project-scope
 * server. No name above may contain one of them; the unit test asserts it.
 */
export const STRIPPED_ENV_SUBSTRINGS: readonly string[] = [
  'TOKEN',
  'SECRET',
  'PASSWORD',
  'KEY',
  'AUTH',
];

/** The folder name under the user's home when `HANDOFF_HOME` is not set (§4.1). */
export const HOME_FOLDER_NAME = '.handoff';

/** A `process.env`-shaped record, injectable so tests never mutate the real environment. */
export type EnvRecord = Readonly<Record<string, string | undefined>>;

export interface Config {
  /** `HANDOFF_AGENT`, the installer-written agent id. Authoritative when it names a row. */
  readonly agent: string | undefined;
  /** `HANDOFF_TOOL_TIMEOUT_MS`, the timeout the installer actually configured. */
  readonly toolTimeoutMs: number | undefined;
  /** `MCP_TOOL_TIMEOUT`, Claude Code's own variable, inherited from its settings (A-03). */
  readonly mcpToolTimeoutMs: number | undefined;
  /** `HANDOFF_HOME` or `~/.handoff`: the folder shared with the app (§4.1). */
  readonly home: string;
  /**
   * `CLAUDE_PROJECT_DIR`, else the first folder of `WORKSPACE_FOLDER_PATHS`, else the working
   * directory (A-24, §5.8, T-069).
   */
  readonly projectDir: string;
  /** `HANDOFF_MCP_LOG`, `error` unless it says `debug`. */
  readonly logLevel: LogLevel;
  /**
   * `HANDOFF_CANARY=1`: the canary probe of `src/mcp/canary.ts` is on (T-023). It adds a
   * test tool and writes an observation file under `home`, and it is off in every other
   * run, including every test of this repository that does not set the variable.
   */
  readonly canary: boolean;
  /**
   * `VSCODE_PID`: the process id an editor of the VS Code family gives its main process and
   * hands on to what its extension host starts (T-069). A pointer and nothing more:
   * `src/adapters/editor.ts` believes it only when the ancestor chain shows that editor
   * starting the server. `undefined` when unset or not a positive whole number.
   */
  readonly editorPid: number | undefined;
  /** Variables that were set to something unusable and are being treated as unset. */
  readonly ignored: readonly EnvVarName[];
}

/** Trims, and treats a blank value as unset: an empty variable is not a configuration. */
function readString(env: EnvRecord, name: EnvVarName): string | undefined {
  const raw = env[name];
  if (raw === undefined) return undefined;
  const value = raw.trim();
  return value === '' ? undefined : value;
}

/**
 * A duration in milliseconds: digits only, at least 1, and small enough to stay an exact
 * integer. Anything else — a unit suffix, a float, zero, a negative — is not a timeout we
 * can subtract a margin from, so it is refused rather than coerced.
 */
function readDurationMs(
  env: EnvRecord,
  name: EnvVarName,
  ignored: EnvVarName[],
): number | undefined {
  const value = readString(env, name);
  if (value === undefined) return undefined;
  if (!/^\d+$/u.test(value)) {
    ignored.push(name);
    return undefined;
  }
  const ms = Number(value);
  if (ms < 1 || !Number.isSafeInteger(ms)) {
    ignored.push(name);
    return undefined;
  }
  return ms;
}

/** A process id: digits only and at least 1. Anything else names no process we could find. */
function readProcessId(
  env: EnvRecord,
  name: EnvVarName,
  ignored: EnvVarName[],
): number | undefined {
  const value = readString(env, name);
  if (value === undefined) return undefined;
  const pid = /^\d+$/u.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(pid) || pid < 1) {
    ignored.push(name);
    return undefined;
  }
  return pid;
}

function readLogLevel(env: EnvRecord, ignored: EnvVarName[]): LogLevel {
  const value = readString(env, 'HANDOFF_MCP_LOG');
  if (value === undefined) return DEFAULT_LOG_LEVEL;
  const level = value.toLowerCase();
  const known = LOG_LEVELS.find((candidate) => candidate === level);
  if (known === undefined) {
    ignored.push('HANDOFF_MCP_LOG');
    return DEFAULT_LOG_LEVEL;
  }
  return known;
}

/**
 * The first folder of `WORKSPACE_FOLDER_PATHS` (T-069), or `undefined` when it names none.
 *
 * Cursor's editor starts every stdio server in the user's home folder and says where the
 * workspace is only in this variable, the workspace folders joined by commas (measured
 * against Cursor 3.20.10, `docs/agent-facts.md`). For a session the editor started, the
 * working directory is therefore no project at all, and the folder the app shows in the tab
 * and keys its fallback on (OPEN-02, SRV-18) has to come from here. A workspace folder is an
 * absolute path, so a piece that is not one is the rest of a path that had a comma in it and
 * is joined back to the piece before it. The first folder of a multi-root workspace is its
 * main one.
 */
export function firstWorkspaceFolder(
  value: string | undefined,
  absolute: (path: string) => boolean = isAbsolute,
): string | undefined {
  if (value === undefined) return undefined;
  const folders: string[] = [];
  for (const piece of value.split(',')) {
    const previous = folders.length - 1;
    if (previous >= 0 && !absolute(piece.trim())) {
      folders[previous] = `${folders[previous] ?? ''},${piece}`;
    } else {
      folders.push(piece);
    }
  }
  return folders.map((folder) => folder.trim()).find((folder) => folder !== '' && absolute(folder));
}

/**
 * `HANDOFF_HOME` as it was set, or `undefined`. The Windows pipe name mixes this value in
 * when it is present (§0.4 item 4 of `TASKS.md`), so the two peers have to agree on what
 * "set" means: the trimmed value, exactly the one `homeDir` uses, so that the pipe and the
 * folder can never disagree about which instance is being addressed.
 */
export function homeOverride(env: EnvRecord = process.env): string | undefined {
  return readString(env, 'HANDOFF_HOME');
}

/**
 * `HANDOFF_HOME` when set, else `~/.handoff` (§4.1, §5.12). `HANDOFF_HOME` exists for
 * tests and for the e2e isolation of §0.4 item 4; nothing in production sets it.
 */
export function homeDir(env: EnvRecord = process.env): string {
  return homeOverride(env) ?? join(homedir(), HOME_FOLDER_NAME);
}

/**
 * `USERDOMAIN\USERNAME` in lower case: the Windows identity the named pipe is derived from
 * (§4.1, §5.8, DD-26). A variable that is not set contributes an empty string rather than a
 * substitute from another source, because the app derives the same name from the same two
 * variables and any cleverness on one side would move the endpoint out from under the
 * other.
 */
export function windowsUserKey(env: EnvRecord = process.env): string {
  const domain = readString(env, 'USERDOMAIN') ?? '';
  const user = readString(env, 'USERNAME') ?? '';
  return `${domain}\\${user}`.toLowerCase();
}

/**
 * Which of `names` are set to something other than blank, **by name only**.
 *
 * The canary of T-023 has to report whether a variable reached the server without the
 * server depending on it, and two of the names it asks about — `HANDOFF_PROBE` and
 * `HANDOFF_PROBE_TOKEN` — exist precisely because one of them falls foul of A-23 and the
 * other does not. Declaring them in `ENV_VAR_NAMES` would make the list fail the rule it
 * exists to enforce, so this function looks names up dynamically instead: it is still the
 * only module touching `process.env`, and the caller owns the list.
 *
 * It answers with names, never with values: a variable of the user's environment may hold
 * anything, and nothing this returns is allowed to become a secret in a log (R-19).
 */
export function envNamesPresent(
  names: readonly string[],
  env: EnvRecord = process.env,
): readonly string[] {
  return names.filter((name) => (env[name] ?? '').trim() !== '');
}

/** Reads the whole environment once, at startup (§5.3). */
export function readConfig(env: EnvRecord = process.env, cwd: string = process.cwd()): Config {
  const ignored: EnvVarName[] = [];
  return {
    agent: readString(env, 'HANDOFF_AGENT'),
    toolTimeoutMs: readDurationMs(env, 'HANDOFF_TOOL_TIMEOUT_MS', ignored),
    mcpToolTimeoutMs: readDurationMs(env, 'MCP_TOOL_TIMEOUT', ignored),
    home: homeDir(env),
    projectDir:
      readString(env, 'CLAUDE_PROJECT_DIR') ??
      firstWorkspaceFolder(readString(env, 'WORKSPACE_FOLDER_PATHS')) ??
      cwd,
    logLevel: readLogLevel(env, ignored),
    canary: readString(env, 'HANDOFF_CANARY') === '1',
    editorPid: readProcessId(env, 'VSCODE_PID', ignored),
    ignored,
  };
}

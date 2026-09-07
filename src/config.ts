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
import { join } from 'node:path';

import { DEFAULT_LOG_LEVEL, LOG_LEVELS, type LogLevel } from './log';

/**
 * Every environment variable the server reads, in the order §5.3 lists them. Two of them
 * are the agent's, not ours (`MCP_TOOL_TIMEOUT`, `CLAUDE_PROJECT_DIR`) and are read where
 * the agent already sets them; the last two are Windows' own, and name the pipe (§5.8,
 * DD-26). They are configuration in the same sense as the rest — something outside the
 * process decides them and the server only reads them — and they are here for the reason
 * the module comment gives: every name has to pass the A-23 check, which is only possible
 * if they are all declared in one place.
 */
export const ENV_VAR_NAMES = [
  'HANDOFF_AGENT',
  'HANDOFF_TOOL_TIMEOUT_MS',
  'MCP_TOOL_TIMEOUT',
  'HANDOFF_HOME',
  'CLAUDE_PROJECT_DIR',
  'HANDOFF_MCP_LOG',
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
  /** `CLAUDE_PROJECT_DIR` or the working directory (A-24, §5.8). */
  readonly projectDir: string;
  /** `HANDOFF_MCP_LOG`, `error` unless it says `debug`. */
  readonly logLevel: LogLevel;
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

/** Reads the whole environment once, at startup (§5.3). */
export function readConfig(env: EnvRecord = process.env, cwd: string = process.cwd()): Config {
  const ignored: EnvVarName[] = [];
  return {
    agent: readString(env, 'HANDOFF_AGENT'),
    toolTimeoutMs: readDurationMs(env, 'HANDOFF_TOOL_TIMEOUT_MS', ignored),
    mcpToolTimeoutMs: readDurationMs(env, 'MCP_TOOL_TIMEOUT', ignored),
    home: homeDir(env),
    projectDir: readString(env, 'CLAUDE_PROJECT_DIR') ?? cwd,
    logLevel: readLogLevel(env, ignored),
    ignored,
  };
}

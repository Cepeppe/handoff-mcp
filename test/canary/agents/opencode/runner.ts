/**
 * One `opencode run`, start to finish (T-074, TECHNICAL-DESIGN §11.5) — the OpenCode twin of
 * `../../runner.ts` and `../codex/runner.ts`. It returns the same `CanaryRun`, so the
 * classifier, the driver and the report never ask which agent produced it.
 *
 * OpenCode prints one JSON event per line (`--format json`), each carrying the session id:
 * `step_start`, `tool_use`, `text`, `step_finish` and, when the provider refuses, `error`.
 * `parseOpenCodeEvents` maps them onto the shared shape: every `tool_use` part is one tool use
 * and one tool result, named `mcp__handoff__<tool>` as Claude Code names it, and a `result`
 * message is made from the last text once a step has finished. Every event is also stamped
 * with the instant its line arrived, as for Codex.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  SERVER_BUNDLE,
  readNdjson,
  type CanaryRun,
  type Observation,
  type ToolResultBlock,
  type ToolUse,
  type TranscriptMessage,
} from '../../runner.ts';
import type { CanaryApp } from '../codex/runner.ts';
import {
  OPENCODE_DEFAULT_MODEL,
  OPENCODE_MCP_SERVER_NAME,
  opencodeArgs,
  opencodeChildEnvironment,
  opencodeDeleteArgs,
  type OpenCodeWorkspaceOptions,
} from './workspace.ts';

/** How long a whole OpenCode run may take before it is killed and reported as a protocol failure. */
export const OPENCODE_DEFAULT_TIMEOUT_MS = 300_000;

/** What an OpenCode scenario asks the harness for. */
export interface OpenCodeRunOptions {
  readonly prompt: string;
  readonly model?: string;
  readonly timeoutMs?: number;
  /** The per-server `timeout` of our entry, in milliseconds (A-04). */
  readonly entryTimeoutMs?: number;
  /** Starts an overlay on the run's `HANDOFF_HOME` before the agent, and stops it after. */
  readonly app?: (home: string) => Promise<CanaryApp>;
}

/** How to start `opencode`: the program, what goes before our arguments, and whether a shell is needed. */
export interface OpenCodeCommand {
  readonly command: string;
  readonly prefix: readonly string[];
  readonly shell: boolean;
}

/**
 * Where npm puts the native OpenCode executable, relative to the folder of its shims. The
 * `opencode-ai` package's `bin` is the executable itself, copied there by its install script.
 */
export const NPM_OPENCODE_LAUNCHER: readonly string[] = [
  'node_modules',
  'opencode-ai',
  'bin',
  'opencode.exe',
];

/**
 * Picks the way to start `opencode` from what `where`/`which` found.
 *
 * A native executable on `PATH` is started directly. An npm install on Windows leaves a `.cmd`
 * shim, which only runs through `cmd.exe`, whose quoting would mangle the JSON a prompt carries;
 * so the shim is bypassed for the executable it calls, and a shell is used only when that
 * executable is not beside it. On Windows an extensionless match is the shell-script shim and
 * is skipped.
 */
export function opencodeCommandFrom(
  found: readonly string[],
  platform: { readonly windows: boolean; readonly exists: (path: string) => boolean },
): OpenCodeCommand {
  const usable = found.filter((path) => !platform.windows || /\.(?:exe|cmd|bat)$/iu.test(path));
  const first = usable[0];
  if (first === undefined) return { command: 'opencode', prefix: [], shell: false };
  const lower = first.toLowerCase();
  if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
    const launcher = join(dirname(first), ...NPM_OPENCODE_LAUNCHER);
    return platform.exists(launcher)
      ? { command: launcher, prefix: [], shell: false }
      : { command: first, prefix: [], shell: true };
  }
  return { command: first, prefix: [], shell: false };
}

/** `HANDOFF_CANARY_OPENCODE` when it names a program, else the first `opencode` on `PATH`. */
export function resolveOpenCode(
  env: Readonly<Record<string, string | undefined>> = process.env,
): OpenCodeCommand {
  const platform = { windows: process.platform === 'win32', exists: existsSync };
  const override = env['HANDOFF_CANARY_OPENCODE']?.trim();
  if (override !== undefined && override !== '') return opencodeCommandFrom([override], platform);
  let found: string[] = [];
  try {
    found = execFileSync(platform.windows ? 'where' : 'which', ['opencode'], {
      encoding: 'utf8',
      windowsHide: true,
    })
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line !== '');
  } catch {
    // Not on PATH: the spawn reports it, and the driver stops with exit 2.
  }
  return opencodeCommandFrom(found, platform);
}

/** One line of OpenCode's stdout, and the instant it arrived when that was recorded. */
export interface OpenCodeLine {
  readonly line: string;
  readonly at?: number;
}

/** What `parseOpenCodeEvents` makes of a run's stdout. */
export interface ParsedOpenCodeRun {
  readonly transcript: readonly TranscriptMessage[];
  readonly toolUses: readonly ToolUse[];
  readonly toolResults: readonly ToolResultBlock[];
  readonly result: TranscriptMessage | undefined;
  /** The session OpenCode created for the run, which the runner deletes afterwards. */
  readonly sessionId: string | undefined;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * A tool name as Claude Code spells it. OpenCode names an MCP tool `<server>_<tool>`, so ours
 * are `handoff_<tool>`; a built-in tool keeps its own name.
 */
export function opencodeToolName(tool: string): string {
  const prefix = `${OPENCODE_MCP_SERVER_NAME}_`;
  return tool.startsWith(prefix)
    ? `mcp__${OPENCODE_MCP_SERVER_NAME}__${tool.slice(prefix.length)}`
    : tool;
}

/**
 * OpenCode's JSON events as the shared transcript shape. A line that is not a JSON object with
 * a `type` is dropped here and shows up as a missing result instead, which the run's first
 * assertion reports.
 */
export function parseOpenCodeEvents(lines: readonly OpenCodeLine[]): ParsedOpenCodeRun {
  const transcript: TranscriptMessage[] = [];
  for (const { line, at } of lines) {
    if (line.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const event = asRecord(parsed);
    const type = event?.['type'];
    if (event === undefined || typeof type !== 'string') continue;
    transcript.push({
      ...event,
      type,
      ...(at === undefined ? {} : { received_at: new Date(at).toISOString() }),
    });
  }

  const toolUses: ToolUse[] = [];
  const toolResults: ToolResultBlock[] = [];
  let sessionId: string | undefined;
  let reply = '';
  let steps = 0;
  let failed = false;
  let error = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let cost = 0;
  for (const event of transcript) {
    const session = event['sessionID'];
    if (sessionId === undefined && typeof session === 'string') sessionId = session;
    if (event.type === 'error') {
      failed = true;
      const details = asRecord(event['error']);
      error = asText(asRecord(details?.['data'])?.['message']) || asText(details?.['name']);
      continue;
    }
    const part = asRecord(event['part']);
    if (part === undefined) continue;
    if (event.type === 'step_finish') {
      steps += 1;
      const tokens = asRecord(part['tokens']);
      inputTokens += asNumber(tokens?.['input']);
      outputTokens += asNumber(tokens?.['output']);
      cost += asNumber(part['cost']);
      continue;
    }
    if (event.type === 'text') {
      const text = asText(part['text']);
      if (text.trim() !== '') reply = text;
      continue;
    }
    if (event.type !== 'tool_use') continue;
    const state = asRecord(part['state']);
    const id = asText(part['callID']) || asText(part['id']);
    const completed = state?.['status'] === 'completed';
    toolUses.push({ name: opencodeToolName(asText(part['tool'])), input: state?.['input'], id });
    toolResults.push({
      tool_use_id: id,
      isError: !completed,
      text: completed ? asText(state['output']) : asText(state?.['error']),
    });
  }

  const result: TranscriptMessage | undefined =
    steps === 0 && !failed
      ? undefined
      : {
          type: 'result',
          subtype: failed ? 'error' : 'success',
          is_error: failed,
          result: failed && reply === '' ? error : reply,
          num_turns: steps,
          total_cost_usd: cost,
          usage: { input_tokens: inputTokens, output_tokens: outputTokens },
        };
  return { transcript, toolUses, toolResults, result, sessionId };
}

/** Spawns `opencode`, collects stdout line by line with arrival times, and kills it past the budget. */
function spawnOpenCode(
  args: readonly string[],
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
): Promise<{ lines: OpenCodeLine[]; stderr: string; code: number | null; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const opencode = resolveOpenCode();
    const child = spawn(opencode.command, [...opencode.prefix, ...args], {
      cwd,
      env,
      shell: opencode.shell,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const lines: OpenCodeLine[] = [];
    let pending = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      pending += chunk;
      let newline = pending.indexOf('\n');
      while (newline !== -1) {
        lines.push({ line: pending.slice(0, newline), at: Date.now() });
        pending = pending.slice(newline + 1);
        newline = pending.indexOf('\n');
      }
    });
    child.stderr.on('data', (chunk: string) => (stderr += chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (pending.trim() !== '') lines.push({ line: pending, at: Date.now() });
      resolve({ lines, stderr, code, timedOut });
    });
  });
}

/**
 * Removes the run's session from the user's OpenCode history. Best effort: a session that
 * could not be deleted is a line in a list, not a failed canary.
 */
function deleteSession(sessionId: string, cwd: string, env: Record<string, string>): void {
  const opencode = resolveOpenCode();
  try {
    execFileSync(opencode.command, [...opencode.prefix, ...opencodeDeleteArgs(sessionId)], {
      cwd,
      env,
      shell: opencode.shell,
      windowsHide: true,
      stdio: 'ignore',
      timeout: 60_000,
    });
  } catch {
    // Nothing to report: see above.
  }
}

/**
 * Runs one scenario against the real OpenCode and returns everything it produced.
 *
 * The temporary root is removed when the run ends, unless `HANDOFF_CANARY_KEEP=1`. There is no
 * hook record: OpenCode has no command hook to declare (docs/agent-facts.md).
 */
export async function runOpenCode(options: OpenCodeRunOptions): Promise<CanaryRun> {
  const root = mkdtempSync(join(tmpdir(), 'handoff-canary-opencode-'));
  const project = join(root, 'project');
  const home = join(root, 'home');
  const configHome = join(root, 'config');
  for (const folder of [project, home, configHome]) mkdirSync(folder, { recursive: true });

  const workspace: OpenCodeWorkspaceOptions = {
    serverBundle: SERVER_BUNDLE,
    home,
    project,
    configHome,
    ...(options.entryTimeoutMs === undefined ? {} : { timeoutMs: options.entryTimeoutMs }),
  };
  const args = opencodeArgs({
    prompt: options.prompt,
    model: options.model ?? process.env['HANDOFF_CANARY_OPENCODE_MODEL'] ?? OPENCODE_DEFAULT_MODEL,
  });
  const env = opencodeChildEnvironment(workspace);

  const app = options.app === undefined ? undefined : await options.app(home);
  const started = Date.now();
  let child: Awaited<ReturnType<typeof spawnOpenCode>>;
  try {
    child = await spawnOpenCode(
      args,
      project,
      env,
      options.timeoutMs ?? OPENCODE_DEFAULT_TIMEOUT_MS,
    );
  } catch (cause) {
    await app?.stop();
    throw cause;
  }
  const durationMs = Date.now() - started;
  const appTranscript = app?.transcript();
  await app?.stop();

  const parsed = parseOpenCodeEvents(child.lines);
  if (parsed.sessionId !== undefined) deleteSession(parsed.sessionId, project, env);

  const run: CanaryRun = {
    exitCode: child.code,
    durationMs,
    timedOut: child.timedOut,
    stderr: child.stderr,
    transcript: parsed.transcript,
    observations: readNdjson<Observation>(join(home, 'canary', 'observations.jsonl')),
    hookRecords: [],
    toolUses: parsed.toolUses,
    toolResults: parsed.toolResults,
    result: parsed.result,
    workspace: root,
    ...(appTranscript === undefined ? {} : { app: appTranscript }),
  };

  if (process.env['HANDOFF_CANARY_KEEP'] !== '1') {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // A server OpenCode has not reaped yet can hold a file for a moment; the folder is under
      // the temporary directory either way, and a failed cleanup is not a failed canary.
    }
  }
  return run;
}

/** The project folder an OpenCode run was started in. */
export function opencodeProjectOf(run: CanaryRun): string {
  return join(run.workspace, 'project');
}

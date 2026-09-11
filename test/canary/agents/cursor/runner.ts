/**
 * One Cursor Agent CLI run, start to finish (T-069, TECHNICAL-DESIGN §11.5) — the Cursor twin
 * of `../opencode/runner.ts`. It returns the same `CanaryRun`, so the classifier, the driver and
 * the report never ask which agent produced it.
 *
 * `agent -p --output-format stream-json` prints one JSON event per line: `system`/`init`, the
 * `user` prompt, `assistant` text, `thinking` deltas, a `tool_call` event `started` and one
 * `completed` for every call, and a final `result`. A call travels as Cursor's own protocol
 * message — `mcpToolCall` with its `args` (`name`, `toolName`, `providerIdentifier`, `args`) and
 * its `result` (`success`, `error`, `rejected` or `permissionDenied`) — which
 * `parseCursorEvents` maps onto the shared shape: our tools are named `mcp__handoff__<tool>` as
 * Claude Code names them, and the text of a result is the text of its content. A completed
 * shell call can also carry a snapshot of the shell's environment (`env`); it is dropped from
 * the event before anything else sees it.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SERVER_BUNDLE,
  readNdjson,
  type CanaryRun,
  type HookRecord,
  type Observation,
  type ToolResultBlock,
  type ToolUse,
  type TranscriptMessage,
} from '../../runner.ts';
import type { CanaryApp } from '../codex/runner.ts';
import {
  CURSOR_DEFAULT_MODEL,
  CURSOR_MCP_SERVER_NAME,
  cursorArgs,
  cursorChildEnvironment,
  cursorProjectFiles,
  type CursorWorkspaceOptions,
} from './workspace.ts';

/** How long a whole Cursor run may take before it is killed and reported as a protocol failure. */
export const CURSOR_DEFAULT_TIMEOUT_MS = 300_000;

/** The recording hook, beside this file. */
export const CURSOR_HOOK_RECORDER = fileURLToPath(new URL('./record-hook.mjs', import.meta.url));

/** What a Cursor CLI scenario asks the harness for. */
export interface CursorRunOptions {
  readonly prompt: string;
  readonly model?: string;
  readonly timeoutMs?: number;
  /** Declares the recording hooks in the run's project. */
  readonly recordHooks?: boolean;
  /** Starts an overlay on the run's `HANDOFF_HOME` before the agent, and stops it after. */
  readonly app?: (home: string) => Promise<CanaryApp>;
}

/** How to start `agent`: the program, what goes before our arguments, and whether a shell is needed. */
export interface CursorCommand {
  readonly command: string;
  readonly prefix: readonly string[];
  readonly shell: boolean;
}

/**
 * The version folder of a standalone Cursor Agent install, `YYYY.MM.DD-<commit>`, as a number
 * that sorts the way `cursor-agent.ps1` sorts them, or `undefined` for any other name.
 */
export function cursorVersionRank(name: string): number | undefined {
  const match = /^(\d{4})\.(\d{1,2})\.(\d{1,2})-/u.exec(name);
  if (match === null) return undefined;
  const [, year = '', month = '', day = ''] = match;
  return Number(`${year}${month.padStart(2, '0')}${day.padStart(2, '0')}`);
}

/**
 * Picks the way to start the Cursor Agent CLI from what `where`/`which` found.
 *
 * On Windows the install puts `agent.cmd` and `cursor-agent.cmd` on `PATH`, and they reach the
 * CLI through `cmd.exe` and then PowerShell, whose quoting would mangle the JSON a prompt
 * carries. So a `.cmd` shim is bypassed for what `cursor-agent.ps1` itself starts — the
 * `node.exe` and `index.js` of the newest folder under `versions` — and a shell is used only
 * when no such folder is beside it. Anywhere else the launcher is started directly.
 */
export function cursorCommandFrom(
  found: readonly string[],
  platform: {
    readonly windows: boolean;
    readonly exists: (path: string) => boolean;
    readonly list: (folder: string) => readonly string[];
  },
): CursorCommand {
  const usable = found.filter((path) => !platform.windows || /\.(?:exe|cmd|bat)$/iu.test(path));
  const first = usable[0];
  if (first === undefined) return { command: 'agent', prefix: [], shell: platform.windows };
  if (!/\.(?:cmd|bat)$/iu.test(first)) return { command: first, prefix: [], shell: false };

  const versions = join(dirname(first), 'versions');
  const candidates = platform
    .list(versions)
    .map((name) => ({ name, rank: cursorVersionRank(name) }))
    .filter((entry): entry is { name: string; rank: number } => entry.rank !== undefined)
    .sort((a, b) => b.rank - a.rank || (a.name < b.name ? 1 : -1));
  for (const { name } of candidates) {
    const node = join(versions, name, 'node.exe');
    const index = join(versions, name, 'index.js');
    if (platform.exists(node) && platform.exists(index)) {
      return { command: node, prefix: [index], shell: false };
    }
  }
  return { command: first, prefix: [], shell: true };
}

/** The CLI version a command runs, from its version folder, or `null` when it cannot tell. */
export function cursorCliVersion(command: CursorCommand): string | null {
  const index = command.prefix[0];
  if (index === undefined) return null;
  const folder = basename(dirname(index));
  return cursorVersionRank(folder) === undefined ? null : folder;
}

function listFolder(folder: string): readonly string[] {
  try {
    return readdirSync(folder);
  } catch {
    return [];
  }
}

/** `HANDOFF_CANARY_CURSOR` when it names a program, else `cursor-agent` or `agent` on `PATH`. */
export function resolveCursorAgent(
  env: Readonly<Record<string, string | undefined>> = process.env,
): CursorCommand {
  const platform = { windows: process.platform === 'win32', exists: existsSync, list: listFolder };
  const override = env['HANDOFF_CANARY_CURSOR']?.trim();
  if (override !== undefined && override !== '') return cursorCommandFrom([override], platform);
  for (const name of ['cursor-agent', 'agent']) {
    try {
      const found = execFileSync(platform.windows ? 'where' : 'which', [name], {
        encoding: 'utf8',
        windowsHide: true,
      })
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line !== '');
      if (found.length > 0) return cursorCommandFrom(found, platform);
    } catch {
      // Not on PATH under this name: try the next one.
    }
  }
  return cursorCommandFrom([], platform);
}

/** One line of the CLI's stdout, and the instant it arrived when that was recorded. */
export interface CursorLine {
  readonly line: string;
  readonly at?: number;
}

/** What `parseCursorEvents` makes of a run's stdout. */
export interface ParsedCursorRun {
  readonly transcript: readonly TranscriptMessage[];
  readonly toolUses: readonly ToolUse[];
  readonly toolResults: readonly ToolResultBlock[];
  readonly result: TranscriptMessage | undefined;
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

/**
 * The kind of a Cursor tool call and its body. The message prints as canonical protobuf JSON,
 * `{ "mcpToolCall": { … } }`; the in-memory shape `{ tool: { case, value } }` is read as well,
 * so a CLI that stops calling `toJSON` does not turn every call into nothing.
 */
export function cursorToolCall(
  toolCall: unknown,
): { readonly kind: string; readonly body: Readonly<Record<string, unknown>> } | undefined {
  const call = asRecord(toolCall);
  if (call === undefined) return undefined;
  const oneof = asRecord(call['tool']);
  if (oneof !== undefined && typeof oneof['case'] === 'string') {
    return { kind: oneof['case'], body: asRecord(oneof['value']) ?? {} };
  }
  const key = Object.keys(call).find((name) => name.endsWith('ToolCall'));
  return key === undefined ? undefined : { kind: key, body: asRecord(call[key]) ?? {} };
}

/**
 * A tool name as Claude Code spells it. Cursor names an MCP tool by its server and its own
 * name — `providerIdentifier` `handoff` and `toolName` `handoff_runbooks`, or `handoff-handoff_runbooks`
 * in one string — and a built-in tool keeps the name of its kind.
 */
export function cursorToolName(kind: string, body: Readonly<Record<string, unknown>>): string {
  if (kind !== 'mcpToolCall') return kind;
  const args = asRecord(body['args']) ?? {};
  const provider = (asText(args['providerIdentifier']) || asText(args['serverIdentifier'])).split(
    '::mcpScope:',
  )[0];
  const tool = asText(args['toolName']);
  if (provider === CURSOR_MCP_SERVER_NAME && tool !== '') {
    return `mcp__${CURSOR_MCP_SERVER_NAME}__${tool}`;
  }
  const name = asText(args['name']);
  const prefix = `${CURSOR_MCP_SERVER_NAME}-`;
  if (name.startsWith(prefix))
    return `mcp__${CURSOR_MCP_SERVER_NAME}__${name.slice(prefix.length)}`;
  return name === '' ? kind : name;
}

/** Every string under a key named `text`, `error`, `reason` or `message`, in document order. */
function collectText(value: unknown, depth = 0): string[] {
  if (depth > 10) return [];
  if (Array.isArray(value)) return value.flatMap((entry: unknown) => collectText(entry, depth + 1));
  const record = asRecord(value);
  if (record === undefined) return [];
  const texts: string[] = [];
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry === 'string') {
      if (key === 'text' || key === 'error' || key === 'reason' || key === 'message') {
        texts.push(entry);
      }
    } else {
      texts.push(...collectText(entry, depth + 1));
    }
  }
  return texts;
}

/** The outcome of a completed call: whether it failed, and the text of what came back. */
export function cursorToolResult(
  body: Readonly<Record<string, unknown>>,
): { readonly isError: boolean; readonly text: string } | undefined {
  const result = asRecord(body['result']);
  if (result === undefined) return undefined;
  const oneof = asRecord(result['result']);
  const kind =
    oneof !== undefined && typeof oneof['case'] === 'string'
      ? oneof['case']
      : (Object.keys(result)[0] ?? '');
  const value =
    oneof !== undefined && typeof oneof['case'] === 'string' ? oneof['value'] : result[kind];
  return {
    isError: kind !== 'success' || asRecord(value)?.['isError'] === true,
    text: collectText(value).join('\n'),
  };
}

/**
 * The CLI's stream-json events as the shared transcript shape. A line that is not a JSON object
 * with a `type` is dropped here and shows up as a missing result instead, which the run's first
 * assertion reports.
 */
export function parseCursorEvents(lines: readonly CursorLine[]): ParsedCursorRun {
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
    const kept: Record<string, unknown> = { ...event };
    delete kept['env'];
    transcript.push({
      ...kept,
      type,
      ...(at === undefined ? {} : { received_at: new Date(at).toISOString() }),
    });
  }

  const toolUses: ToolUse[] = [];
  const toolResults: ToolResultBlock[] = [];
  let sessionId: string | undefined;
  for (const event of transcript) {
    const session = event['session_id'];
    if (sessionId === undefined && typeof session === 'string') sessionId = session;
    if (event.type !== 'tool_call') continue;
    const call = cursorToolCall(event['tool_call']);
    if (call === undefined) continue;
    const id = asText(event['call_id']);
    const name = cursorToolName(call.kind, call.body);
    if (!toolUses.some((use) => use.id === id)) {
      toolUses.push({ name, input: asRecord(call.body['args'])?.['args'], id });
    }
    if (event['subtype'] !== 'completed') continue;
    const outcome = cursorToolResult(call.body);
    toolResults.push({
      tool_use_id: id,
      isError: outcome?.isError ?? true,
      text: outcome?.text ?? '',
    });
  }

  return {
    transcript,
    toolUses,
    toolResults,
    result: transcript.find((event) => event.type === 'result'),
    sessionId,
  };
}

/** The folders of `~/.cursor` where every run leaves something: its project and its chats. */
export const CURSOR_STATE_FOLDERS = ['projects', 'chats'] as const;

/** The entries of `after` that `before` did not have: what one run added. */
export function newEntries(before: readonly string[], after: readonly string[]): string[] {
  const known = new Set(before);
  return after.filter((entry) => !known.has(entry));
}

function stateSnapshot(root: string): Map<string, readonly string[]> {
  return new Map(
    CURSOR_STATE_FOLDERS.map((folder) => [folder, listFolder(join(root, folder))] as const),
  );
}

/**
 * Removes what the run added under `~/.cursor/projects` and `~/.cursor/chats`, and nothing that
 * was there before it. Best effort: an entry that cannot be removed is a folder in a list, not a
 * failed canary.
 */
function removeRunState(root: string, before: Map<string, readonly string[]>): void {
  for (const folder of CURSOR_STATE_FOLDERS) {
    const added = newEntries(before.get(folder) ?? [], listFolder(join(root, folder)));
    for (const entry of added) {
      try {
        rmSync(join(root, folder, entry), { recursive: true, force: true });
      } catch {
        // See above.
      }
    }
  }
}

/** Spawns the CLI, collects stdout line by line with arrival times, and kills it past the budget. */
function spawnCursor(
  command: CursorCommand,
  args: readonly string[],
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
): Promise<{ lines: CursorLine[]; stderr: string; code: number | null; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command.command, [...command.prefix, ...args], {
      cwd,
      env,
      shell: command.shell,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const lines: CursorLine[] = [];
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
 * Runs one scenario against the real Cursor Agent CLI and returns everything it produced.
 *
 * The temporary root is removed when the run ends, unless `HANDOFF_CANARY_KEEP=1`, and with it
 * the transcript it holds (`transcript.jsonl`, the parsed events with any `env` dropped).
 */
export async function runCursor(options: CursorRunOptions): Promise<CanaryRun> {
  const root = mkdtempSync(join(tmpdir(), 'handoff-canary-cursor-'));
  const project = join(root, 'project');
  const home = join(root, 'home');
  for (const folder of [project, home]) mkdirSync(folder, { recursive: true });
  const hookOut = join(root, 'hooks.jsonl');

  const workspace: CursorWorkspaceOptions = {
    serverBundle: SERVER_BUNDLE,
    home,
    project,
    ...(options.recordHooks === true
      ? { hookRecorder: { script: CURSOR_HOOK_RECORDER, out: hookOut } }
      : {}),
  };
  for (const [relative, text] of Object.entries(cursorProjectFiles(workspace))) {
    const file = join(project, relative);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text, 'utf8');
  }

  const command = resolveCursorAgent();
  const args = cursorArgs({
    prompt: options.prompt,
    model: options.model ?? process.env['HANDOFF_CANARY_CURSOR_MODEL'] ?? CURSOR_DEFAULT_MODEL,
    project,
  });
  const env = cursorChildEnvironment({ home });
  const stateRoot = join(homedir(), '.cursor');
  const before = stateSnapshot(stateRoot);

  const app = options.app === undefined ? undefined : await options.app(home);
  const started = Date.now();
  let child: Awaited<ReturnType<typeof spawnCursor>>;
  try {
    child = await spawnCursor(
      command,
      args,
      project,
      env,
      options.timeoutMs ?? CURSOR_DEFAULT_TIMEOUT_MS,
    );
  } catch (cause) {
    await app?.stop();
    removeRunState(stateRoot, before);
    throw cause;
  }
  const durationMs = Date.now() - started;
  const appTranscript = app?.transcript();
  await app?.stop();
  removeRunState(stateRoot, before);

  const parsed = parseCursorEvents(child.lines);
  writeFileSync(
    join(root, 'transcript.jsonl'),
    parsed.transcript.map((event) => JSON.stringify(event)).join('\n'),
    'utf8',
  );

  const run: CanaryRun = {
    exitCode: child.code,
    durationMs,
    timedOut: child.timedOut,
    stderr: child.stderr,
    transcript: parsed.transcript,
    observations: readNdjson<Observation>(join(home, 'canary', 'observations.jsonl')),
    hookRecords: readNdjson<HookRecord>(hookOut),
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
      // A server the CLI has not reaped yet can hold a file for a moment; the folder is under
      // the temporary directory either way, and a failed cleanup is not a failed canary.
    }
  }
  return run;
}

/** The project folder a Cursor run worked in. */
export function cursorProjectOf(run: CanaryRun): string {
  return join(run.workspace, 'project');
}

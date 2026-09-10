/**
 * One `codex exec` run, start to finish (T-066, TECHNICAL-DESIGN §11.5) — the Codex twin of
 * `../../runner.ts`. It returns the same `CanaryRun`, so the classifier, the driver and the
 * report never ask which agent produced it.
 *
 * Codex prints JSONL events rather than `stream-json` messages. `parseCodexEvents` maps them
 * onto the shared shape: every `mcp_tool_call` item is one tool use and one tool result, and
 * a `result` message is made from the last agent message once a turn has ended. Each event
 * also carries `received_at`, the instant its line arrived: Codex stamps nothing, and a
 * timeout the agent applies without telling the server can only be timed from outside.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  SERVER_BUNDLE,
  readNdjson,
  type AppTranscript,
  type CanaryRun,
  type Observation,
  type ToolResultBlock,
  type ToolUse,
  type TranscriptMessage,
} from '../../runner.ts';
import {
  CODEX_DEFAULT_MODEL,
  codexArgs,
  codexChildEnvironment,
  type CodexWorkspaceOptions,
} from './workspace.ts';

/** How long a whole Codex run may take before it is killed and reported as a protocol failure. */
export const CODEX_DEFAULT_TIMEOUT_MS = 300_000;

/** An overlay a scenario starts for the length of one run: `fake-app`, scripted (`app.ts`). */
export interface CanaryApp {
  transcript(): AppTranscript;
  stop(): Promise<void>;
}

/** What a Codex scenario asks the harness for. */
export interface CodexRunOptions {
  readonly prompt: string;
  readonly model?: string;
  readonly timeoutMs?: number;
  /** The per-server `tool_timeout_sec` of our entry, in seconds (A-04). */
  readonly toolTimeoutSec?: number;
  /** Starts an overlay on the run's `HANDOFF_HOME` before the agent, and stops it after. */
  readonly app?: (home: string) => Promise<CanaryApp>;
}

/** How to start `codex`: the program, what goes before our arguments, and whether a shell is needed. */
export interface CodexCommand {
  readonly command: string;
  readonly prefix: readonly string[];
  readonly shell: boolean;
}

/** Where npm puts the launcher of `@openai/codex`, relative to the folder of its shims. */
export const NPM_CODEX_LAUNCHER: readonly string[] = [
  'node_modules',
  '@openai',
  'codex',
  'bin',
  'codex.js',
];

/**
 * Picks the way to start `codex` from what `where`/`which` found.
 *
 * The native installer puts a real `codex.exe` on `PATH`, which is started directly. An npm
 * install — the one `canary.yml` performs — leaves shims instead, and a `.cmd` can only run
 * through `cmd.exe`, whose quoting would mangle the JSON one of the prompts carries. So a
 * shim is bypassed for the launcher it calls, run with this Node, and a shell is used only
 * when that launcher cannot be found. On Windows an extensionless match is the shell-script
 * shim and is skipped.
 */
export function codexCommandFrom(
  found: readonly string[],
  platform: {
    readonly windows: boolean;
    readonly execPath: string;
    readonly exists: (path: string) => boolean;
  },
): CodexCommand {
  const usable = found.filter((path) => !platform.windows || /\.(?:exe|cmd|bat|js)$/iu.test(path));
  const first = usable[0];
  if (first === undefined) return { command: 'codex', prefix: [], shell: false };
  const lower = first.toLowerCase();
  if (lower.endsWith('.js')) return { command: platform.execPath, prefix: [first], shell: false };
  if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
    const launcher = join(dirname(first), ...NPM_CODEX_LAUNCHER);
    return platform.exists(launcher)
      ? { command: platform.execPath, prefix: [launcher], shell: false }
      : { command: first, prefix: [], shell: true };
  }
  return { command: first, prefix: [], shell: false };
}

/** `HANDOFF_CANARY_CODEX` when it names a program, else the first `codex` on `PATH`. */
export function resolveCodex(
  env: Readonly<Record<string, string | undefined>> = process.env,
): CodexCommand {
  const platform = {
    windows: process.platform === 'win32',
    execPath: process.execPath,
    exists: existsSync,
  };
  const override = env['HANDOFF_CANARY_CODEX']?.trim();
  if (override !== undefined && override !== '') return codexCommandFrom([override], platform);
  let found: string[] = [];
  try {
    found = execFileSync(platform.windows ? 'where' : 'which', ['codex'], {
      encoding: 'utf8',
      windowsHide: true,
    })
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line !== '');
  } catch {
    // Not on PATH: the spawn reports it, and the driver stops with exit 2.
  }
  return codexCommandFrom(found, platform);
}

/** One line of Codex's stdout, and the instant it arrived when that was recorded. */
export interface CodexLine {
  readonly line: string;
  readonly at?: number;
}

/** What `parseCodexEvents` makes of a run's stdout. */
export interface ParsedCodexRun {
  readonly transcript: readonly TranscriptMessage[];
  readonly toolUses: readonly ToolUse[];
  readonly toolResults: readonly ToolResultBlock[];
  readonly result: TranscriptMessage | undefined;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** The text blocks of an MCP result's `content`, joined. An image block contributes nothing. */
function contentText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((block: unknown) => asText(asRecord(block)?.['text']))
    .filter((text) => text !== '')
    .join('\n');
}

/**
 * Codex's JSONL events as the shared transcript shape. A line that is not a JSON object with
 * a `type` is dropped here and shows up as a missing result instead, which the run's first
 * assertion reports.
 */
export function parseCodexEvents(lines: readonly CodexLine[]): ParsedCodexRun {
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
  let reply = '';
  let turns = 0;
  let failed = false;
  let usage: unknown = null;
  for (const event of transcript) {
    if (event.type === 'turn.completed') {
      turns += 1;
      usage = event['usage'] ?? null;
      continue;
    }
    if (event.type === 'turn.failed' || event.type === 'error') {
      failed = true;
      continue;
    }
    if (event.type !== 'item.completed') continue;
    const item = asRecord(event['item']);
    if (item === undefined) continue;
    if (item['type'] === 'agent_message') {
      const message = asText(item['text']);
      if (message.trim() !== '') reply = message;
      continue;
    }
    if (item['type'] !== 'mcp_tool_call') continue;
    const id = asText(item['id']);
    const error = asRecord(item['error']);
    const result = asRecord(item['result']);
    toolUses.push({
      name: `mcp__${asText(item['server'])}__${asText(item['tool'])}`,
      input: item['arguments'],
      id,
    });
    toolResults.push({
      tool_use_id: id,
      isError:
        item['status'] !== 'completed' || error !== undefined || result?.['is_error'] === true,
      text: error === undefined ? contentText(result?.['content']) : asText(error['message']),
    });
  }

  const result: TranscriptMessage | undefined =
    turns === 0 && !failed
      ? undefined
      : {
          type: 'result',
          subtype: failed ? 'error' : 'success',
          is_error: failed,
          result: reply,
          num_turns: turns,
          usage,
        };
  return { transcript, toolUses, toolResults, result };
}

/** Spawns `codex`, collects stdout line by line with arrival times, and kills it past the budget. */
function spawnCodex(
  args: readonly string[],
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
): Promise<{ lines: CodexLine[]; stderr: string; code: number | null; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const codex = resolveCodex();
    const child = spawn(codex.command, [...codex.prefix, ...args], {
      cwd,
      env,
      shell: codex.shell,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const lines: CodexLine[] = [];
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
 * Runs one scenario against the real Codex and returns everything it produced.
 *
 * The temporary root is removed when the run ends, unless `HANDOFF_CANARY_KEEP=1`. There is
 * no hook record: `codex exec` runs no hook at all (docs/agent-facts.md), so the canary
 * declares none.
 */
export async function runCodex(options: CodexRunOptions): Promise<CanaryRun> {
  const root = mkdtempSync(join(tmpdir(), 'handoff-canary-codex-'));
  const project = join(root, 'project');
  const home = join(root, 'home');
  mkdirSync(project, { recursive: true });
  mkdirSync(home, { recursive: true });

  const workspace: CodexWorkspaceOptions = {
    serverBundle: SERVER_BUNDLE,
    home,
    project,
    ...(options.toolTimeoutSec === undefined ? {} : { toolTimeoutSec: options.toolTimeoutSec }),
  };
  const args = codexArgs({
    prompt: options.prompt,
    model: options.model ?? process.env['HANDOFF_CANARY_CODEX_MODEL'] ?? CODEX_DEFAULT_MODEL,
    workspace,
  });

  const app = options.app === undefined ? undefined : await options.app(home);
  const started = Date.now();
  let child: Awaited<ReturnType<typeof spawnCodex>>;
  try {
    child = await spawnCodex(
      args,
      project,
      codexChildEnvironment(workspace),
      options.timeoutMs ?? CODEX_DEFAULT_TIMEOUT_MS,
    );
  } catch (cause) {
    await app?.stop();
    throw cause;
  }
  const durationMs = Date.now() - started;
  const appTranscript = app?.transcript();
  await app?.stop();

  const parsed = parseCodexEvents(child.lines);
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
      // A server Codex has not reaped yet can hold a file for a moment; the folder is under
      // the temporary directory either way, and a failed cleanup is not a failed canary.
    }
  }
  return run;
}

/** The project folder a Codex run was started in (`-C`). */
export function codexProjectOf(run: CanaryRun): string {
  return join(run.workspace, 'project');
}

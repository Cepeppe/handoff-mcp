/**
 * The canary harness: one `claude -p` run, start to finish (T-023, TECHNICAL-DESIGN
 * §11.5).
 *
 * It builds a throw-away project, launches the real Claude Code against the real server
 * bundle, and gives a scenario three things to assert on:
 *
 * - the **transcript**, the `stream-json` messages the agent printed (what the model did);
 * - the **observations**, the NDJSON the canary probe inside the server wrote (what the
 *   protocol actually did — this half does not depend on the model having behaved);
 * - the **hook records**, what the recording Stop hook was handed (A-05, A-06, A-11).
 *
 * Nothing here asserts. A scenario reads a `CanaryRun` and produces assertions, which the
 * driver classifies; keeping the two apart is what makes "protocol failure versus model
 * failure" a property of the check rather than of the transport.
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  childEnvironment,
  claudeArgs,
  mcpConfig,
  projectSettings,
  type WorkspaceOptions,
} from './workspace.ts';

/** The repository root, from this file. */
export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** The bundle the MCP entry runs. `pnpm build` produces it; the driver checks it exists. */
export const SERVER_BUNDLE = join(REPO_ROOT, 'dist', 'handoff-mcp.cjs');

/** The recording Stop hook of A-05, A-06 and A-11. */
export const STOP_HOOK = join(REPO_ROOT, 'test', 'canary', 'hooks', 'record-stop.mjs');

/**
 * The model every canary runs on unless `HANDOFF_CANARY_MODEL` says otherwise.
 *
 * Pinning it is what makes two runs comparable, and it is also the cost control the task's
 * Notes ask for: the default of `claude -p` on this machine is the largest model with the
 * largest context, and a canary neither needs nor benefits from it.
 */
export const DEFAULT_MODEL = 'sonnet';

/** How long a whole run may take before it is killed and reported as a protocol failure. */
export const DEFAULT_TIMEOUT_MS = 300_000;

/** Reads one field of a content block as a string, whatever the block actually holds. */
function field(block: Record<string, unknown>, name: string): string {
  const value = block[name];
  return typeof value === 'string' ? value : '';
}

/** One `stream-json` message. Only the fields the scenarios read are named. */
export interface TranscriptMessage {
  readonly type: string;
  readonly subtype?: string;
  readonly message?: {
    readonly role?: string;
    readonly content?: readonly Record<string, unknown>[];
  };
  readonly mcp_servers?: readonly { readonly name: string; readonly status: string }[];
  readonly tools?: readonly string[];
  readonly model?: string;
  readonly num_turns?: number;
  readonly total_cost_usd?: number;
  readonly is_error?: boolean;
  readonly result?: string;
  readonly [field: string]: unknown;
}

/** One observation the probe inside the server wrote. */
export interface Observation {
  readonly at: string;
  readonly event: string;
  readonly [field: string]: unknown;
}

/** One invocation of the recording Stop hook. */
export interface HookRecord {
  readonly at: string;
  readonly pid: number;
  readonly ppid: number;
  readonly ancestors: readonly number[];
  readonly blocked: boolean;
  readonly input: Record<string, unknown>;
}

/** A `tools/call` as the transcript shows it. */
export interface ToolUse {
  readonly name: string;
  readonly input: unknown;
  readonly id: string;
}

/** A tool result as the transcript shows it. */
export interface ToolResultBlock {
  readonly tool_use_id: string;
  readonly isError: boolean;
  readonly text: string;
}

/** Everything one run produced. */
export interface CanaryRun {
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly stderr: string;
  readonly transcript: readonly TranscriptMessage[];
  readonly observations: readonly Observation[];
  readonly hookRecords: readonly HookRecord[];
  readonly toolUses: readonly ToolUse[];
  readonly toolResults: readonly ToolResultBlock[];
  /** The `result` message of `stream-json`, absent when the run did not get that far. */
  readonly result: TranscriptMessage | undefined;
  /** The temporary root, kept when `HANDOFF_CANARY_KEEP=1`. */
  readonly workspace: string;
}

/** What a scenario asks the harness for. */
export interface RunOptions {
  readonly prompt: string;
  readonly maxTurns: number;
  readonly stopHook?: boolean;
  readonly mcpToolTimeoutMs?: number;
  readonly perServerTimeoutMs?: number;
  readonly agentId?: string;
  readonly timeoutMs?: number;
  readonly model?: string;
  /** Files to drop into the run's runbook folder, as `name → JSON text`. */
  readonly runbooks?: Readonly<Record<string, string>>;
}

/** Reads an NDJSON file that may not exist yet: an absent file is no records. */
function readNdjson<T>(file: string): T[] {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const records: T[] = [];
  for (const line of text.split(/\r?\n/u)) {
    if (line.trim() === '') continue;
    try {
      records.push(JSON.parse(line) as T);
    } catch {
      // A half-written last line is a fact about a killed process, not a parse error to
      // propagate: the scenario sees one record fewer and says so.
    }
  }
  return records;
}

/** The `tool_use` blocks of every assistant message, in order. */
function toolUses(transcript: readonly TranscriptMessage[]): ToolUse[] {
  const uses: ToolUse[] = [];
  for (const message of transcript) {
    if (message.type !== 'assistant') continue;
    for (const block of message.message?.content ?? []) {
      if (block['type'] !== 'tool_use') continue;
      uses.push({ name: field(block, 'name'), input: block['input'], id: field(block, 'id') });
    }
  }
  return uses;
}

/** The text of a tool result, whatever shape the block took. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block: unknown) =>
      typeof block === 'object' && block !== null && 'text' in block ? String(block.text) : '',
    )
    .join('\n');
}

/** The `tool_result` blocks of every user message, in order. */
function toolResults(transcript: readonly TranscriptMessage[]): ToolResultBlock[] {
  const results: ToolResultBlock[] = [];
  for (const message of transcript) {
    if (message.type !== 'user') continue;
    for (const block of message.message?.content ?? []) {
      if (block['type'] !== 'tool_result') continue;
      results.push({
        tool_use_id: field(block, 'tool_use_id'),
        isError: block['is_error'] === true,
        text: resultText(block['content']),
      });
    }
  }
  return results;
}

/**
 * Where `claude` is, and whether it has to go through a shell to be started.
 *
 * The native installer puts a real `claude.exe` on `PATH`, which `spawn` starts directly;
 * an npm install leaves a `claude.cmd` shim, which on Windows only a shell can run. Asking
 * first costs one `where` and avoids passing our arguments through `cmd.exe` — and its
 * quoting rules — in the common case. One of the prompts is a JSON document full of double
 * quotes, so that is not a theoretical concern.
 */
export function resolveClaude(): { command: string; shell: boolean } {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  try {
    const found = execFileSync(finder, ['claude'], { encoding: 'utf8', windowsHide: true })
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line !== '');
    const first = found[0];
    if (first !== undefined) {
      const lower = first.toLowerCase();
      return { command: first, shell: lower.endsWith('.cmd') || lower.endsWith('.bat') };
    }
  } catch {
    // Not on PATH, or no `where`/`which`: fall back and let the spawn report it.
  }
  return { command: 'claude', shell: process.platform === 'win32' };
}

/** Spawns `claude`, collects stdout and stderr, and kills it past the budget. */
function spawnClaude(
  args: readonly string[],
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const claude = resolveClaude();
    const child = spawn(claude.command, [...args], {
      cwd,
      env,
      shell: claude.shell,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (stdout += chunk));
    child.stderr.on('data', (chunk: string) => (stderr += chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut });
    });
  });
}

/**
 * Runs one scenario against the real Claude Code and returns everything it produced.
 *
 * The temporary root is removed when the run ends, unless `HANDOFF_CANARY_KEEP=1`, which
 * is what to set when a canary fails and the transcript has to be read by hand.
 */
export async function runClaude(options: RunOptions): Promise<CanaryRun> {
  const root = mkdtempSync(join(tmpdir(), 'handoff-canary-'));
  const project = join(root, 'project');
  const home = join(root, 'home');
  mkdirSync(join(project, '.claude'), { recursive: true });
  mkdirSync(home, { recursive: true });

  if (options.runbooks !== undefined) {
    const folder = join(home, 'runbooks');
    mkdirSync(folder, { recursive: true });
    for (const [name, text] of Object.entries(options.runbooks)) {
      writeFileSync(join(folder, name), text, 'utf8');
    }
  }

  const workspace: WorkspaceOptions = {
    serverBundle: SERVER_BUNDLE,
    home,
    ...(options.stopHook === true ? { stopHook: STOP_HOOK } : {}),
    ...(options.mcpToolTimeoutMs === undefined
      ? {}
      : { mcpToolTimeoutMs: options.mcpToolTimeoutMs }),
    ...(options.perServerTimeoutMs === undefined
      ? {}
      : { perServerTimeoutMs: options.perServerTimeoutMs }),
    ...(options.agentId === undefined ? {} : { agentId: options.agentId }),
  };

  const configFile = join(root, 'mcp.json');
  writeFileSync(configFile, `${JSON.stringify(mcpConfig(workspace), null, 2)}\n`, 'utf8');
  writeFileSync(
    join(project, '.claude', 'settings.json'),
    `${JSON.stringify(projectSettings(workspace), null, 2)}\n`,
    'utf8',
  );

  const args = claudeArgs({
    prompt: options.prompt,
    mcpConfig: configFile,
    maxTurns: options.maxTurns,
    model: options.model ?? process.env['HANDOFF_CANARY_MODEL'] ?? DEFAULT_MODEL,
  });

  const started = Date.now();
  const child = await spawnClaude(
    args,
    project,
    childEnvironment(workspace),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  const durationMs = Date.now() - started;

  const transcript: TranscriptMessage[] = [];
  for (const line of child.stdout.split(/\r?\n/u)) {
    if (line.trim() === '') continue;
    try {
      transcript.push(JSON.parse(line) as TranscriptMessage);
    } catch {
      // `claude` prints nothing but NDJSON on stdout in this mode; a line that is not JSON
      // is a fact the scenario's "the run is well formed" assertion reports.
    }
  }

  const observations = readNdjson<Observation>(join(home, 'canary', 'observations.jsonl'));
  const hookRecords = readNdjson<HookRecord>(join(home, 'canary', 'hook.jsonl'));

  const run: CanaryRun = {
    exitCode: child.code,
    durationMs,
    timedOut: child.timedOut,
    stderr: child.stderr,
    transcript,
    observations,
    hookRecords,
    toolUses: toolUses(transcript),
    toolResults: toolResults(transcript),
    result: transcript.find((message) => message.type === 'result'),
    workspace: root,
  };

  if (process.env['HANDOFF_CANARY_KEEP'] !== '1') {
    rmSync(root, { recursive: true, force: true });
  }
  return run;
}

/** The observations of one event, in the order the server wrote them. */
export function observationsOf(run: CanaryRun, event: string): Observation[] {
  return run.observations.filter((observation) => observation.event === event);
}

/** The first observation of one event, or `undefined`. */
export function firstObservation(run: CanaryRun, event: string): Observation | undefined {
  return run.observations.find((observation) => observation.event === event);
}

/** The `system`/`init` message, which lists the MCP servers and their status. */
export function initMessage(run: CanaryRun): TranscriptMessage | undefined {
  return run.transcript.find((message) => message.type === 'system' && message.subtype === 'init');
}

/** Makes sure the directory of a file exists before something writes into it. */
export function ensureDirectory(file: string): void {
  mkdirSync(dirname(file), { recursive: true });
}

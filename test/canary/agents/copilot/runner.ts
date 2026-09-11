/**
 * One GitHub Copilot CLI run, start to finish (T-072, TECHNICAL-DESIGN §11.5) — the Copilot
 * twin of `../cursor/runner.ts`. It returns the same `CanaryRun`, so the classifier, the driver
 * and the report never ask which agent produced it.
 *
 * `copilot -p --output-format json` prints one session event per line, each `{ type, data }`
 * (`schemas/session-events.schema.json` in the CLI's own package): `session.mcp_servers_loaded`
 * with every server's status, `assistant.message` with the model's text, `tool.execution_start`
 * and `tool.execution_complete` around each call — `mcpServerName` and `mcpToolName` say when
 * it is a tool of an MCP server — and many more that the harness keeps and does not read. The
 * last event is `result`, with the exit code and the usage of the run and no text: the run's
 * reply is its last assistant message, and what the run cost — `--usage-output-file`, else that
 * event's `usage` — is attached to it as `usage`.
 *
 * Under `-p` the CLI does not wait for its MCP servers before the first model call (T-071: a
 * cold 94 MB server connected 0.23 s after the tool list froze). The canary's server is the
 * 0.8 MB bundle under the Node the harness runs on, and it is started once with `--version`
 * before every run, so that the files it reads are warm when the CLI starts it.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
  COPILOT_DEFAULT_MODEL,
  COPILOT_MCP_SERVER_NAME,
  copilotArgs,
  copilotChildEnvironment,
  copilotHomeFiles,
  copilotProjectFiles,
  copilotUserHomeFiles,
  type CopilotWorkspaceOptions,
} from './workspace.ts';

/** How long a whole Copilot run may take before it is killed and reported as a protocol failure. */
export const COPILOT_DEFAULT_TIMEOUT_MS = 300_000;

/** The recording hook, beside this file. */
export const COPILOT_HOOK_RECORDER = fileURLToPath(new URL('./record-hook.mjs', import.meta.url));

/** What a Copilot CLI scenario asks the harness for. */
export interface CopilotRunOptions {
  readonly prompt: string;
  readonly model?: string;
  readonly timeoutMs?: number;
  /** The per-server `timeout` of our entry, in milliseconds (A-04). */
  readonly perServerTimeoutMs?: number;
  /** Declares the recording hooks in the run's Copilot folder and project. */
  readonly recordHooks?: boolean;
  /** Starts an overlay on the run's `HANDOFF_HOME` before the agent, and stops it after. */
  readonly app?: (home: string) => Promise<CanaryApp>;
}

/** How to start `copilot`: the program, and whether a shell is needed. */
export interface CopilotCommand {
  readonly command: string;
  readonly shell: boolean;
}

/**
 * Picks the way to start the Copilot CLI from what `where`/`which` found.
 *
 * On Windows an npm install puts `copilot.cmd` on `PATH`, which reaches the CLI through
 * `cmd.exe` and `npm-loader.js`, whose job is to start the native binary of the platform
 * package — `@github/copilot-<platform>-<arch>/copilot.exe`, signed by GitHub. A prompt carries
 * JSON, and `cmd.exe` would have its say about the quotes in it, so the shim is bypassed for
 * that binary, looked for where npm nests or hoists it; a shell is used only when neither is
 * there. Anywhere else the launcher is started directly.
 */
export function copilotCommandFrom(
  found: readonly string[],
  platform: {
    readonly windows: boolean;
    readonly name: string;
    readonly arch: string;
    readonly exists: (path: string) => boolean;
  },
): CopilotCommand {
  const usable = found.filter((path) => !platform.windows || /\.(?:exe|cmd|bat)$/iu.test(path));
  const first = usable[0];
  if (first === undefined) return { command: 'copilot', shell: platform.windows };
  if (!/\.(?:cmd|bat)$/iu.test(first)) return { command: first, shell: false };

  const binaryPackage = `copilot-${platform.name}-${platform.arch}`;
  const modules = join(dirname(first), 'node_modules', '@github');
  for (const candidate of [
    join(modules, 'copilot', 'node_modules', '@github', binaryPackage, 'copilot.exe'),
    join(modules, binaryPackage, 'copilot.exe'),
  ]) {
    if (platform.exists(candidate)) return { command: candidate, shell: false };
  }
  return { command: first, shell: true };
}

/** `HANDOFF_CANARY_COPILOT` when it names a program, else `copilot` on `PATH`. */
export function resolveCopilot(
  env: Readonly<Record<string, string | undefined>> = process.env,
): CopilotCommand {
  const platform = {
    windows: process.platform === 'win32',
    name: process.platform,
    arch: process.arch,
    exists: existsSync,
  };
  const override = env['HANDOFF_CANARY_COPILOT']?.trim();
  if (override !== undefined && override !== '') return copilotCommandFrom([override], platform);
  try {
    const found = execFileSync(platform.windows ? 'where' : 'which', ['copilot'], {
      encoding: 'utf8',
      windowsHide: true,
    })
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line !== '');
    return copilotCommandFrom(found, platform);
  } catch {
    return copilotCommandFrom([], platform);
  }
}

/** The version `copilot --version` prints (`GitHub Copilot CLI 1.0.83.`), or `null`. */
export function copilotVersionOf(text: string): string | null {
  return /(\d+\.\d+\.\d+)/u.exec(text)?.[1] ?? null;
}

/** One line of the CLI's stdout, and the instant it arrived when that was recorded. */
export interface CopilotLine {
  readonly line: string;
  readonly at?: number;
}

/** One server of a `session.mcp_servers_loaded` event, by name and status. */
export interface LoadedServer {
  readonly name: string;
  readonly status: string;
}

/** What `parseCopilotEvents` makes of a run's stdout. */
export interface ParsedCopilotRun {
  readonly transcript: readonly TranscriptMessage[];
  readonly toolUses: readonly ToolUse[];
  readonly toolResults: readonly ToolResultBlock[];
  /** The text of the last assistant message that had any. */
  readonly reply: string | undefined;
  /** The servers of the last `session.mcp_servers_loaded` event. */
  readonly servers: readonly LoadedServer[];
  /** The closing `result` event's exit code and usage, when the run got that far. */
  readonly final: { readonly exitCode: unknown; readonly usage: unknown } | undefined;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** The `data` of a session event, or an empty record. */
export function eventData(event: TranscriptMessage | undefined): Readonly<Record<string, unknown>> {
  return asRecord(event?.['data']) ?? {};
}

/**
 * A tool name as Claude Code spells it: `mcp__handoff__<tool>` for a tool of our server, which
 * the CLI itself calls `handoff-<tool>`, and the CLI's own name for anything else.
 */
export function copilotToolName(data: Readonly<Record<string, unknown>>): string {
  const server = asText(data['mcpServerName']);
  const tool = asText(data['mcpToolName']);
  if (server === COPILOT_MCP_SERVER_NAME && tool !== '') {
    return `mcp__${COPILOT_MCP_SERVER_NAME}__${tool}`;
  }
  const name = asText(data['toolName']);
  const prefix = `${COPILOT_MCP_SERVER_NAME}-`;
  if (name.startsWith(prefix))
    return `mcp__${COPILOT_MCP_SERVER_NAME}__${name.slice(prefix.length)}`;
  return name;
}

/** The outcome of a completed call: whether it failed, and the text of what came back. */
export function copilotToolResult(data: Readonly<Record<string, unknown>>): {
  readonly isError: boolean;
  readonly text: string;
} {
  const result = asRecord(data['result']);
  const error = asRecord(data['error']);
  const text = asText(result?.['content']) || asText(error?.['message']);
  return { isError: data['success'] !== true, text };
}

/**
 * The CLI's session events as the shared transcript shape. A line that is not a JSON object
 * with a `type` is dropped here and shows up as a missing result instead, which the run's
 * first assertion reports.
 */
export function parseCopilotEvents(lines: readonly CopilotLine[]): ParsedCopilotRun {
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
  let reply: string | undefined;
  let servers: LoadedServer[] = [];
  let final: ParsedCopilotRun['final'];
  for (const event of transcript) {
    const data = eventData(event);
    if (event.type === 'result') {
      final = { exitCode: event['exitCode'], usage: event['usage'] };
    } else if (event.type === 'tool.execution_start') {
      const id = asText(data['toolCallId']);
      if (!toolUses.some((use) => use.id === id)) {
        toolUses.push({ name: copilotToolName(data), input: data['arguments'], id });
      }
    } else if (event.type === 'tool.execution_complete') {
      toolResults.push({ tool_use_id: asText(data['toolCallId']), ...copilotToolResult(data) });
    } else if (event.type === 'assistant.message') {
      const content = asText(data['content']).trim();
      if (content !== '') reply = content;
    } else if (event.type === 'session.mcp_servers_loaded') {
      const listed = Array.isArray(data['servers']) ? (data['servers'] as unknown[]) : [];
      servers = listed.flatMap((entry) => {
        const record = asRecord(entry);
        return record === undefined
          ? []
          : [{ name: asText(record['name']), status: asText(record['status']) }];
      });
    }
  }

  return { transcript, toolUses, toolResults, reply, servers, final };
}

/** Spawns the CLI, collects stdout line by line with arrival times, and kills it past the budget. */
function spawnCopilot(
  command: CopilotCommand,
  args: readonly string[],
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
): Promise<{ lines: CopilotLine[]; stderr: string; code: number | null; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command.command, [...args], {
      cwd,
      env,
      shell: command.shell,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const lines: CopilotLine[] = [];
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

/** Starts the bundle once so the files it reads are warm when the CLI starts it (T-071). */
function warmServer(): void {
  try {
    execFileSync(process.execPath, [SERVER_BUNDLE, '--version'], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 30_000,
    });
  } catch {
    // A server that cannot even print its version is reported by the run that follows.
  }
}

function readUsage(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

/**
 * Runs one scenario against the real GitHub Copilot CLI and returns everything it produced.
 *
 * The temporary root is removed when the run ends, unless `HANDOFF_CANARY_KEEP=1`, and with it
 * the Copilot folder of the run — its sessions, its logs — and the transcript it holds
 * (`transcript.jsonl`, the parsed events).
 */
export async function runCopilot(options: CopilotRunOptions): Promise<CanaryRun> {
  const root = mkdtempSync(join(tmpdir(), 'handoff-canary-copilot-'));
  const project = join(root, 'project');
  const home = join(root, 'home');
  const copilotHome = join(root, 'copilot-home');
  const userHome = join(root, 'user-home');
  for (const folder of [project, home, copilotHome, userHome]) {
    mkdirSync(folder, { recursive: true });
  }
  const hookOut = join(root, 'hooks.jsonl');
  const usageFile = join(root, 'usage.json');

  const workspace: CopilotWorkspaceOptions = {
    serverBundle: SERVER_BUNDLE,
    home,
    project,
    ...(options.perServerTimeoutMs === undefined ? {} : { timeoutMs: options.perServerTimeoutMs }),
    ...(options.recordHooks === true
      ? { hookRecorder: { script: COPILOT_HOOK_RECORDER, out: hookOut } }
      : {}),
  };
  for (const [folder, files] of [
    [copilotHome, copilotHomeFiles(workspace)],
    [project, copilotProjectFiles(workspace)],
    [userHome, copilotUserHomeFiles(workspace)],
  ] as const) {
    for (const [relative, text] of Object.entries(files)) {
      const file = join(folder, relative);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, text, 'utf8');
    }
  }

  const command = resolveCopilot();
  const args = copilotArgs({
    prompt: options.prompt,
    model: options.model ?? process.env['HANDOFF_CANARY_COPILOT_MODEL'] ?? COPILOT_DEFAULT_MODEL,
    usageFile,
  });
  const env = copilotChildEnvironment({ home, copilotHome, userHome });

  warmServer();
  const app = options.app === undefined ? undefined : await options.app(home);
  const started = Date.now();
  let child: Awaited<ReturnType<typeof spawnCopilot>>;
  try {
    child = await spawnCopilot(
      command,
      args,
      project,
      env,
      options.timeoutMs ?? COPILOT_DEFAULT_TIMEOUT_MS,
    );
  } catch (cause) {
    await app?.stop();
    throw cause;
  }
  const durationMs = Date.now() - started;
  const appTranscript = app?.transcript();
  await app?.stop();

  const parsed = parseCopilotEvents(child.lines);
  writeFileSync(
    join(root, 'transcript.jsonl'),
    parsed.transcript.map((event) => JSON.stringify(event)).join('\n'),
    'utf8',
  );
  const usage = readUsage(usageFile) ?? parsed.final?.usage ?? null;

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
    result:
      parsed.reply === undefined
        ? undefined
        : { type: 'result', subtype: 'success', result: parsed.reply, usage },
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

/** The project folder a Copilot run worked in. */
export function copilotProjectOf(run: CanaryRun): string {
  return join(run.workspace, 'project');
}

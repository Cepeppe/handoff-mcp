/**
 * One launch of Cursor's editor, start to finish (T-069; TECHNICAL-DESIGN §5.6, §5.8, §14 R-12).
 *
 * The editor's agent cannot be driven from a script, but the part of the editor this server
 * meets first can: the editor starts every server of `~/.cursor/mcp.json` as a window opens,
 * before any chat, and that start is where the session identity is decided. So this launches a
 * Cursor of its own — a fresh `--user-data-dir` and extensions folder, and `USERPROFILE` (with
 * `HOME`) pointed at the run's folder, so that `~/.cursor/mcp.json` is the run's — on the run's
 * project, waits for our server to register with a scripted overlay, and closes that Cursor
 * again. It spends no agent request, and it never touches the user's own Cursor: a separate
 * user-data folder is a separate instance. It does open a window for the seconds it takes.
 *
 * Measured against Cursor 3.20.10 on Windows (`docs/agent-facts.md`): the server starts about
 * ten seconds after the launch, under the extension host, with the user's home folder as its
 * working directory and the workspace in `WORKSPACE_FOLDER_PATHS`.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SERVER_BUNDLE,
  readNdjson,
  type AppTranscript,
  type CanaryRun,
  type Observation,
} from '../../runner.ts';
import type { CanaryApp } from '../codex/runner.ts';
import { cursorMcpConfig } from './workspace.ts';

/** How long the editor has to start our server and let it register. */
export const CURSOR_EDITOR_REGISTRATION_TIMEOUT_MS = 90_000;

/** What an editor scenario asks the harness for. */
export interface CursorEditorRunOptions {
  /** Starts the overlay the server registers with, on the run's `HANDOFF_HOME`. */
  readonly app: (home: string) => Promise<CanaryApp>;
  readonly timeoutMs?: number;
}

/** Where Cursor's editor is installed, per platform; `HANDOFF_CANARY_CURSOR_EDITOR` overrides it. */
export function cursorEditorPath(
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const override = env['HANDOFF_CANARY_CURSOR_EDITOR']?.trim();
  if (override !== undefined && override !== '') return override;
  if (platform === 'win32') {
    return join(env['LOCALAPPDATA'] ?? '', 'Programs', 'cursor', 'Cursor.exe');
  }
  if (platform === 'darwin') return '/Applications/Cursor.app/Contents/MacOS/Cursor';
  return 'cursor';
}

/** The editor's command line: a user-data and an extensions folder of its own, the project last. */
export function cursorEditorArgs(options: {
  readonly userData: string;
  readonly extensions: string;
  readonly project: string;
}): string[] {
  return [
    '--user-data-dir',
    options.userData,
    '--extensions-dir',
    options.extensions,
    '--new-window',
    options.project,
  ];
}

/**
 * The editor's environment: the parent's, without `CLAUDECODE`, and with the home folder moved
 * to the run's, which is where the editor looks for `~/.cursor/mcp.json`.
 */
export function cursorEditorEnvironment(
  options: { readonly home: string },
  parent: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const child: Record<string, string> = {};
  for (const [name, value] of Object.entries(parent)) {
    if (value === undefined) continue;
    if (name === 'CLAUDECODE') continue;
    child[name] = value;
  }
  child['USERPROFILE'] = options.home;
  child['HOME'] = options.home;
  return child;
}

/** Whether a scripted overlay has received the `hello` of a server. */
export function serverHelloReceived(transcript: AppTranscript | undefined): boolean {
  return (transcript?.received ?? []).some((message) => {
    const record = message as { method?: unknown; params?: { role?: unknown } } | null;
    return record?.method === 'hello' && record.params?.role === 'server';
  });
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Ends the editor it launched and everything the editor started, our server among them. */
function closeEditor(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } else {
      process.kill(-pid, 'SIGTERM');
    }
  } catch {
    // Already gone: nothing left to close.
  }
}

/**
 * Launches Cursor's editor on a throw-away project and returns what the registration showed.
 *
 * The run is well formed when a server registered: `exitCode` 0 and a `result` then, and a
 * timed-out run with the reason in `stderr` otherwise. `launched` is the editor's own process,
 * the one its servers have to name in their chain.
 */
export async function runCursorEditor(options: CursorEditorRunOptions): Promise<CanaryRun> {
  const root = mkdtempSync(join(tmpdir(), 'handoff-canary-cursor-editor-'));
  const project = join(root, 'project');
  const home = join(root, 'home');
  const handoffHome = join(root, 'handoff-home');
  const userData = join(root, 'user-data');
  const extensions = join(root, 'extensions');
  for (const folder of [project, home, handoffHome, userData, extensions]) {
    mkdirSync(folder, { recursive: true });
  }
  mkdirSync(join(home, '.cursor'), { recursive: true });
  writeFileSync(
    join(home, '.cursor', 'mcp.json'),
    `${JSON.stringify(cursorMcpConfig({ serverBundle: SERVER_BUNDLE, home: handoffHome }), null, 2)}\n`,
    'utf8',
  );

  const editor = cursorEditorPath();
  if (process.platform !== 'linux' && !existsSync(editor)) {
    rmSync(root, { recursive: true, force: true });
    return {
      exitCode: null,
      durationMs: 0,
      timedOut: true,
      stderr: `Cursor's editor is not at ${editor}; set HANDOFF_CANARY_CURSOR_EDITOR`,
      transcript: [],
      observations: [],
      hookRecords: [],
      toolUses: [],
      toolResults: [],
      result: undefined,
      workspace: root,
    };
  }

  const app = await options.app(handoffHome);
  const started = Date.now();
  const child = spawn(editor, cursorEditorArgs({ userData, extensions, project }), {
    env: cursorEditorEnvironment({ home }),
    stdio: 'ignore',
    detached: process.platform !== 'win32',
    windowsHide: false,
  });
  child.on('error', () => {
    // Reported below as a server that never registered.
  });

  const deadline = started + (options.timeoutMs ?? CURSOR_EDITOR_REGISTRATION_TIMEOUT_MS);
  let registered = false;
  while (!registered && Date.now() < deadline) {
    await pause(500);
    registered = serverHelloReceived(app.transcript());
  }
  // The probe writes its `initialize` before the channel starts; a moment more lets a second
  // server the editor may start show up in the observations too.
  if (registered) await pause(2_000);
  const durationMs = Date.now() - started;
  const transcript = app.transcript();
  closeEditor(child.pid);
  await app.stop();
  await pause(1_500);

  const run: CanaryRun = {
    exitCode: registered ? 0 : null,
    durationMs,
    timedOut: !registered,
    stderr: registered
      ? ''
      : `no server registered within ${String(options.timeoutMs ?? CURSOR_EDITOR_REGISTRATION_TIMEOUT_MS)} ms of launching the editor`,
    transcript: [],
    observations: readNdjson<Observation>(join(handoffHome, 'canary', 'observations.jsonl')),
    hookRecords: [],
    toolUses: [],
    toolResults: [],
    result: registered ? { type: 'result', subtype: 'success', result: 'registered' } : undefined,
    workspace: root,
    app: transcript,
    ...(child.pid === undefined ? {} : { launched: { pid: child.pid } }),
  };

  if (process.env['HANDOFF_CANARY_KEEP'] !== '1') {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        rmSync(root, { recursive: true, force: true });
        break;
      } catch {
        // The editor's processes can hold a file for a moment after they were ended.
        await pause(1_000);
      }
    }
  }
  return run;
}

/** The project folder an editor run opened. */
export function cursorEditorProjectOf(run: CanaryRun): string {
  return join(run.workspace, 'project');
}

/** The home folder an editor run gave the editor, which is where the editor starts its servers. */
export function cursorEditorHomeOf(run: CanaryRun): string {
  return join(run.workspace, 'home');
}

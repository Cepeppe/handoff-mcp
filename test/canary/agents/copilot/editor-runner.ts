/**
 * One launch of VS Code, start to finish: Copilot's editor surface (T-072; TECHNICAL-DESIGN
 * §5.6, §5.8, §14 R-12).
 *
 * VS Code's chat cannot be driven from a script, and unlike Cursor's editor it starts no MCP
 * server when a window opens: it starts them when a chat request is sent, or when the command
 * `workbench.mcp.startServer` is run. So this launches a VS Code of its own — a fresh
 * `--user-data-dir`, whose `User/mcp.json` declares our server, a fresh extensions folder, and
 * `USERPROFILE` (with `HOME`) pointed at the run's folder — together with a two-file extension
 * in development mode that runs that command once the window is up, with
 * `{ autoTrustChanges: true }`, the argument VS Code's own "Start" link in `mcp.json` passes and
 * which starts a server of the user's configuration without the trust prompt. Then it waits for
 * our server to register with a scripted overlay and closes that VS Code again. It spends no
 * credit and never touches the user's own VS Code: a separate user-data folder is a separate
 * instance. It does open a window for the seconds it takes.
 *
 * The extension is written into the run's folder rather than kept in the repository, so the
 * one piece of CommonJS the harness needs is two strings `test/unit/canary/copilot.test.ts`
 * pins, and nothing a linter or a formatter of this repository has to read.
 *
 * Measured against VS Code 1.137.0 on Windows (`docs/agent-facts.md`): the server starts about
 * seven seconds after the launch, under the extension host — a `Code.exe` utility process
 * whose parent is the `Code.exe` `VSCODE_PID` names — with the user's home folder as its working
 * directory, no workspace variable, and the window's folder as the first of its client's roots.
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
import { COPILOT_MCP_SERVER_NAME, copilotServerEnv } from './workspace.ts';

/** How long VS Code has to start our server and let it register. */
export const VSCODE_REGISTRATION_TIMEOUT_MS = 90_000;

/** The name of the run's project folder, which the window's title and the roots both carry. */
export const VSCODE_PROJECT_NAME = 'baton-copilot-window';

/** What an editor scenario asks the harness for. */
export interface VsCodeRunOptions {
  /** Starts the overlay the server registers with, on the run's `HANDOFF_HOME`. */
  readonly app: (home: string) => Promise<CanaryApp>;
  readonly timeoutMs?: number;
}

/** Where VS Code is installed, per platform; `HANDOFF_CANARY_VSCODE` overrides it. */
export function vscodePath(
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const override = env['HANDOFF_CANARY_VSCODE']?.trim();
  if (override !== undefined && override !== '') return override;
  if (platform === 'win32') {
    return join(env['LOCALAPPDATA'] ?? '', 'Programs', 'Microsoft VS Code', 'Code.exe');
  }
  if (platform === 'darwin') return '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
  return 'code';
}

/**
 * VS Code's command line: a user-data and an extensions folder of its own, the starter
 * extension in development mode, workspace trust off for the run, the project last.
 */
export function vscodeArgs(options: {
  readonly userData: string;
  readonly extensions: string;
  readonly starter: string;
  readonly project: string;
}): string[] {
  return [
    '--user-data-dir',
    options.userData,
    '--extensions-dir',
    options.extensions,
    `--extensionDevelopmentPath=${options.starter}`,
    '--disable-workspace-trust',
    '--new-window',
    options.project,
  ];
}

/**
 * VS Code's environment: the parent's, without `CLAUDECODE`, and with the home folder moved to
 * the run's, so that nothing VS Code discovers in a home folder can be the user's.
 */
export function vscodeEnvironment(
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

/** The user's `mcp.json` of the run's profile: our server, as VS Code's `servers` spells it. */
export function vscodeMcpConfig(options: {
  readonly serverBundle: string;
  readonly home: string;
}): Record<string, unknown> {
  return {
    servers: {
      [COPILOT_MCP_SERVER_NAME]: {
        type: 'stdio',
        command: process.execPath,
        args: [options.serverBundle, 'serve'],
        env: copilotServerEnv(options),
      },
    },
  };
}

/** The run's user settings: nothing that would put a dialog or a download in the way. */
export function vscodeUserSettings(): Record<string, unknown> {
  return {
    'security.workspace.trust.enabled': false,
    'workbench.startupEditor': 'none',
    'update.mode': 'none',
    'telemetry.telemetryLevel': 'off',
    'extensions.autoCheckUpdates': false,
    'extensions.autoUpdate': false,
  };
}

/** The starter extension's manifest: activated once the window has started, and nothing else. */
export const VSCODE_STARTER_MANIFEST = {
  name: 'handoff-canary-mcp-starter',
  displayName: 'handoff-mcp canary: start the MCP servers of the profile',
  publisher: 'handoff-canary',
  version: '0.0.1',
  engines: { vscode: '^1.99.0' },
  main: './extension.js',
  activationEvents: ['onStartupFinished'],
} as const;

/**
 * The starter extension itself: it asks VS Code to start every server of the profile — ours is
 * the only one — every three seconds for a minute, because the user configuration may not be
 * read yet the first time; a server already running is left alone.
 */
export const VSCODE_STARTER_SCRIPT = [
  "const vscode = require('vscode');",
  '',
  'exports.activate = async function activate() {',
  '  const deadline = Date.now() + 60000;',
  '  while (Date.now() < deadline) {',
  '    try {',
  "      await vscode.commands.executeCommand('workbench.mcp.startServer', '*', {",
  '        autoTrustChanges: true,',
  '      });',
  '    } catch {',
  '      // The MCP service is not up yet: the next round asks again.',
  '    }',
  '    await new Promise((resolve) => setTimeout(resolve, 3000));',
  '  }',
  '};',
  '',
  'exports.deactivate = function deactivate() {};',
  '',
].join('\n');

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

/** Ends the VS Code it launched and everything it started, our server among them. */
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

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/**
 * Launches VS Code on a throw-away project and returns what the registration showed.
 *
 * The run is well formed when a server registered: `exitCode` 0 and a `result` then, and a
 * timed-out run with the reason in `stderr` otherwise. `launched` is VS Code's own process,
 * the one its servers have to name in their chain.
 */
export async function runVsCode(options: VsCodeRunOptions): Promise<CanaryRun> {
  const root = mkdtempSync(join(tmpdir(), 'handoff-canary-vscode-'));
  const project = join(root, VSCODE_PROJECT_NAME);
  const home = join(root, 'home');
  const handoffHome = join(root, 'handoff-home');
  const userData = join(root, 'user-data');
  const extensions = join(root, 'extensions');
  const starter = join(root, 'starter');
  for (const folder of [project, home, handoffHome, join(userData, 'User'), extensions, starter]) {
    mkdirSync(folder, { recursive: true });
  }
  writeJson(join(userData, 'User', 'settings.json'), vscodeUserSettings());
  writeJson(
    join(userData, 'User', 'mcp.json'),
    vscodeMcpConfig({ serverBundle: SERVER_BUNDLE, home: handoffHome }),
  );
  writeJson(join(starter, 'package.json'), VSCODE_STARTER_MANIFEST);
  writeFileSync(join(starter, 'extension.js'), VSCODE_STARTER_SCRIPT, 'utf8');

  const editor = vscodePath();
  if (process.platform !== 'linux' && !existsSync(editor)) {
    rmSync(root, { recursive: true, force: true });
    return {
      exitCode: null,
      durationMs: 0,
      timedOut: true,
      stderr: `VS Code is not at ${editor}; set HANDOFF_CANARY_VSCODE`,
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
  const child = spawn(editor, vscodeArgs({ userData, extensions, starter, project }), {
    env: vscodeEnvironment({ home }),
    stdio: 'ignore',
    detached: process.platform !== 'win32',
    windowsHide: false,
  });
  child.on('error', () => {
    // Reported below as a server that never registered.
  });

  const budget = options.timeoutMs ?? VSCODE_REGISTRATION_TIMEOUT_MS;
  const deadline = started + budget;
  let registered = false;
  while (!registered && Date.now() < deadline) {
    await pause(500);
    registered = serverHelloReceived(app.transcript());
  }
  // A moment more lets a second server VS Code may start show up in the observations too.
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
      : `no server registered within ${String(budget)} ms of launching VS Code`,
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
        // VS Code's processes can hold a file for a moment after they were ended.
        await pause(1_000);
      }
    }
  }
  return run;
}

/** The project folder an editor run opened. */
export function vscodeProjectOf(run: CanaryRun): string {
  return join(run.workspace, VSCODE_PROJECT_NAME);
}

/** The home folder an editor run gave VS Code, which is where VS Code starts its servers. */
export function vscodeHomeOf(run: CanaryRun): string {
  return join(run.workspace, 'home');
}

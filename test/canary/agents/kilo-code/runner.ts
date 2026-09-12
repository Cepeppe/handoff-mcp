/**
 * One `kilo run`, start to finish (T-081, TECHNICAL-DESIGN §11.5) — the Kilo Code twin of
 * `../opencode/runner.ts`. It returns the same `CanaryRun`, so the classifier, the driver and
 * the report never ask which agent produced it.
 *
 * Kilo's CLI is a fork of OpenCode and prints OpenCode's JSON events (`--format json`), each
 * carrying the session id, so they are read by OpenCode's own parser. Two things differ.
 *
 * - **What is started.** The `kilo` on `PATH` is an npm shim, then a Node launcher, then the
 *   platform's native `kilo.exe` (T-080), and the server's parent is that last one. So the
 *   runner starts the native binary itself, found where npm nests or hoists the platform
 *   package, and records its pid in `launched`: the observation scenario checks that the
 *   server's parent is exactly that process, the `parent_pid` key of the CLI surface (SRV-19).
 * - **The launcher's one variable.** The launcher points the binary at the tree-sitter
 *   resources beside it (`KILO_TREE_SITTER_WASM_DIR`), and the runner does the same when they
 *   are there.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { SERVER_BUNDLE, readNdjson, type CanaryRun, type Observation } from '../../runner.ts';
import type { CanaryApp } from '../codex/runner.ts';
import { parseOpenCodeEvents, type OpenCodeLine } from '../opencode/runner.ts';
import {
  KILO_DEFAULT_MODEL,
  kiloArgs,
  kiloChildEnvironment,
  kiloDeleteArgs,
  type KiloWorkspaceOptions,
} from './workspace.ts';

/** How long a whole Kilo run may take before it is killed and reported as a protocol failure. */
export const KILO_DEFAULT_TIMEOUT_MS = 300_000;

/** What a Kilo Code scenario asks the harness for. */
export interface KiloRunOptions {
  readonly prompt: string;
  /**
   * The scenario's own model, when it needs one the others do not (the image scenario, which
   * needs a model that reads images). It outranks `HANDOFF_CANARY_KILO_CODE_MODEL`, which picks
   * the model of every other scenario.
   */
  readonly model?: string;
  readonly timeoutMs?: number;
  /** The per-server `timeout` of our entry, in milliseconds (A-04). */
  readonly entryTimeoutMs?: number;
  /** Starts an overlay on the run's `HANDOFF_HOME` before the agent, and stops it after. */
  readonly app?: (home: string) => Promise<CanaryApp>;
}

/** How to start `kilo`: the program, and whether a shell is needed. */
export interface KiloCommand {
  readonly command: string;
  readonly shell: boolean;
}

/** What `kiloCommandFrom` needs to know about the machine; injected so the unit suite can pin it. */
export interface KiloPlatform {
  readonly windows: boolean;
  /** `process.platform`. */
  readonly name: string;
  /** `process.arch`. */
  readonly arch: string;
  readonly exists: (path: string) => boolean;
  /** Follows the symlink npm puts on `PATH` outside Windows. */
  readonly realpath: (path: string) => string;
}

/**
 * The platform packages the launcher looks for, in the order it tries them on a machine with
 * AVX2: `@kilocode/cli-<platform>-<arch>`, then its `-baseline` build on x64.
 */
export function kiloPlatformPackages(name: string, arch: string): string[] {
  const platform = name === 'win32' ? 'windows' : name;
  const base = `cli-${platform}-${arch}`;
  return arch === 'x64' ? [base, `${base}-baseline`] : [base];
}

/**
 * Where the native binary can be, given the path of the Node launcher
 * (`…/node_modules/@kilocode/cli/bin/kilo`): nested under the CLI package, as npm 11 installed
 * it here, or hoisted beside it.
 */
export function kiloBinaryCandidates(launcher: string, platform: KiloPlatform): string[] {
  const binary = platform.windows ? 'kilo.exe' : 'kilo';
  const cli = dirname(dirname(launcher));
  const scope = dirname(cli);
  const candidates: string[] = [];
  for (const name of kiloPlatformPackages(platform.name, platform.arch)) {
    candidates.push(join(cli, 'node_modules', '@kilocode', name, 'bin', binary));
    candidates.push(join(scope, name, 'bin', binary));
  }
  return candidates;
}

/**
 * Picks the way to start Kilo from what `where`/`which` found.
 *
 * A native executable is started directly. An npm install leaves a shim on `PATH` — `kilo.cmd`
 * on Windows, a symlink to the Node launcher elsewhere — which would put two processes between
 * the harness and the binary that starts our server, and on Windows `cmd.exe` would have its say
 * about the quotes of a prompt carrying JSON. So the shim is bypassed for the binary of the
 * platform package, and the shim itself is used, through a shell on Windows, only when that
 * binary is not where npm puts it. On Windows an extensionless match is the shell-script shim
 * and is skipped.
 */
export function kiloCommandFrom(found: readonly string[], platform: KiloPlatform): KiloCommand {
  const usable = found.filter((path) => !platform.windows || /\.(?:exe|cmd|bat)$/iu.test(path));
  const first = usable[0];
  if (first === undefined) return { command: 'kilo', shell: platform.windows };
  if (platform.windows && /\.exe$/iu.test(first)) return { command: first, shell: false };
  const launcher = platform.windows
    ? join(dirname(first), 'node_modules', '@kilocode', 'cli', 'bin', 'kilo')
    : platform.realpath(first);
  for (const candidate of kiloBinaryCandidates(launcher, platform)) {
    if (platform.exists(candidate)) return { command: candidate, shell: false };
  }
  return { command: first, shell: /\.(?:cmd|bat)$/iu.test(first) };
}

/** `HANDOFF_CANARY_KILO_CODE` when it names a program, else the first `kilo` on `PATH`. */
export function resolveKilo(
  env: Readonly<Record<string, string | undefined>> = process.env,
): KiloCommand {
  const platform: KiloPlatform = {
    windows: process.platform === 'win32',
    name: process.platform,
    arch: process.arch,
    exists: existsSync,
    realpath: (path) => {
      try {
        return realpathSync(path);
      } catch {
        return path;
      }
    },
  };
  const override = env['HANDOFF_CANARY_KILO_CODE']?.trim();
  if (override !== undefined && override !== '') return kiloCommandFrom([override], platform);
  let found: string[] = [];
  try {
    found = execFileSync(platform.windows ? 'where' : 'which', ['kilo'], {
      encoding: 'utf8',
      windowsHide: true,
    })
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line !== '');
  } catch {
    // Not on PATH: the spawn reports it, and the driver stops with exit 2.
  }
  return kiloCommandFrom(found, platform);
}

/**
 * The variable the npm launcher would have set for the binary it starts: the folder of the
 * tree-sitter resources beside it, when they are there.
 */
export function kiloLauncherEnv(
  command: KiloCommand,
  exists: (path: string) => boolean,
): Record<string, string> {
  if (command.shell) return {};
  const folder = join(dirname(command.command), 'tree-sitter');
  return exists(join(folder, 'tree-sitter.wasm')) ? { KILO_TREE_SITTER_WASM_DIR: folder } : {};
}

/** Spawns `kilo`, collects stdout line by line with arrival times, and kills it past the budget. */
function spawnKilo(
  kilo: KiloCommand,
  args: readonly string[],
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
): Promise<{
  lines: OpenCodeLine[];
  stderr: string;
  code: number | null;
  timedOut: boolean;
  pid: number | undefined;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(kilo.command, [...args], {
      cwd,
      env,
      shell: kilo.shell,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const pid = child.pid;
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
      resolve({ lines, stderr, code, timedOut, pid });
    });
  });
}

/**
 * Removes the run's session from the user's Kilo history, by the id the run printed. Best
 * effort: a session that could not be deleted is a line in a list, not a failed canary.
 */
function deleteSession(
  kilo: KiloCommand,
  sessionId: string,
  cwd: string,
  env: Record<string, string>,
): void {
  try {
    execFileSync(kilo.command, kiloDeleteArgs(sessionId), {
      cwd,
      env,
      shell: kilo.shell,
      windowsHide: true,
      stdio: 'ignore',
      timeout: 60_000,
    });
  } catch {
    // Nothing to report: see above.
  }
}

/**
 * Runs one scenario against the real Kilo CLI and returns everything it produced.
 *
 * The temporary root is removed when the run ends, unless `HANDOFF_CANARY_KEEP=1`. There is no
 * hook record: Kilo has no command hook to declare (docs/agent-facts.md).
 */
export async function runKilo(options: KiloRunOptions): Promise<CanaryRun> {
  const root = mkdtempSync(join(tmpdir(), 'handoff-canary-kilo-code-'));
  const project = join(root, 'project');
  const home = join(root, 'home');
  const configHome = join(root, 'config');
  for (const folder of [project, home, configHome]) mkdirSync(folder, { recursive: true });

  const workspace: KiloWorkspaceOptions = {
    serverBundle: SERVER_BUNDLE,
    home,
    project,
    configHome,
    ...(options.entryTimeoutMs === undefined ? {} : { timeoutMs: options.entryTimeoutMs }),
  };
  const args = kiloArgs({
    prompt: options.prompt,
    model: options.model ?? process.env['HANDOFF_CANARY_KILO_CODE_MODEL'] ?? KILO_DEFAULT_MODEL,
  });
  const kilo = resolveKilo();
  const env = { ...kiloChildEnvironment(workspace), ...kiloLauncherEnv(kilo, existsSync) };

  const app = options.app === undefined ? undefined : await options.app(home);
  const started = Date.now();
  let child: Awaited<ReturnType<typeof spawnKilo>>;
  try {
    child = await spawnKilo(kilo, args, project, env, options.timeoutMs ?? KILO_DEFAULT_TIMEOUT_MS);
  } catch (cause) {
    await app?.stop();
    throw cause;
  }
  const durationMs = Date.now() - started;
  const appTranscript = app?.transcript();
  await app?.stop();

  const parsed = parseOpenCodeEvents(child.lines);
  if (parsed.sessionId !== undefined) deleteSession(kilo, parsed.sessionId, project, env);

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
    ...(child.pid === undefined || kilo.shell ? {} : { launched: { pid: child.pid } }),
    ...(appTranscript === undefined ? {} : { app: appTranscript }),
  };

  if (process.env['HANDOFF_CANARY_KEEP'] !== '1') {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // A server Kilo has not reaped yet can hold a file for a moment; the folder is under the
      // temporary directory either way, and a failed cleanup is not a failed canary.
    }
  }
  return run;
}

/** The project folder a Kilo run was started in. */
export function kiloProjectOf(run: CanaryRun): string {
  return join(run.workspace, 'project');
}

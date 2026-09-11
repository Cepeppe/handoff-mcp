/**
 * The process ancestor chain that travels in `hello` (TECHNICAL-DESIGN §5.8, DD-22,
 * SRV-17, SRV-19).
 *
 * The app binds an agent session to a registration by intersecting PIDs, so the more of its
 * own chain a peer can state, the fewer ambiguous sessions the user is asked about. What
 * the chain costs, though, differs per platform, and DD-22 chose the cheapest reliable
 * mechanism on each rather than one portable mechanism everywhere:
 *
 * - **macOS**: one `ps -axo pid=,ppid=,comm=` spawn (≈ 20 ms), capped at 200 ms, parsed
 *   into a table and walked. One spawn, not one per generation.
 * - **Windows**: nothing is spawned, with one exception. `Get-CimInstance` or WMI would cost
 *   hundreds of milliseconds against the hook's 1 800 ms budget, so the hook and every other
 *   session send only `pid` and `ppid` and the app — which has a native process table
 *   (`sysinfo`) — completes the chain itself. The exception is a server an editor may have
 *   started (T-069, `windowsChain`): telling the editor's own processes from an agent's
 *   needs the names in the chain, so that server pays one PowerShell process-table query,
 *   measured at 0.6 to 0.8 s, once per session and never in the hook.
 * - **Linux**: `/proc/<pid>/status`, a few small reads. Linux is not a supported platform;
 *   this exists because it is nearly free and keeps the door open.
 *
 * Nothing here is load-bearing: the app always resolves the chain of a connected peer
 * itself and uses the union (DD-22), so an empty list costs nothing but a little precision
 * while the peer is alive.
 */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** §5.8: the `ps` spawn is capped at 200 ms; what is not ready by then is not sent. */
export const ANCESTOR_TIMEOUT_MS = 200;

/**
 * How many generations are walked. A process tree is a few levels deep; the cap is there
 * so that a table with a cycle in it — which a `ps` snapshot taken during a reparenting
 * can produce — cannot turn into an endless walk.
 */
export const MAX_ANCESTOR_DEPTH = 32;

/** One ancestor, as `channel.v1.schema.json` requires it. */
export interface ProcessAncestor {
  readonly pid: number;
  readonly name: string;
}

/** The process half of the identity payload of §5.8. */
export interface ProcessIdentity {
  readonly pid: number;
  readonly ppid: number;
  readonly ancestors: readonly ProcessAncestor[];
}

/** One row of the platform's process table. */
export interface ProcessTableEntry {
  readonly ppid: number;
  readonly name: string;
}

/** Runs a command and returns its stdout, or rejects. Injected so tests need no processes. */
export type CommandRunner = (
  command: string,
  args: readonly string[],
  timeoutMs: number,
) => Promise<string>;

/** The `ps` invocation of DD-22, verbatim: no header, three columns, every process. */
export const PS_COMMAND = 'ps';
export const PS_ARGS: readonly string[] = ['-axo', 'pid=,ppid=,comm='];

const runCommand: CommandRunner = (command, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      { timeout: timeoutMs, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        if (error === null) resolve(stdout);
        else reject(new Error(`${command} failed`, { cause: error }));
      },
    );
  });

/**
 * The last segment of a command, which is the name the app compares against its own table.
 * `ps -o comm=` prints the full executable path on macOS, so the chain of §6.4 reads
 * `iTerm2` and not `/Applications/iTerm.app/Contents/MacOS/iTerm2`.
 */
function baseName(command: string): string {
  const trimmed = command.trim();
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return cut === -1 ? trimmed : trimmed.slice(cut + 1);
}

/**
 * Parses `pid ppid comm` rows into a table. The columns are right-aligned and the command
 * is the rest of the line, spaces included, so it is taken whole and then reduced to its
 * last segment. A row that does not start with two integers is not a row of this table —
 * a header a future `ps` might print, a warning on stdout — and is skipped.
 */
export function parseProcessTable(text: string): Map<number, ProcessTableEntry> {
  const table = new Map<number, ProcessTableEntry>();
  for (const line of text.split(/\r?\n/u)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(line);
    if (match === null) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const name = baseName(match[3] ?? '');
    if (name === '') continue;
    table.set(pid, { ppid, name });
  }
  return table;
}

/**
 * The chain above `pid`, nearest parent first, as §6.4 prints it. The walk stops at the
 * root (`ppid` 0), at a pid the table does not know, at a pid already seen, and at the
 * depth cap. `pid` itself is never in its own chain: it travels as `identity.pid`.
 */
export function ancestorChain(
  table: ReadonlyMap<number, ProcessTableEntry>,
  pid: number,
  maxDepth: number = MAX_ANCESTOR_DEPTH,
): ProcessAncestor[] {
  const chain: ProcessAncestor[] = [];
  const seen = new Set<number>([pid]);
  let current = table.get(pid)?.ppid ?? 0;

  while (current > 0 && chain.length < maxDepth && !seen.has(current)) {
    const entry = table.get(current);
    if (entry === undefined) break;
    seen.add(current);
    chain.push({ pid: current, name: entry.name });
    current = entry.ppid;
  }
  return chain;
}

/** `Name:` and `PPid:` of `/proc/<pid>/status`, the two fields the walk needs. */
export function parseProcStatus(text: string): ProcessTableEntry | undefined {
  const name = /^Name:\s*(.+)$/mu.exec(text)?.[1]?.trim();
  const ppid = /^PPid:\s*(\d+)$/mu.exec(text)?.[1];
  if (name === undefined || name === '' || ppid === undefined) return undefined;
  return { ppid: Number(ppid), name };
}

/**
 * Walks `/proc` one generation at a time. `Name:` is the kernel's `comm`, truncated to
 * fifteen characters; best effort is what DD-22 asks for and what the app completes.
 */
function procChain(
  pid: number,
  readFile: (path: string) => string,
  maxDepth: number,
): ProcessAncestor[] {
  const table = new Map<number, ProcessTableEntry>();
  const collect = (target: number): boolean => {
    try {
      const entry = parseProcStatus(readFile(`/proc/${String(target)}/status`));
      if (entry === undefined) return false;
      table.set(target, entry);
      return true;
    } catch {
      return false;
    }
  };

  if (!collect(pid)) return [];
  let current = table.get(pid)?.ppid ?? 0;
  for (let depth = 0; depth < maxDepth && current > 0; depth += 1) {
    if (!collect(current)) break;
    current = table.get(current)?.ppid ?? 0;
  }
  return ancestorChain(table, pid, maxDepth);
}

/**
 * The cap on the one Windows walk of T-069. It was measured at 0.6 to 0.8 s on the
 * development machine, most of it PowerShell starting; the cap leaves room for a busy
 * machine, and what is not ready by then is not sent.
 */
export const WINDOWS_ANCESTOR_TIMEOUT_MS = 5_000;

/**
 * The Windows walk of T-069: one PowerShell spawn that lists every process in the three
 * columns `ps` prints, so `parseProcessTable` and `ancestorChain` read it unchanged. One spawn
 * and one query, not one per generation. The output encoding is set first so that a process
 * name outside the console's code page arrives intact.
 */
export const POWERSHELL_COMMAND = 'powershell.exe';
export const POWERSHELL_ARGS: readonly string[] = [
  '-NoProfile',
  '-NonInteractive',
  '-Command',
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8; ' +
    'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.Name)" }',
];

export interface AncestorOptions {
  readonly platform?: NodeJS.Platform;
  readonly pid?: number;
  readonly ppid?: number;
  readonly timeoutMs?: number;
  readonly maxDepth?: number;
  readonly run?: CommandRunner;
  readonly readFile?: (path: string) => string;
  /**
   * Walk the chain on Windows as well (T-069): the one PowerShell spawn above, for a server
   * an editor may have started, whose session identity needs the names in its chain. Off by
   * default, and the hook never sets it (DD-22).
   */
  readonly windowsChain?: boolean;
  /** The cap on that walk, `WINDOWS_ANCESTOR_TIMEOUT_MS` unless a test says otherwise. */
  readonly windowsTimeoutMs?: number;
}

/**
 * `pid`, `ppid` and as much of the chain as this platform gives cheaply (§5.8, DD-22).
 *
 * Every failure — `ps` missing, killed by the timeout, printing something unexpected,
 * `/proc` not mounted — is an empty chain and never an exception: the identity payload is
 * still complete without it, and a session that fails to register because a process listing
 * failed would be the wrong trade entirely.
 */
export async function resolveProcessIdentity(
  options: AncestorOptions = {},
): Promise<ProcessIdentity> {
  const {
    platform = process.platform,
    pid = process.pid,
    ppid = process.ppid,
    timeoutMs = ANCESTOR_TIMEOUT_MS,
    maxDepth = MAX_ANCESTOR_DEPTH,
    run = runCommand,
    readFile,
    windowsChain = false,
    windowsTimeoutMs = WINDOWS_ANCESTOR_TIMEOUT_MS,
  } = options;

  if (platform === 'win32' && windowsChain) {
    try {
      const table = parseProcessTable(
        await run(POWERSHELL_COMMAND, POWERSHELL_ARGS, windowsTimeoutMs),
      );
      return { pid, ppid, ancestors: ancestorChain(table, pid, maxDepth) };
    } catch {
      return { pid, ppid, ancestors: [] };
    }
  }

  if (platform === 'darwin') {
    try {
      const table = parseProcessTable(await run(PS_COMMAND, PS_ARGS, timeoutMs));
      return { pid, ppid, ancestors: ancestorChain(table, pid, maxDepth) };
    } catch {
      return { pid, ppid, ancestors: [] };
    }
  }

  if (platform === 'linux') {
    const read = readFile ?? ((path: string) => readFileSync(path, 'utf8'));
    return { pid, ppid, ancestors: procChain(pid, read, maxDepth) };
  }

  // Windows and anything else: no spawn, no chain. The app completes it (DD-22).
  return { pid, ppid, ancestors: [] };
}

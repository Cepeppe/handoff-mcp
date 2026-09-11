/**
 * The recording hook of the Cursor canary (T-069; Appendix B A-05, A-06, A-11 read for Cursor).
 *
 * `workspace.ts` declares it twice, as Cursor's own `stop` hook and as a Claude Code `Stop`
 * hook, which Cursor runs as its own (T-068), and the label on the command line says which
 * declaration ran it. It records the field names of the payload and only the few values the
 * facts need — Cursor also puts the user's e-mail address and the transcript's path in it — its
 * own process chain, and which of Cursor's variables reached it.
 *
 * Unlike `../../hooks/record-stop.mjs` it never asks the agent to continue: a Cursor follow-up
 * is a new user message, and a canary must not spend the account's requests on one. It prints
 * `{}` and exits 0 whatever happens.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

const [out, label] = process.argv.slice(2);

/** The values a fact may carry. Everything else in the payload is reported by name only. */
const SAFE_VALUES = ['hook_event_name', 'status', 'loop_count', 'stop_hook_active'];

/** The variables whose presence is reported, never their values. */
const ENV_NAMES = ['CURSOR_PROJECT_DIR', 'CLAUDE_PROJECT_DIR', 'CURSOR_VERSION', 'HANDOFF_HOME'];

/** The chain above this process, nearest parent first, with names: one spawn per platform. */
function ancestorChain() {
  const table = new Map();
  try {
    const text =
      process.platform === 'win32'
        ? execFileSync(
            'powershell.exe',
            [
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.Name)" }',
            ],
            { encoding: 'utf8', timeout: 20000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
          )
        : execFileSync('ps', ['-axo', 'pid=,ppid=,comm='], {
            encoding: 'utf8',
            timeout: 20000,
            maxBuffer: 8 * 1024 * 1024,
          });
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (match !== null) {
        const name = match[3].trim().split(/[\\/]/).pop() ?? '';
        table.set(Number(match[1]), { ppid: Number(match[2]), name });
      }
    }
  } catch {
    return [];
  }
  const chain = [];
  const seen = new Set([process.pid]);
  let current = table.get(process.pid)?.ppid ?? process.ppid;
  for (let depth = 0; depth < 32 && current !== undefined && current > 0; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    const entry = table.get(current);
    if (entry === undefined) break;
    chain.push({ pid: current, name: entry.name });
    current = entry.ppid;
  }
  return chain;
}

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

let payload;
try {
  payload = JSON.parse(readStdin());
} catch {
  payload = undefined;
}
const isObject = typeof payload === 'object' && payload !== null && !Array.isArray(payload);
const chain = ancestorChain();

if (typeof out === 'string' && out !== '') {
  try {
    mkdirSync(dirname(out), { recursive: true });
    appendFileSync(
      out,
      `${JSON.stringify({
        at: new Date().toISOString(),
        label: label ?? 'unlabelled',
        pid: process.pid,
        ppid: process.ppid,
        ancestors: chain.map((entry) => entry.pid),
        ancestor_names: chain.map((entry) => entry.name),
        blocked: false,
        parsed: isObject,
        keys: isObject ? Object.keys(payload).sort() : [],
        input: isObject
          ? Object.fromEntries(
              SAFE_VALUES.filter((key) => key in payload).map((key) => [key, payload[key]]),
            )
          : {},
        env_present: ENV_NAMES.filter((name) => (process.env[name] ?? '').trim() !== ''),
      })}\n`,
      'utf8',
    );
  } catch {
    // Recording is best effort: the harness reports the missing record instead.
  }
}

process.stdout.write('{}');

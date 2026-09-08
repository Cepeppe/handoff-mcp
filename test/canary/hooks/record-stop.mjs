/**
 * The recording Stop hook of the canary harness (T-023; Appendix B A-05, A-06, A-11).
 *
 * It is not `handoff-mcp hook stop` and must not be confused with it: this script exists to
 * *observe* the agent, so it records the whole JSON payload it was handed, its own process
 * chain, and whether it decided to block. The product hook records nothing and talks to the
 * app instead.
 *
 * What each assumption reads from the file it writes:
 *
 * - **A-05** — the field names of `input`, and the fact that a `{"decision":"block"}` on the
 *   first invocation is followed by a second invocation carrying `stop_hook_active: true`.
 *   The hook therefore blocks exactly once per run: blocking again would loop for ever,
 *   which is precisely what `stop_hook_active` exists to prevent.
 * - **A-06** — that the file exists at all: hooks declared in a project
 *   `.claude/settings.json` ran under `claude -p`.
 * - **A-11** — `ancestors`, the pid chain above this process. The product hook does not
 *   compute one on Windows (DD-22: it would cost hundreds of milliseconds against a
 *   1 800 ms budget and the app completes the chain itself), but the canary has no budget
 *   and the assumption is exactly about what that chain contains.
 *
 * It writes to `HANDOFF_CANARY_HOOK_OUT` and exits 0 whatever happens: a hook that fails is
 * a hook that can hold up the agent, and a canary must never do that.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

const OUT = process.env.HANDOFF_CANARY_HOOK_OUT;

/**
 * The pid chain above this process, nearest parent first.
 *
 * One spawn on each platform, and a failure is an empty chain rather than an exception:
 * `wmic` is gone from recent Windows builds, so this asks PowerShell for the whole process
 * table in one go and walks it, the same shape as `ps -axo pid=,ppid=` on the others.
 */
function ancestorChain() {
  const table = new Map();
  try {
    if (process.platform === 'win32') {
      const text = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.Name)" }',
        ],
        { encoding: 'utf8', timeout: 20000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      );
      for (const line of text.split(/\r?\n/)) {
        const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
        if (match !== null) table.set(Number(match[1]), Number(match[2]));
      }
    } else {
      const text = execFileSync('ps', ['-axo', 'pid=,ppid='], {
        encoding: 'utf8',
        timeout: 20000,
        maxBuffer: 8 * 1024 * 1024,
      });
      for (const line of text.split(/\r?\n/)) {
        const match = /^\s*(\d+)\s+(\d+)/.exec(line);
        if (match !== null) table.set(Number(match[1]), Number(match[2]));
      }
    }
  } catch {
    return [];
  }

  const chain = [];
  const seen = new Set([process.pid]);
  let current = table.get(process.pid) ?? process.ppid;
  for (let depth = 0; depth < 32 && current !== undefined && current > 0; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    chain.push(current);
    current = table.get(current);
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

const raw = readStdin();

function parsePayload(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { parse_error: true, raw_length: text.length };
  }
}

const input = parsePayload(raw);

// A-05: block once, then never again. `stop_hook_active` is the agent telling us that this
// invocation is already the consequence of a block, and a hook that ignored it would keep
// the session alive for ever.
const blocked = input !== null && input.stop_hook_active !== true;

if (typeof OUT === 'string' && OUT !== '') {
  try {
    mkdirSync(dirname(OUT), { recursive: true });
    appendFileSync(
      OUT,
      `${JSON.stringify({
        at: new Date().toISOString(),
        pid: process.pid,
        ppid: process.ppid,
        ancestors: ancestorChain(),
        blocked,
        input,
      })}\n`,
      'utf8',
    );
  } catch {
    // Recording is best effort: the harness reports the missing record instead.
  }
}

if (blocked) {
  process.stdout.write(
    JSON.stringify({ decision: 'block', reason: 'Canary probe: one blocking round.' }),
  );
}

// Smoke test of a built Single Executable Application (T-009 acceptance).
//
// It runs the binary the way a user's machine would: no Node.js on `PATH`, no repository
// around it, only the file. Four checks:
//
//   1. `--version` prints the version of `package.json` on stderr and exits 0.
//   2. `--help` lists the five subcommands of the CLI table (§5.12) and exits 0.
//   3. an unknown subcommand exits 2 (usage error).
//   4. `serve` answers an MCP `initialize` over stdio with a JSON-RPC result.
//
// Check 4 is the one that proves the embedded bundle really loads the MCP SDK. Until the
// server is implemented (T-017) `serve` is a placeholder that exits 1 with a documented
// message; the check then reports itself as pending instead of failing, and starts
// asserting the real result the moment the placeholder disappears. Nothing here is
// specific to a platform: `sea.yml` runs it on every leg.
//
// Usage: node build/sea/smoke.mjs [path-to-binary]
//        (the default is the asset of `build-sea.mjs` for the host platform)
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const seaDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(seaDir, '..', '..');
const version = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version;

/** The exact message `src/main.ts` prints while `serve` belongs to a later task. */
const SERVE_PLACEHOLDER = 'serve is not implemented (T-017)';

/** Any revision the server may answer to; it replies with the one it supports. */
const MCP_PROTOCOL_VERSION = '2025-06-18';

const TIMEOUT_MS = 30_000;

const results = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  const mark = ok === 'pending' ? '~' : ok ? 'ok' : 'FAIL';
  console.error(`[${mark}] ${name}${detail ? ` — ${detail}` : ''}`);
}

/** Runs the binary to completion and collects both streams. */
function runOnce(binary, args, { stdin } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      rejectRun(
        new Error(`${args.join(' ') || '(no arguments)'} did not exit within ${TIMEOUT_MS} ms`),
      );
    }, TIMEOUT_MS);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (err += chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      rejectRun(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolveRun({ code, out, err });
    });

    if (stdin !== undefined) child.stdin.write(stdin);
    child.stdin.end();
  });
}

/**
 * Sends one `initialize` request on stdin and waits for the first complete JSON line on
 * stdout, which is how the MCP stdio transport frames messages.
 */
function initialize(binary) {
  return new Promise((resolveInit, rejectInit) => {
    const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    let buffered = '';
    let err = '';
    let settled = false;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolveInit(value);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      rejectInit(
        new Error(`no answer to initialize within ${TIMEOUT_MS} ms (stderr: ${err.trim()})`),
      );
    }, TIMEOUT_MS);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => (err += chunk));
    child.stdout.on('data', (chunk) => {
      buffered += chunk;
      let newline = buffered.indexOf('\n');
      while (newline !== -1) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (line !== '') {
          finish({ kind: 'message', line, err });
          return;
        }
        newline = buffered.indexOf('\n');
      }
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectInit(error);
    });
    child.on('close', (code) => finish({ kind: 'exit', code, out: buffered, err }));

    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'handoff-mcp-sea-smoke', version: '1' },
        },
      })}\n`,
    );
  });
}

async function checkInitialize(binary) {
  const answer = await initialize(binary);

  if (answer.kind === 'exit') {
    if (answer.code === 1 && answer.err.includes(SERVE_PLACEHOLDER)) {
      record(
        'MCP initialize over stdio',
        'pending',
        'serve is still the placeholder of T-017; this check asserts the real result as soon as it is implemented',
      );
      return;
    }
    record(
      'MCP initialize over stdio',
      false,
      `the process exited with code ${answer.code} before answering (stderr: ${answer.err.trim() || 'empty'})`,
    );
    return;
  }

  let message;
  try {
    message = JSON.parse(answer.line);
  } catch {
    record('MCP initialize over stdio', false, `stdout is not JSON: ${answer.line.slice(0, 200)}`);
    return;
  }
  if (message.error !== undefined) {
    record('MCP initialize over stdio', false, `JSON-RPC error ${JSON.stringify(message.error)}`);
    return;
  }
  if (message.id !== 1 || typeof message.result !== 'object' || message.result === null) {
    record('MCP initialize over stdio', false, `unexpected answer ${answer.line.slice(0, 200)}`);
    return;
  }
  const { protocolVersion, serverInfo } = message.result;
  if (typeof protocolVersion !== 'string' || typeof serverInfo?.name !== 'string') {
    record(
      'MCP initialize over stdio',
      false,
      `result without protocolVersion or serverInfo: ${answer.line.slice(0, 200)}`,
    );
    return;
  }
  record(
    'MCP initialize over stdio',
    true,
    `${serverInfo.name} ${serverInfo.version ?? '?'} speaking ${protocolVersion}`,
  );
}

async function main() {
  const given = process.argv[2];
  let binary;
  if (given !== undefined) {
    binary = resolve(given);
  } else {
    const printed = await runOnce(process.execPath, [
      join(seaDir, 'build-sea.mjs'),
      '--print-target',
    ]);
    if (printed.code !== 0) {
      console.error(`smoke: cannot resolve the default binary — ${printed.err.trim()}`);
      process.exitCode = 2;
      return;
    }
    binary = join(repoRoot, JSON.parse(printed.out).out);
  }

  if (!existsSync(binary)) {
    console.error(`smoke: ${binary} does not exist; build it with \`pnpm build:sea\``);
    process.exitCode = 2;
    return;
  }
  console.error(`smoking ${binary}\n`);

  const versionRun = await runOnce(binary, ['--version']);
  record(
    '--version',
    versionRun.code === 0 && versionRun.err.trim() === version,
    `exit ${versionRun.code}, stderr ${JSON.stringify(versionRun.err.trim())}, expected ${JSON.stringify(version)}`,
  );

  const helpRun = await runOnce(binary, ['--help']);
  const subcommands = ['serve', 'hook stop', 'validate', 'runbooks search', 'doctor'];
  const missing = subcommands.filter((name) => !helpRun.err.includes(name));
  record(
    '--help lists the five subcommands',
    helpRun.code === 0 && missing.length === 0,
    missing.length === 0 ? `exit ${helpRun.code}` : `missing: ${missing.join(', ')}`,
  );

  const usageRun = await runOnce(binary, ['definitely-not-a-subcommand']);
  record('unknown subcommand exits 2', usageRun.code === 2, `exit ${usageRun.code}`);

  await checkInitialize(binary);

  const failed = results.filter((r) => r.ok === false);
  const pending = results.filter((r) => r.ok === 'pending');
  console.error(
    `\n${results.length - failed.length - pending.length} passed, ${pending.length} pending, ${failed.length} failed`,
  );
  if (failed.length > 0) process.exitCode = 1;
}

await main();

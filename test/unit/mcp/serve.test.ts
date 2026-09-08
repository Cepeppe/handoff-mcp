/**
 * `serve` and the end of a session (TECHNICAL-DESIGN §5.3, §5.12).
 *
 * One thing is being pinned here and it is worth its own file: **`serve` returns when the
 * agent closes stdin**. The SDK's `StdioServerTransport` subscribes to `data` and `error`
 * only and closes when somebody calls `close()`, so nothing in it notices EOF. While the
 * channel did not exist the omission was invisible — the process had no handles left and
 * exited anyway — and it stopped being invisible the moment a socket and a retry timer were
 * holding the event loop. A server that does not return here is a server that outlives every
 * session that started it, one process per session, for as long as the machine is up.
 *
 * The rest of `serve` is covered where it is exercised: the tool pipeline in
 * `server.test.ts` and `test/integration/`, the `session.bye` in `main.test.ts`, since it is
 * `runServe` that owns the channel and therefore the goodbye.
 */
import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { readConfig } from '../../../src/config';
import { createLogger } from '../../../src/log';
import { NullChannel, serve } from '../../../src/mcp';
import { RunbookStore } from '../../../src/runbooks';

const VERSION = '0.1.0-test';

function deps(input: PassThrough, output: PassThrough, logs: string[]) {
  return {
    config: readConfig({ HANDOFF_AGENT: 'claude-code' }),
    version: VERSION,
    channel: NullChannel,
    runbooks: new RunbookStore(['/nowhere/handoff-runbooks'], { warn: (line) => logs.push(line) }),
    logger: createLogger('debug', (line) => logs.push(line)),
    stdio: { input, output },
  };
}

/** The `initialize` an MCP client sends first, plus the notification that follows it. */
function handshake(input: PassThrough): void {
  input.write(
    `${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'claude-code', version: '2.1.263' },
      },
    })}\n`,
  );
  input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
}

describe('serve', () => {
  it('returns 0 when the agent closes stdin, and says so in the log (§5.3)', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const logs: string[] = [];

    const serving = serve(deps(input, output, logs));
    handshake(input);
    await new Promise((resolve) => setTimeout(resolve, 20));
    input.end();

    await expect(serving).resolves.toBe(0);
    expect(logs.join('\n')).toContain('stdin_closed');
  });

  it('returns even when the agent never said initialize', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const serving = serve(deps(input, output, []));
    input.end();
    await expect(serving).resolves.toBe(0);
  });

  it('answers the handshake on the pipe it was given, and nothing else (§5.12)', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const written: string[] = [];
    output.on('data', (chunk: Buffer) => written.push(chunk.toString('utf8')));

    const serving = serve(deps(input, output, []));
    handshake(input);
    await new Promise((resolve) => setTimeout(resolve, 20));
    input.end();
    await serving;

    const lines = written.join('').trim().split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(() => JSON.parse(line) as unknown).not.toThrow();
      expect((JSON.parse(line) as { jsonrpc: string }).jsonrpc).toBe('2.0');
    }
  });
});

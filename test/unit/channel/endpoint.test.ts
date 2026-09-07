/**
 * The client over the real transport (TECHNICAL-DESIGN §5.8, §6.1, DD-26).
 *
 * Everything else about the client is tested against an in-memory duplex, which says nothing
 * about the two things only the operating system can answer: whether the endpoint this
 * machine derives is a name it will accept, and whether `net.connect` reaches a listener on
 * it. That is a named pipe on Windows and a Unix socket everywhere else, so this test is the
 * one place where the platform branch of `resolveEndpoint` is actually exercised — with a
 * `HANDOFF_HOME` of its own, so it can never meet the app the owner is running (§0.4 item 4).
 *
 * The scripted double with the golden sequences is T-019; this is a smoke of the transport.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ChannelClient,
  NdjsonDecoder,
  PROTOCOL_VERSION,
  encodeMessage,
  isRequest,
  success,
  type JsonRpcMessage,
} from '../../../src/channel';
import { createLogger } from '../../../src/log';
import { TokenFile, endpointTarget, resolveEndpoint } from '../../../src/platform';

const TOKEN = 'c0ffee11d0d0f00d1234567890abcdef00112233445566778899aabbccddeeff';

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** A listener that answers one `hello` and records what it was sent. */
function listen(target: string, received: JsonRpcMessage[]): Promise<Server> {
  const server = createServer((socket: Socket) => {
    const decoder = new NdjsonDecoder();
    socket.on('data', (chunk: Buffer) => {
      const outcome = decoder.push(chunk);
      if (!outcome.ok) return;
      for (const message of outcome.messages) {
        received.push(message);
        if (isRequest(message) && message.method === 'hello') {
          socket.write(
            encodeMessage(
              success(message.id, {
                app_version: '1.0.0',
                protocol_version: PROTOCOL_VERSION,
                session_ref: 'ses_4m7q2t9x',
              }),
            ),
          );
        }
      }
    });
    socket.on('error', () => {
      // The client destroying its side is not a test failure.
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(target, () => {
      resolve(server);
    });
  });
}

function waitFor(condition: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = (): void => {
      if (condition()) resolve();
      else if (Date.now() - started > 5_000) reject(new Error('timed out'));
      else setTimeout(tick, 5);
    };
    tick();
  });
}

describe('the endpoint this machine derives', () => {
  it('is a name the operating system accepts, and the client reaches a listener on it', async () => {
    // On POSIX the socket lives inside this folder and has to fit in a 104-byte `sun_path`;
    // the per-user temporary folder of macOS is long enough to make that a close call, and
    // `/tmp` is four characters on both POSIX platforms.
    const base = process.platform === 'win32' ? tmpdir() : '/tmp';
    const home = mkdtempSync(join(base, 'handoff-endpoint-'));
    cleanups.push(() => {
      rmSync(home, { recursive: true, force: true });
    });
    const env = { HANDOFF_HOME: home, USERDOMAIN: 'ACME', USERNAME: 'Giuse' };
    writeFileSync(join(home, 'channel.token'), `${TOKEN}\n`, 'utf8');

    const endpoint = resolveEndpoint({ env });
    expect(endpoint.kind).toBe(process.platform === 'win32' ? 'pipe' : 'unix');

    const received: JsonRpcMessage[] = [];
    const server = await listen(endpointTarget(endpoint), received);
    cleanups.push(() => {
      server.close();
    });

    const client = new ChannelClient({
      identity: {
        pid: process.pid,
        ppid: process.ppid,
        ancestors: [],
        cwd: process.cwd(),
        project_dir: process.cwd(),
      },
      agentId: 'unknown',
      client: { name: 'vitest', version: '5.0.0' },
      capabilityRow: {
        agent_id: 'unknown',
        display_name: 'Unknown agent',
        support: 'base',
        images_in_results: false,
        stop_hook: false,
        tool_timeout_ms: null,
      },
      serverVersion: '0.1.0',
      logger: createLogger('error', () => undefined),
      endpoint: () => resolveEndpoint({ env }),
      token: () => new TokenFile({ env }).read(),
    });
    cleanups.push(() => void client.close());

    client.start();
    await waitFor(() => client.isConnected());

    expect(client.sessionRef).toBe('ses_4m7q2t9x');
    const hello = received[0];
    expect(hello !== undefined && isRequest(hello) ? hello.method : '').toBe('hello');
    expect(hello !== undefined && isRequest(hello) ? hello.params['token'] : '').toBe(TOKEN);

    await client.close();
    await waitFor(() => received.length >= 2);
    const bye = received[1];
    expect(bye !== undefined && !isRequest(bye) && 'method' in bye ? bye.method : '').toBe(
      'session.bye',
    );
  });
});

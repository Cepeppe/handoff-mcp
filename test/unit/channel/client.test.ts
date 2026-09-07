/**
 * The channel client (TECHNICAL-DESIGN §5.3, §5.8, §6.2, §6.5, §6.6, FM-02, FM-10, FM-11).
 *
 * The transport is a pair of in-memory duplexes rather than a real socket: the schedules
 * this module has to get right are measured in tens of seconds, and the only way to assert
 * them honestly is with a fake clock. The real endpoint is exercised by `fake-app` (T-019)
 * over a real pipe, and the flows end to end by the integration suite (T-020); what is
 * pinned here is the lifecycle — who reconnects when, what is retried, what is given up.
 */
import { Duplex } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BACKOFF_SCHEDULE_MS,
  ChannelClient,
  ChannelError,
  ChannelResponseError,
  NdjsonDecoder,
  PING_INTERVAL_MS,
  PROTOCOL_MISMATCH_RETRY_MS,
  PROTOCOL_VERSION,
  REQUEST_TIMEOUT_MS,
  encodeMessage,
  isRequest,
  notification,
  success,
  type ChannelClientOptions,
  type JsonRpcMessage,
  type JsonRpcParams,
  type JsonRpcRequest,
} from '../../../src/channel';
import { createLogger } from '../../../src/log';
import type { ChannelPort } from '../../../src/mcp/port';
import type { Endpoint, TokenRead } from '../../../src/platform';

const TOKEN = 'c0ffee11d0d0f00d1234567890abcdef00112233445566778899aabbccddeeff';
const ENDPOINT: Endpoint = { kind: 'pipe', name: '\\\\.\\pipe\\handoff-8fb9ebc1757c4335' };

const IDENTITY = {
  pid: 48211,
  ppid: 48190,
  ancestors: [{ pid: 48190, name: 'node' }],
  cwd: '/Users/g/dev/shop',
  project_dir: '/Users/g/dev/shop',
};

const CAPABILITY_ROW = {
  agent_id: 'claude-code',
  display_name: 'Claude Code',
  support: 'full',
  images_in_results: true,
  stop_hook: true,
  tool_timeout_ms: 1_800_000,
} as const;

/** One half of an in-memory connection: what one side writes, the other side reads. */
class FakeSocket extends Duplex {
  peer: FakeSocket | undefined;

  constructor() {
    super({ allowHalfOpen: false });
  }

  override _read(): void {
    // Nothing to pull: the peer pushes.
  }

  override _write(chunk: Buffer, _encoding: string, done: (error?: Error) => void): void {
    this.peer?.push(chunk);
    done();
  }

  override _final(done: (error?: Error) => void): void {
    this.peer?.push(null);
    done();
  }
}

/** The app's side of one connection: what it received, and what it answers. */
interface FakeApp {
  readonly server: FakeSocket;
  readonly received: JsonRpcMessage[];
  send: (message: JsonRpcMessage) => void;
  sendRaw: (line: string) => void;
  /** The peer goes away without an error, as a quitting app does. */
  disconnect: () => void;
  /** The socket fails, as a broken pipe does. */
  fail: (cause: Error) => void;
}

function newApp(): FakeApp {
  const server = new FakeSocket();
  const app = new FakeSocket();
  server.peer = app;
  app.peer = server;

  const received: JsonRpcMessage[] = [];
  const decoder = new NdjsonDecoder();
  app.on('data', (chunk: Buffer) => {
    const outcome = decoder.push(chunk);
    if (outcome.ok) received.push(...outcome.messages);
  });
  app.on('error', () => {
    // The client destroying its side is not a test failure.
  });

  return {
    server,
    received,
    send: (message) => {
      app.write(encodeMessage(message));
    },
    sendRaw: (line) => {
      app.write(line);
    },
    disconnect: () => {
      server.push(null);
    },
    fail: (cause) => {
      server.destroy(cause);
    },
  };
}

/** Lets stream events and settled promises run; the fake clock does not drive them. */
function flush(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

interface Harness {
  readonly client: ChannelClient;
  readonly apps: FakeApp[];
  readonly endpoints: Endpoint[];
  readonly logs: string[];
  readonly events: string[];
  readonly app: () => FakeApp;
}

function harness(options: Partial<ChannelClientOptions> = {}): Harness {
  const apps: FakeApp[] = [];
  const endpoints: Endpoint[] = [];
  const logs: string[] = [];
  const events: string[] = [];

  const client = new ChannelClient({
    identity: IDENTITY,
    agentId: 'claude-code',
    client: { name: 'claude-code', version: '2.1.211' },
    capabilityRow: CAPABILITY_ROW,
    serverVersion: '1.0.3',
    logger: createLogger('debug', (line) => logs.push(line)),
    endpoint: () => ENDPOINT,
    token: (): TokenRead => ({ ok: true, token: TOKEN }),
    connect: (endpoint) => {
      endpoints.push(endpoint);
      const app = newApp();
      apps.push(app);
      return app.server;
    },
    ...options,
  });

  client.on('connected', () => events.push('connected'));
  client.on('disconnected', () => events.push('disconnected'));

  return {
    client,
    apps,
    endpoints,
    logs,
    events,
    app: () => {
      const last = apps.at(-1);
      if (last === undefined) throw new Error('no connection was attempted');
      return last;
    },
  };
}

function helloOf(app: FakeApp): JsonRpcRequest {
  const message = app.received[0];
  if (message === undefined || !isRequest(message)) throw new Error('hello was not sent');
  return message;
}

/** The result the app answers a good `hello` with. */
function helloResult(): JsonRpcParams {
  return { app_version: '1.0.0', protocol_version: PROTOCOL_VERSION, session_ref: 'ses_4m7q2t9x' };
}

/** Starts the client and completes the handshake, the state every later test begins from. */
async function registered(options: Partial<ChannelClientOptions> = {}): Promise<Harness> {
  const context = harness(options);
  context.client.start();
  await flush();
  context.app().send(success(helloOf(context.app()).id, helloResult()));
  await flush();
  return context;
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('registration', () => {
  it('connects and sends the identity payload of §5.8 as soon as it starts', async () => {
    const context = harness();
    context.client.start();
    await flush();

    expect(context.endpoints).toEqual([ENDPOINT]);
    expect(helloOf(context.app())).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'hello',
      params: {
        protocol_version: PROTOCOL_VERSION,
        token: TOKEN,
        role: 'server',
        server_version: '1.0.3',
        identity: IDENTITY,
        agent_id: 'claude-code',
        client: { name: 'claude-code', version: '2.1.211' },
        capability_row: CAPABILITY_ROW,
      },
    });
    expect(context.client.isConnected()).toBe(false);
  });

  it('is registered once the app answers, and reports what it was told', async () => {
    const context = await registered();
    expect(context.client.isConnected()).toBe(true);
    expect(context.client.sessionRef).toBe('ses_4m7q2t9x');
    expect(context.client.appVersion).toBe('1.0.0');
    expect(context.client.failure).toBeUndefined();
    expect(context.events).toEqual(['connected']);
  });

  it('satisfies the port the tool pipeline reads', async () => {
    const context = await registered();
    const port: ChannelPort = context.client;
    expect(port.isConnected()).toBe(true);
  });

  it('starts only once, however often start is called', async () => {
    const context = harness();
    context.client.start();
    context.client.start();
    await flush();
    expect(context.apps).toHaveLength(1);
  });
});

describe('when registration fails', () => {
  it('reports CHANNEL_AUTH_FAILED and keeps the ordinary backoff (FM-10)', async () => {
    const context = harness();
    context.client.start();
    await flush();
    context.app().send({
      jsonrpc: '2.0',
      id: helloOf(context.app()).id,
      error: { code: -32001, message: 'auth_failed' },
    });
    await flush();

    expect(context.client.isConnected()).toBe(false);
    expect(context.client.failure).toBe('CHANNEL_AUTH_FAILED');

    await vi.advanceTimersByTimeAsync(BACKOFF_SCHEDULE_MS[0] ?? 0);
    expect(context.apps).toHaveLength(2);
  });

  it('reports CHANNEL_AUTH_FAILED without connecting when the token is unusable', async () => {
    let token: TokenRead = { ok: false, problem: 'missing' };
    const context = harness({ token: () => token });
    context.client.start();
    await flush();

    expect(context.apps).toEqual([]);
    expect(context.client.failure).toBe('CHANNEL_AUTH_FAILED');

    token = { ok: true, token: TOKEN };
    await vi.advanceTimersByTimeAsync(BACKOFF_SCHEDULE_MS[0] ?? 0);
    await flush();
    expect(context.apps).toHaveLength(1);
    expect(helloOf(context.app()).params['token']).toBe(TOKEN);
  });

  it('slows to one attempt every five minutes on protocol_unsupported (§6.5, FM-11)', async () => {
    const context = harness();
    context.client.start();
    await flush();
    context.app().send({
      jsonrpc: '2.0',
      id: helloOf(context.app()).id,
      error: {
        code: -32002,
        message: 'protocol_unsupported',
        data: { protocol_version: PROTOCOL_VERSION },
      },
    });
    await flush();

    expect(context.client.failure).toBe('PROTOCOL_MISMATCH');
    await vi.advanceTimersByTimeAsync(PROTOCOL_MISMATCH_RETRY_MS - 1);
    expect(context.apps).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(context.apps).toHaveLength(2);
  });

  it('treats a hello answered with another version the same way', async () => {
    const context = harness();
    context.client.start();
    await flush();
    context.app().send(
      success(helloOf(context.app()).id, {
        app_version: '2.0.0',
        protocol_version: PROTOCOL_VERSION + 1,
        session_ref: 'ses_4m7q2t9x',
      }),
    );
    await flush();

    expect(context.client.failure).toBe('PROTOCOL_MISMATCH');
    expect(context.client.isConnected()).toBe(false);
  });

  it('retries after a hello nobody answers, once the 10 s request budget is spent', async () => {
    const context = harness();
    context.client.start();
    await flush();
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS - 1);
    expect(context.apps).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1 + (BACKOFF_SCHEDULE_MS[0] ?? 0));
    expect(context.apps).toHaveLength(2);
  });

  it('walks the backoff of §5.3 and then stays at thirty seconds, for ever', async () => {
    const context = harness({
      connect: () => {
        throw Object.assign(new Error('no app'), { code: 'ENOENT' });
      },
    });
    const attempts = (): number =>
      context.logs.filter((line) => line.includes('channel_connect_failed')).length;

    context.client.start();
    expect(attempts()).toBe(1);

    for (const delay of [1_000, 2_000, 5_000, 10_000, 30_000, 30_000, 30_000]) {
      const before = attempts();
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(attempts(), `no attempt before ${String(delay)} ms`).toBe(before);
      await vi.advanceTimersByTimeAsync(1);
      expect(attempts(), `one attempt at ${String(delay)} ms`).toBe(before + 1);
    }
  });

  it('starts the backoff again from one second after a registration that worked', async () => {
    const context = await registered();
    context.app().disconnect();
    await flush();

    expect(context.client.isConnected()).toBe(false);
    expect(context.events).toEqual(['connected', 'disconnected']);
    await vi.advanceTimersByTimeAsync(999);
    expect(context.apps).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(context.apps).toHaveLength(2);
  });
});

describe('requests', () => {
  it('carries a result back', async () => {
    const context = await registered();
    const answer = context.client.request('handoff.open', { call_id: 'call_2q7m8r1t' });
    await flush();

    const sent = context.app().received.at(-1);
    expect(sent !== undefined && isRequest(sent) ? sent.method : '').toBe('handoff.open');
    context.app().send(
      success(sent !== undefined && isRequest(sent) ? sent.id : 0, {
        handoff_id: 'hf_7k3m9p2q4r',
        resumed_from: null,
      }),
    );
    await expect(answer).resolves.toEqual({ handoff_id: 'hf_7k3m9p2q4r', resumed_from: null });
  });

  it('rejects with the app error, code and name, so the caller can map it', async () => {
    const context = await registered();
    const answer = context.client.request('handoff.continue', { handoff_id: 'hf_7k3m9p2q4r' });
    await flush();

    const sent = context.app().received.at(-1);
    context.app().send({
      jsonrpc: '2.0',
      id: sent !== undefined && isRequest(sent) ? sent.id : 0,
      error: { code: -32010, message: 'unknown_value_key', data: { keys: ['endpoint_url'] } },
    });

    await expect(answer).rejects.toBeInstanceOf(ChannelResponseError);
    await answer.catch((cause: unknown) => {
      expect(cause).toBeInstanceOf(ChannelResponseError);
      if (cause instanceof ChannelResponseError) {
        expect(cause.code).toBe(-32010);
        expect(cause.message).toBe('unknown_value_key');
        expect(cause.data).toEqual({ keys: ['endpoint_url'] });
      }
    });
  });

  it('gives up on a request the app never answers, after ten seconds (§6.6)', async () => {
    const context = await registered();
    const answer = context.client.request('handoff.resume', { handoff_id: 'hf_7k3m9p2q4r' });
    const settled = answer.catch((cause: unknown) => cause);

    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS - 1);
    await flush();
    await vi.advanceTimersByTimeAsync(1);

    const cause = await settled;
    expect(cause).toBeInstanceOf(ChannelError);
    expect(cause instanceof ChannelError ? cause.kind : '').toBe('timeout');
    expect(context.client.isConnected()).toBe(true);
  });

  it('says the app is unreachable rather than sending into a dead socket', async () => {
    const context = harness();
    context.client.start();
    await flush();

    const cause = await context.client.request('handoff.open', {}).catch((error: unknown) => error);
    expect(cause).toBeInstanceOf(ChannelError);
    expect(cause instanceof ChannelError ? cause.kind : '').toBe('unavailable');
    expect(context.client.notify('handoff.detach_call', {})).toBe(false);
  });

  it('rejects everything in flight when the connection is lost', async () => {
    const context = await registered();
    const answer = context.client.request('handoff.resume', {});
    const settled = answer.catch((cause: unknown) => cause);
    await flush();
    context.app().disconnect();
    await flush();

    const cause = await settled;
    expect(cause).toBeInstanceOf(ChannelError);
    expect(cause instanceof ChannelError ? cause.kind : '').toBe('closed');
  });
});

describe('what the app sends', () => {
  it('answers a ping with an empty result', async () => {
    const context = await registered();
    context.app().send({ jsonrpc: '2.0', id: 100, method: 'ping', params: {} });
    await flush();
    expect(context.app().received.at(-1)).toEqual(success(100, {}));
  });

  it('delivers handoff.event to the listener that waits for it', async () => {
    const context = await registered();
    const seen: unknown[] = [];
    context.client.on('handoff.event', (event) => seen.push(event));

    const params = {
      call_id: 'call_2q7m8r1t',
      handoff_id: 'hf_7k3m9p2q4r',
      outcome: { outcome_version: 1, status: 'verified', final: true },
    };
    context.app().send(notification('handoff.event', params));
    await flush();
    expect(seen).toEqual([params]);
  });

  it('ignores a handoff.event it cannot read, and keeps the connection', async () => {
    const context = await registered();
    const seen: unknown[] = [];
    context.client.on('handoff.event', (event) => seen.push(event));

    context.app().send(notification('handoff.event', { call_id: 7, handoff_id: null }));
    await flush();
    expect(seen).toEqual([]);
    expect(context.client.isConnected()).toBe(true);
  });

  it('marks the channel down and backs off on app.shutdown', async () => {
    const context = await registered();
    const reasons: string[] = [];
    context.client.on('app.shutdown', (params) => reasons.push(params.reason));

    context.app().send(notification('app.shutdown', { reason: 'the user quit the app' }));
    await flush();

    expect(reasons).toEqual(['the user quit the app']);
    expect(context.client.isConnected()).toBe(false);
    await vi.advanceTimersByTimeAsync(BACKOFF_SCHEDULE_MS[0] ?? 0);
    expect(context.apps).toHaveLength(2);
  });

  it('closes on a request it does not know, and reconnects', async () => {
    const context = await registered();
    context.app().send({ jsonrpc: '2.0', id: 5, method: 'app.please', params: {} });
    await flush();

    expect(context.client.isConnected()).toBe(false);
    expect(context.logs.some((line) => line.includes('channel_unknown_request'))).toBe(true);
    await vi.advanceTimersByTimeAsync(BACKOFF_SCHEDULE_MS[0] ?? 0);
    expect(context.apps).toHaveLength(2);
  });

  it('ignores a notification it does not know', async () => {
    const context = await registered();
    context.app().send(notification('app.whistles', {}));
    await flush();
    expect(context.client.isConnected()).toBe(true);
  });

  it('closes on a framing violation', async () => {
    const context = await registered();
    context.app().sendRaw('{ not json }\n');
    await flush();

    expect(context.client.isConnected()).toBe(false);
    expect(context.logs.some((line) => line.includes('channel_framing_violation'))).toBe(true);
  });

  it('survives a socket that fails outright', async () => {
    const context = await registered();
    context.app().fail(new Error('EPIPE'));
    await flush();

    expect(context.client.isConnected()).toBe(false);
    await vi.advanceTimersByTimeAsync(BACKOFF_SCHEDULE_MS[0] ?? 0);
    expect(context.apps).toHaveLength(2);
  });
});

describe('liveness', () => {
  it('pings after thirty seconds of silence and stays up when answered', async () => {
    const context = await registered();

    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS);
    await flush();
    const ping = context.app().received.at(-1);
    expect(ping !== undefined && isRequest(ping) ? ping.method : '').toBe('ping');

    context.app().send(success(ping !== undefined && isRequest(ping) ? ping.id : 0, {}));
    await flush();
    expect(context.client.isConnected()).toBe(true);
  });

  it('does not ping a connection that has been talking', async () => {
    const context = await registered();
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS - 1_000);
    context.app().send(notification('app.whistles', {}));
    await flush();

    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    const pings = context
      .app()
      .received.filter((message) => isRequest(message) && message.method === 'ping');
    expect(pings).toEqual([]);
  });

  it('gives up after two unanswered pings (§6.3)', async () => {
    const context = await registered();
    const first = context.app();

    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS + REQUEST_TIMEOUT_MS);
    await flush();
    expect(context.client.isConnected()).toBe(true);

    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS + REQUEST_TIMEOUT_MS);
    await flush();
    expect(context.client.isConnected()).toBe(false);
    expect(context.events).toEqual(['connected', 'disconnected']);
    expect(
      first.received.filter((message) => isRequest(message) && message.method === 'ping'),
    ).toHaveLength(2);
  });
});

describe('closing', () => {
  it('says session.bye and stops reconnecting (§5.3)', async () => {
    const context = await registered();
    await context.client.close();
    await flush();

    expect(context.app().received.at(-1)).toEqual(notification('session.bye', {}));
    expect(context.client.isConnected()).toBe(false);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(context.apps).toHaveLength(1);
  });

  it('says nothing when it never registered, and still stops', async () => {
    const context = harness();
    context.client.start();
    await flush();
    await context.client.close();

    expect(context.app().received.filter((message) => !isRequest(message))).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(context.apps).toHaveLength(1);
  });

  it('can be closed twice, and a start after a close does nothing', async () => {
    const context = await registered();
    await context.client.close();
    await context.client.close();
    context.client.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(context.apps).toHaveLength(1);
  });
});

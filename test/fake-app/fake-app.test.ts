/**
 * The self-test of the double (T-019 acceptance, §11.3).
 *
 * Three things are being checked, and they are not the same thing:
 *
 * 1. **The scenario files have not drifted from `fixtures/channel/`.** Loading one derives
 *    its actions from its golden and compares the `expect` and `send` lines the file writes
 *    down against that derivation, so a fixture edited under a scenario fails here rather
 *    than in T-020.
 * 2. **The double reproduces every golden sequence over a real socket.** A driver replays
 *    the `→` lines and the fake answers from its scenario; both halves are then compared
 *    against the fixture, modulo ids and timestamps. The `→` half is what T-020 will drive
 *    with the real server; the `←` half is what proves the DSL says what the app says.
 * 3. **The client of T-018 talks to it**: hello over the token file, a refused token, a
 *    version mismatch, a ping in each direction, `app.shutdown` and a dropped connection.
 *
 * The last test in the file plants a mutation and requires the golden comparison to fail.
 * A comparison that has never failed is a comparison nobody has checked.
 */
import { readdirSync } from 'node:fs';
import { connect, type Socket } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ChannelClient,
  NdjsonDecoder,
  encodeMessage,
  type JsonRpcMessage,
} from '../../src/channel';
import { createLogger } from '../../src/log';
import { TokenFile, endpointTarget } from '../../src/platform';

import { canonicalSequence, readGolden, type GoldenLine, type JsonObject } from './golden';
import { loadScenario, parseAction, parseScenario, scenarioNames, type Scenario } from './scenario';
import { FIXTURE_TOKEN, FakeApp, type FakeAppOptions } from './server';
import { GOLDEN_DIR } from './validate';

/** A token that is not the fixtures' one, for the refusal paths. */
const OTHER_TOKEN = '00112233445566778899aabbccddeeffc0ffee11d0d0f00d1234567890abcdef';

/** The registration the goldens that "begin after a successful registration" leave out. */
const REGISTRATION = readGolden('f01-register.jsonl')[0]?.msg ?? {};

/** Where the fake cannot decide the outcome on its own: the peer's token is the peer's. */
const DRIVER_OPTIONS: Record<string, FakeAppOptions> = {
  'auth-failed': { token: OTHER_TOKEN },
};

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A peer that writes exactly the lines it is given and records exactly what comes back. */
class Driver {
  readonly received: JsonRpcMessage[] = [];
  private readonly decoder = new NdjsonDecoder();
  private readonly socket: Socket;
  closed = false;

  private constructor(socket: Socket) {
    this.socket = socket;
    socket.on('data', (chunk: Buffer) => {
      const outcome = this.decoder.push(chunk);
      if (outcome.ok) this.received.push(...outcome.messages);
    });
    socket.on('error', () => {
      this.closed = true;
    });
    socket.on('close', () => {
      this.closed = true;
    });
  }

  static connect(app: FakeApp): Promise<Driver> {
    return new Promise((resolve, reject) => {
      const socket = connect(endpointTarget(app.endpoint));
      socket.once('error', reject);
      socket.once('connect', () => {
        resolve(new Driver(socket));
      });
    });
  }

  send(message: unknown): void {
    this.socket.write(encodeMessage(message as JsonRpcMessage));
  }

  /** A line exactly as given, for the framing cases a JSON encoder cannot produce. */
  sendRaw(line: string): void {
    this.socket.write(line + String.fromCharCode(10));
  }

  stop(): void {
    this.socket.destroy();
  }

  async until(count: number, what: string): Promise<void> {
    const started = Date.now();
    while (this.received.length < count) {
      if (this.closed && this.received.length < count) break;
      if (Date.now() - started > 5_000) throw new Error(`driver timed out waiting for ${what}`);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 5);
      });
    }
  }
}

async function startFake(scenario: Scenario, extra: FakeAppOptions = {}): Promise<FakeApp> {
  const app = await FakeApp.start({ scenario, ...extra });
  cleanups.push(() => app.stop());
  return app;
}

/**
 * Replays one golden file against the fake: every `→` line is written, and every `←` line
 * is waited for, so the two sides stay in step instead of racing.
 */
async function replay(app: FakeApp, lines: readonly GoldenLine[]): Promise<Driver> {
  const driver = await Driver.connect(app);
  cleanups.push(() => {
    driver.stop();
  });

  if (lines[0]?.msg['method'] !== 'hello') {
    driver.send(REGISTRATION);
    await driver.until(1, 'the hello answer');
    app.mark();
  }

  let incoming = driver.received.length;
  for (const line of lines) {
    if (line.dir === '→') {
      driver.send(line.msg);
      continue;
    }
    incoming += 1;
    await driver.until(incoming, `line ${String(line.n)} of the golden`);
  }
  return driver;
}

describe('the scenario files', () => {
  it('are one per golden sequence, and nothing else', () => {
    const goldens = readdirSync(GOLDEN_DIR)
      .filter((file) => file.endsWith('.jsonl'))
      .map((file) => file.slice(0, -'.jsonl'.length))
      .sort();
    // F-03 (runbook safety net) and F-09 (text mode) are the two flows of §9 that put
    // nothing on the channel: the server answers the agent itself, and in F-09 there is no
    // app to answer. `fixtures/channel/` has no file for them and neither has this folder.
    expect(scenarioNames()).toEqual(goldens);
  });

  it.each(scenarioNames())('%s loads, and its expect and send match its golden', (name) => {
    const scenario = loadScenario(name);
    expect(scenario.golden).toBeDefined();
    expect(scenario.why.length).toBeGreaterThan(20);
    expect(scenario.flow).toBeDefined();
    expect(scenario.expect.length + scenario.send.length).toBeGreaterThan(0);
  });

  it('refuses a scenario whose expect or send has drifted from the fixture', () => {
    const document = {
      scenario: 'f02-happy-path',
      why: 'a copy with a stale expect line',
      golden: 'f02-happy-path.jsonl',
      expect: ['handoff.open'],
    };
    expect(() => parseScenario(document, 'f02-happy-path')).toThrow(/"expect" is stale/u);
    expect(() =>
      parseScenario({ ...document, expect: undefined, send: ['onOpen'] }, 'f02-happy-path'),
    ).toThrow(/"send" is stale/u);
  });

  it('refuses an action that is not in the DSL, or one that is incomplete', () => {
    expect(() => parseAction({ onOpened: {} }, 'x')).toThrow(/not an action of the DSL/u);
    expect(() => parseAction({ onOpen: {}, emitEvent: {} }, 'x')).toThrow(/exactly one/u);
    expect(() => parseAction({ answerHookStop: { block: true } }, 'x')).toThrow(/"reason"/u);
    expect(() => parseAction({ onResume: { state: 'sleeping' } }, 'x')).toThrow(/"state"/u);
    expect(() => parseAction({ emitEvent: {} }, 'x')).toThrow(/"outcome"/u);
    expect(() => parseAction({ sendPing: {}, afterMs: -1 }, 'x')).toThrow(/"afterMs"/u);
  });
});

describe('the golden sequences, replayed over a real socket', () => {
  it.each(scenarioNames())('%s', async (name) => {
    const scenario = loadScenario(name);
    const golden = scenario.golden ?? '';
    const app = await startFake(scenario, DRIVER_OPTIONS[name] ?? {});
    await replay(app, readGolden(golden));
    await app.waitFor(
      () => app.expectations().length >= scenario.expect.length,
      5_000,
      'every line of the golden to arrive',
    );

    const sent = app.goldenAnswers();
    expect(sent.actual).toEqual(sent.expected);
    const got = app.goldenComparison();
    expect(got.actual).toEqual(got.expected);
    expect(app.expectations()).toEqual([...scenario.expect]);
    expect(app.violations).toEqual([]);
    expect(app.gaps).toEqual([]);
    expect(app.remaining()).toEqual([]);
  });

  it('gives the handoff the id of the request it answers (DD-13)', async () => {
    const app = await startFake(loadScenario('f07-user-request'));
    const driver = await replay(app, readGolden('f07-user-request.jsonl'));
    const open = readGolden('f07-user-request.jsonl')[0]?.msg ?? {};
    const requestId = (open['params'] as JsonObject)['request_id'];
    // The golden begins after a registration, so the replay sent one: the open is second.
    const answer = driver.received[1] as unknown as JsonObject;
    expect((answer['result'] as JsonObject)['handoff_id']).toBe(requestId);
  });

  it('serves a hook without registering a session (§6.2)', async () => {
    const app = await startFake(loadScenario('f10-hook-block'));
    const driver = await replay(app, readGolden('f10-hook-block.jsonl'));
    expect(app.sessions).toEqual([]);
    const hello = driver.received[0] as unknown as JsonObject;
    expect((hello['result'] as JsonObject)['session_ref']).toBeNull();
    await app.waitFor(() => driver.closed, 5_000, 'the hook connection to close');
  });
});

describe('the channel client of T-018 against the fake', () => {
  const identity = {
    pid: process.pid,
    ppid: process.ppid,
    ancestors: [],
    cwd: process.cwd(),
    project_dir: process.cwd(),
  };

  const capabilityRow = {
    agent_id: 'claude-code',
    display_name: 'Claude Code',
    support: 'full',
    images_in_results: true,
    stop_hook: true,
    tool_timeout_ms: 1_800_000,
  } as const;

  function client(app: FakeApp, token?: string): ChannelClient {
    const instance = new ChannelClient({
      identity,
      agentId: 'claude-code',
      client: { name: 'claude-code', version: '2.1.211' },
      capabilityRow,
      serverVersion: '1.0.3',
      logger: createLogger('error', () => undefined),
      endpoint: () => app.endpoint,
      // No token given means the token file, which is the path the real server takes.
      token:
        token === undefined
          ? () => new TokenFile({ env: app.env }).read()
          : () => ({ ok: true, token }),
      backoff: [5, 5, 5],
    });
    cleanups.push(() => instance.close());
    return instance;
  }

  it('registers over the token file, and its hello is the hello of the golden', async () => {
    const scenario = loadScenario('f01-register');
    const app = await startFake(scenario);
    const peer = client(app);
    peer.start();
    await app.waitFor(() => peer.isConnected(), 5_000, 'a registration');

    expect(peer.sessionRef).toBe(app.sessions[0]);
    expect(peer.appVersion).toBe('1.0.0');
    // The identity, the versions and the capability row belong to whichever peer is
    // driving; the scenario says so in its `ignore` list and everything else is compared.
    const helloLine = readGolden('f01-register.jsonl')[0];
    expect(canonicalSequence(app.received().slice(0, 1), scenario.ignore)).toEqual(
      canonicalSequence([helloLine?.msg ?? {}], scenario.ignore),
    );
  });

  it('reports CHANNEL_AUTH_FAILED when the app refuses the token', async () => {
    const app = await startFake(loadScenario('auth-failed'));
    const peer = client(app, OTHER_TOKEN);
    peer.start();
    await app.waitFor(() => peer.failure === 'CHANNEL_AUTH_FAILED', 5_000, 'the refusal');
    expect(peer.isConnected()).toBe(false);
    expect(app.violations).toEqual([]);
  });

  it('reports PROTOCOL_MISMATCH when the app answers protocol_unsupported', async () => {
    const app = await startFake(loadScenario('protocol-mismatch'), {
      refuse: 'protocol_unsupported',
    });
    const peer = client(app);
    peer.start();
    await app.waitFor(() => peer.failure === 'PROTOCOL_MISMATCH', 5_000, 'the refusal');
    expect(peer.isConnected()).toBe(false);
  });

  it('answers the app ping, and the app answers its own', async () => {
    const scenario = parseScenario(
      {
        scenario: 'ping',
        why: 'the app pings a registered connection and the peer answers',
        actions: [{ sendPing: {} }],
      },
      'ping',
    );
    const app = await startFake(scenario);
    const peer = client(app);
    peer.start();
    await app.waitFor(() => peer.isConnected(), 5_000, 'a registration');
    await app.waitFor(() => app.expectations().includes('(result)'), 5_000, 'the pong');

    // And the other direction: a raw ping is answered with an empty result.
    const driver = await Driver.connect(app);
    cleanups.push(() => {
      driver.stop();
    });
    driver.send(REGISTRATION);
    driver.send({ jsonrpc: '2.0', id: 9, method: 'ping', params: {} });
    await driver.until(2, 'the ping answer');
    expect(driver.received[1]).toEqual({ jsonrpc: '2.0', id: 9, result: {} });
    expect(app.violations).toEqual([]);
  });

  it('marks the channel down on app.shutdown', async () => {
    const scenario = parseScenario(
      {
        scenario: 'shutdown',
        why: 'the user quits the app from the tray menu while a session is registered',
        actions: [{ sendAppShutdown: { reason: 'the user quit the app' } }],
      },
      'shutdown',
    );
    const app = await startFake(scenario);
    const peer = client(app);
    const reasons: string[] = [];
    peer.on('app.shutdown', (payload) => {
      reasons.push(payload.reason);
    });
    peer.start();
    await app.waitFor(() => reasons.length === 1, 5_000, 'the shutdown notification');
    expect(reasons).toEqual(['the user quit the app']);
  });

  it('reconnects after dropConnection, and registers a second session', async () => {
    const scenario = parseScenario(
      {
        scenario: 'drop',
        why: 'the app dies under a registered connection and the server retries (§5.3)',
        actions: [{ dropConnection: {}, afterMs: 10 }],
      },
      'drop',
    );
    const app = await startFake(scenario);
    const peer = client(app);
    peer.start();
    await app.waitFor(() => app.sessions.length >= 2, 5_000, 'a second registration');
    expect(peer.isConnected()).toBe(true);
    expect(app.sessions[0]).not.toBe(app.sessions[1]);
  });

  it('delays its hello answer by delayHello, and the peer still registers', async () => {
    const scenario = parseScenario(
      {
        scenario: 'slow-hello',
        why: 'the app takes its time to answer hello; the peer waits inside its 10 s budget',
        actions: [{ delayHello: { ms: 80 } }],
      },
      'slow-hello',
    );
    const app = await startFake(scenario);
    const peer = client(app);
    const started = Date.now();
    peer.start();
    await app.waitFor(() => peer.isConnected(), 5_000, 'a registration');
    expect(Date.now() - started).toBeGreaterThanOrEqual(75);
  });
});

describe('what the fake refuses', () => {
  it('closes a connection that does not say hello in time (§6.2)', async () => {
    const app = await startFake(loadScenario('f01-register'), { helloTimeoutMs: 40 });
    const driver = await Driver.connect(app);
    cleanups.push(() => {
      driver.stop();
    });
    await app.waitFor(() => driver.closed, 5_000, 'the connection to be closed');
    expect(app.violations[0]?.reason).toMatch(/no hello within 40 ms/u);
  });

  it('closes a connection whose first message is not a hello', async () => {
    const app = await startFake(loadScenario('f01-register'));
    const driver = await Driver.connect(app);
    cleanups.push(() => {
      driver.stop();
    });
    driver.send({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} });
    await app.waitFor(() => driver.closed, 5_000, 'the connection to be closed');
    expect(app.violations[0]?.reason).toMatch(/first message must be hello/u);
  });

  it('closes a connection on a message the schema rejects, and keeps no token', async () => {
    const app = await startFake(loadScenario('f01-register'));
    const driver = await Driver.connect(app);
    cleanups.push(() => {
      driver.stop();
    });
    driver.send({
      ...REGISTRATION,
      params: { ...(REGISTRATION['params'] as JsonObject), extra: 1 },
    });
    await app.waitFor(() => driver.closed, 5_000, 'the connection to be closed');
    expect(app.violations).toHaveLength(1);
    expect(JSON.stringify(app.violations[0]?.message)).not.toContain(FIXTURE_TOKEN);
  });

  it('closes a connection on a line that is not JSON', async () => {
    const app = await startFake(loadScenario('f01-register'));
    const driver = await Driver.connect(app);
    cleanups.push(() => {
      driver.stop();
    });
    driver.send(REGISTRATION);
    await driver.until(1, 'the hello answer');
    driver.sendRaw('{ not json');
    await app.waitFor(() => driver.closed, 5_000, 'the connection to be closed');
    expect(app.violations.map((violation) => violation.reason)).toEqual(['invalid_json']);
  });
});

describe('the golden comparison itself', () => {
  it('fails when the peer sends something the golden does not say', async () => {
    const scenario = loadScenario('f02-happy-path');
    const app = await startFake(scenario);
    const lines = readGolden('f02-happy-path.jsonl').map((line) => {
      if (line.msg['method'] !== 'handoff.verify') return line;
      const params = line.msg['params'] as JsonObject;
      const verify = params['verify'] as JsonObject;
      // One character of one field: exactly the kind of drift the comparison exists for.
      return {
        ...line,
        msg: { ...line.msg, params: { ...params, verify: { ...verify, ok: false } } },
      };
    });
    await replay(app, lines);

    const got = app.goldenComparison();
    expect(got.actual).not.toEqual(got.expected);
  });
});

/**
 * The harness the integration tests of T-020 drive (TECHNICAL-DESIGN §11.3, §9).
 *
 * One `session()` is the whole system minus the two ends: the real MCP server of
 * `src/mcp/server.ts` speaking to an SDK `Client` over the in-memory transport, and the real
 * `ChannelClient` of `src/channel/client.ts` speaking to `test/fake-app` over a real named
 * pipe on Windows and a real Unix socket elsewhere. Nothing between the tool call and the
 * socket is a double: the pipeline, the in-flight table, the framing and the endpoint are
 * the product's.
 *
 * `tools/list` is done before the session is handed back, because that is what makes the SDK
 * client compile the declared `outputSchema` and validate the `structuredContent` of every
 * answer against it (the T-017 note). Without it, an outcome the server mangled comes back
 * green.
 *
 * Registration is awaited **on both sides at once**: the fake counts a session when it writes
 * the `hello` answer and the client when it has read it, and waiting on one of the two is the
 * race that failed on the CI ubuntu runner in T-019.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { expect } from 'vitest';

import { capabilityRowForHello, resolveCapabilityRow } from '../../src/adapters';
import { ChannelClient } from '../../src/channel';
import { readConfig } from '../../src/config';
import type { HandoffErrorPayload } from '../../src/format';
import { createLogger } from '../../src/log';
import { createServer, NullChannel, type ChannelPort } from '../../src/mcp';
import type { Outcome } from '../../src/mcp';
import { TokenFile, type TokenRead } from '../../src/platform';
import { RunbookStore } from '../../src/runbooks';
import { FakeApp, type FakeAppOptions } from '../fake-app';
import { readGolden } from '../fake-app';

const VERSION = '0.1.0-test';

/** The tool timeout the sessions declare: Claude Code's, so the row is the `full` one. */
const TOOL_TIMEOUT_MS = 1_800_000;

export interface SessionOptions extends FakeAppOptions {
  /** Runs with no listener at all, for the two flows that put nothing on the channel. */
  readonly withoutApp?: boolean;
  /** The heartbeat, in milliseconds: a few hundred instead of the fifty seconds of §5.6. */
  readonly heartbeatAfterMs?: number;
  /** Where the runbook safety net looks. A folder that does not exist means no match. */
  readonly runbookRoot?: string;
  /** A token the peer sends instead of the one the fake wrote, for the refusal of FM-10. */
  readonly peerToken?: string;
  /** `HANDOFF_AGENT`. An id the table does not know resolves to the `unknown` row (§5.6). */
  readonly agent?: string;
}

export interface Session {
  readonly client: Client;
  /** Undefined with `withoutApp`. */
  readonly app: FakeApp | undefined;
  readonly channel: ChannelPort;
  readonly logs: string[];
  /** Everything the logger and the runbook reader wrote, as one string. */
  logText(): string;
  /** The `session.bye` of §5.3 and nothing else, for a flow whose golden ends with it. */
  sayGoodbye(): Promise<void>;
  /** Tears the whole session down. Safe to call twice. */
  close(): Promise<void>;
}

/**
 * A connected agent, server, channel and app.
 *
 * The capability row is Claude Code's `full` row, resolved through the real table, so the
 * instruction variants and the image gating are the ones a real session gets.
 */
export async function session(options: SessionOptions = {}): Promise<Session> {
  const logs: string[] = [];
  const logger = createLogger('debug', (line) => logs.push(line));
  const app = options.withoutApp ? undefined : await FakeApp.start(options);

  const env = app === undefined ? {} : app.env;
  const agent = options.agent ?? 'claude-code';
  const config = readConfig({
    HANDOFF_AGENT: agent,
    HANDOFF_TOOL_TIMEOUT_MS: String(TOOL_TIMEOUT_MS),
    ...(app === undefined ? {} : { HANDOFF_HOME: app.home }),
  });
  const row = resolveCapabilityRow({ agent });

  let channel: ChannelPort = NullChannel;
  if (app !== undefined) {
    const peer = new ChannelClient({
      identity: {
        pid: 4321,
        ppid: 4320,
        ancestors: [],
        cwd: '/dev/shop',
        project_dir: '/dev/shop',
      },
      agentId: row.agent_id,
      client: { name: 'claude-code', version: '2.1.263' },
      capabilityRow: capabilityRowForHello(row, TOOL_TIMEOUT_MS),
      serverVersion: '1.0.3',
      logger,
      endpoint: () => app.endpoint,
      token:
        options.peerToken === undefined
          ? (): TokenRead => new TokenFile({ env }).read()
          : (): TokenRead => ({ ok: true, token: options.peerToken ?? '' }),
      backoff: [5, 5, 5],
    });
    channel = peer;
    peer.start();
  }

  const server = createServer({
    config,
    version: VERSION,
    channel,
    runbooks: new RunbookStore([options.runbookRoot ?? '/nowhere/handoff-runbooks'], {
      warn: (line) => logs.push(line),
    }),
    logger,
    ...(options.heartbeatAfterMs === undefined
      ? {}
      : { heartbeatAfterMs: options.heartbeatAfterMs }),
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'claude-code', version: '2.1.263' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  await client.listTools();

  const live = channel;
  let closed = false;
  return {
    client,
    app,
    channel: live,
    logs,
    logText: () => logs.join('\n'),
    sayGoodbye: async () => {
      if (live !== NullChannel) await (live as ChannelClient).close();
    },
    close: async () => {
      // Guarded: a test that closed early to observe what closing does still gets torn down
      // by `afterEach`, and closing twice must not be an error the suite has to work around.
      if (closed) return;
      closed = true;
      if (live !== NullChannel) await (live as ChannelClient).close();
      await client.close();
      await server.close();
      await app?.stop();
    },
  };
}

/**
 * Waits until the peer is registered and the fake has counted it. Both halves in one
 * condition: the two sides become ready at different instants and asserting on one of them
 * is the race T-019's own suite hit on CI.
 */
export async function registered(active: Session, sessions = 1): Promise<void> {
  const app = active.app;
  if (app === undefined) throw new Error('this session has no app to register with');
  await app.waitFor(
    () => app.sessions.length >= sessions && active.channel.isConnected(),
    5_000,
    'a registration on both sides',
  );
}

/** One `handoff_to_user` call, with the raw result so an error can be inspected too. */
export function callTool(
  active: Session,
  name: string,
  args: Record<string, unknown>,
  options: { signal?: AbortSignal } = {},
): Promise<CallToolResult> {
  return active.client.callTool(
    { name, arguments: args },
    undefined,
    options.signal === undefined ? {} : { signal: options.signal },
  ) as Promise<CallToolResult>;
}

/** The outcome an answer carries, asserted to be a result rather than an error. */
export function outcomeOf(result: CallToolResult): Outcome {
  expect(result.isError, JSON.stringify(result.content)).toBe(false);
  const outcome = JSON.parse((result.content[0] as { text: string }).text) as Outcome;
  expect(result.structuredContent).toEqual(outcome);
  return outcome;
}

/** The catalogue error an answer carries, asserted to be an error rather than a result. */
export function errorOf(result: CallToolResult): HandoffErrorPayload['error'] {
  expect(result.isError, JSON.stringify(result.content)).toBe(true);
  const payload = JSON.parse((result.content[0] as { text: string }).text) as HandoffErrorPayload;
  return payload.error;
}

/** The handoff id a golden's app assigns, so a test drives the flow with the fixture's id. */
export function goldenHandoffId(file: string): string {
  for (const line of readGolden(file)) {
    const params = line.msg['params'];
    if (typeof params === 'object' && params !== null) {
      const id = (params as Record<string, unknown>)['handoff_id'];
      if (typeof id === 'string') return id;
    }
    const result = line.msg['result'];
    if (typeof result === 'object' && result !== null) {
      const id = (result as Record<string, unknown>)['handoff_id'];
      if (typeof id === 'string') return id;
    }
  }
  throw new Error(`${file} names no handoff`);
}

/** The `spec` every golden opens, read from the published fixture rather than the golden. */
export { default as STRIPE_SPEC } from '../../fixtures/specs/valid/stripe-webhook.json';

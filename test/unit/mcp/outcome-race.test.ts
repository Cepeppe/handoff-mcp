/**
 * The outcome that arrives in the same breath as the answer (TECHNICAL-DESIGN §5.7, §6.1).
 *
 * The app answers `handoff.open` and pushes `handoff.event` immediately after — F-02 does
 * exactly that, and so does every flow that ends on the first event. Both lines are written
 * in one tick, a **local socket hands them to the reader in one chunk**, the codec yields two
 * messages and the client dispatches them in one synchronous loop. Resolving the promise of
 * the answer only *queues* the code awaiting it, so the notification is delivered first, and
 * a pipeline that registered its call after awaiting the answer registers it one microtask
 * too late: the outcome is dropped as an event for a call nobody is waiting on, and the call
 * blocks until the agent's timeout.
 *
 * This is not hypothetical and it is not a test artifact. It passed on Windows, where a named
 * pipe delivered the two writes as two reads, and every flow of `test/integration/` that waits
 * for an event failed on the Linux CI runner, where a Unix socket coalesced them.
 *
 * So the channel here is a stub whose answer is **always** followed by the event, in the same
 * tick, before the caller's `await` can resume. It reproduces the coalescing on every
 * platform, deterministically, without a socket.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';

import type { ChannelEvents, ChannelListener, JsonRpcParams } from '../../../src/channel';
import { readConfig } from '../../../src/config';
import { createLogger } from '../../../src/log';
import { createServer, type ChannelPort, type Outcome } from '../../../src/mcp';
import { RunbookStore } from '../../../src/runbooks';

import specFixture from '../../../fixtures/specs/valid/stripe-webhook.json';

const HANDOFF = 'hf_7k3m9p2q4r';

/** Every field of §4.3, so what comes back validates against the declared output schema. */
function outcome(status: string): Record<string, unknown> {
  return {
    outcome_version: 1,
    handoff_id: HANDOFF,
    status,
    final: false,
    instruction: 'replaced by the server from the contract',
    round: 1,
    current_step: null,
    user_text: null,
    screenshot: null,
    context: null,
    skipped_steps: [],
    notes: [],
    secret_treated: [],
    verify: null,
    deferral_count: 0,
    resumed_from: null,
    app_reachable: true,
    already_delivered: false,
    runbooks: [],
    spec_text: null,
  };
}

/**
 * An app that answers and pushes the outcome without yielding: the emission happens while
 * `request()` is still on the stack, which is where the answer's `await` has not begun.
 */
class CoalescingChannel implements ChannelPort {
  readonly failure = undefined;
  private readonly listeners = new Set<(payload: ChannelEvents['handoff.event']) => void>();

  isConnected(): boolean {
    return true;
  }

  request(method: string, params: JsonRpcParams = {}): Promise<JsonRpcParams> {
    const answer: JsonRpcParams =
      method === 'handoff.open'
        ? { handoff_id: HANDOFF, resumed_from: null }
        : method === 'handoff.resume'
          ? { state: 'active', outcome: null }
          : { ok: true };

    const callId = String(params['call_id']);
    for (const listener of this.listeners) {
      listener({ call_id: callId, handoff_id: HANDOFF, outcome: outcome('awaiting_verification') });
    }
    return Promise.resolve(answer);
  }

  notify(): boolean {
    return true;
  }

  on<K extends keyof ChannelEvents>(event: K, listener: ChannelListener<K>): () => void {
    if (event !== 'handoff.event') return () => undefined;
    const typed = listener as (payload: ChannelEvents['handoff.event']) => void;
    this.listeners.add(typed);
    return () => this.listeners.delete(typed);
  }
}

const sessions: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of sessions.splice(0)) await close();
});

async function connected(): Promise<Client> {
  const server = createServer({
    config: readConfig({ HANDOFF_AGENT: 'claude-code', HANDOFF_TOOL_TIMEOUT_MS: '1800000' }),
    version: '0.1.0-test',
    channel: new CoalescingChannel(),
    runbooks: new RunbookStore(['/nowhere/handoff-runbooks'], { warn: () => undefined }),
    logger: createLogger('error', () => undefined),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'claude-code', version: '2.1.263' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  await client.listTools();
  sessions.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

function outcomeOf(result: CallToolResult): Outcome {
  expect(result.isError, JSON.stringify(result.content)).toBe(false);
  return JSON.parse((result.content[0] as { text: string }).text) as Outcome;
}

describe('an outcome that arrives with the answer, not after it', () => {
  it('reaches the open that is still waiting for the app to answer', async () => {
    const client = await connected();
    const result = (await client.callTool({
      name: 'handoff_to_user',
      arguments: { spec: specFixture },
    })) as CallToolResult;

    expect(outcomeOf(result).status).toBe('awaiting_verification');
    expect(outcomeOf(result).handoff_id).toBe(HANDOFF);
  });

  it('reaches a continue the same way', async () => {
    const client = await connected();
    const result = (await client.callTool({
      name: 'handoff_to_user',
      arguments: { handoff_id: HANDOFF, reply: 'the answer to the question' },
    })) as CallToolResult;

    expect(outcomeOf(result).status).toBe('awaiting_verification');
  });

  it('reaches a resume whose snapshot said the call should attach', async () => {
    const client = await connected();
    const result = (await client.callTool({
      name: 'handoff_to_user',
      arguments: { resume: HANDOFF },
    })) as CallToolResult;

    expect(outcomeOf(result).status).toBe('awaiting_verification');
  });
});

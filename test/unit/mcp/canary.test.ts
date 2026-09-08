/**
 * The canary probe (T-023, TECHNICAL-DESIGN §11.5, Appendix B A-03, A-04, A-09).
 *
 * Two properties matter more than the rest and are asserted first: the probe does not
 * exist unless `HANDOFF_CANARY=1`, and nothing it writes carries the value of an
 * environment variable. Everything else here is the arithmetic the harness reads back.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, describe, expect, it } from 'vitest';

import {
  createCanaryProbe,
  sleepUntilAborted,
  CANARY_DIR_NAME,
  CANARY_MAX_SLEEP_MS,
  CANARY_OBSERVATIONS_FILE,
  CANARY_PROBE_ENV_NAMES,
  CANARY_TOOL_NAME,
  type CanaryObservation,
} from '../../../src/mcp';
import { ENV_VAR_NAMES, readConfig } from '../../../src/config';
import { createLogger } from '../../../src/log';
import { TOOL_NAMES } from '../../../src/mcp/generated/contract';
import { NullChannel } from '../../../src/mcp/port';
import { createServer } from '../../../src/mcp/server';
import { RunbookStore } from '../../../src/runbooks';

const roots: string[] = [];

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'handoff-canary-'));
  roots.push(dir);
  return dir;
}

function observations(file: string): CanaryObservation[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as CanaryObservation);
}

afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

describe('the switch', () => {
  it('gives no probe at all when it is off', () => {
    expect(createCanaryProbe({ enabled: false, home: home() })).toBeUndefined();
  });

  it('writes nothing to the folder while it is off', () => {
    const root = home();
    expect(createCanaryProbe({ enabled: false, home: root })).toBeUndefined();
    expect(existsSync(join(root, CANARY_DIR_NAME))).toBe(false);
  });
});

describe('the observation file', () => {
  it('is one NDJSON line per record, under HANDOFF_HOME', () => {
    const root = home();
    const probe = createCanaryProbe({ enabled: true, home: root });
    expect(probe).toBeDefined();
    expect(probe?.file).toBe(join(root, CANARY_DIR_NAME, CANARY_OBSERVATIONS_FILE));

    probe?.record('initialize', { agent_id: 'claude-code' });
    probe?.record('tool_call', { method: 'handoff_to_user' });

    const lines = observations(probe?.file ?? '');
    expect(lines).toHaveLength(2);
    expect(lines[0]?.event).toBe('initialize');
    expect(lines[0]?.['agent_id']).toBe('claude-code');
    expect(lines[1]?.event).toBe('tool_call');
    expect(typeof lines[0]?.at).toBe('string');
  });

  it('takes its instant from the injected clock, so a test can pin it', () => {
    const probe = createCanaryProbe({
      enabled: true,
      home: home(),
      now: () => new Date('2026-09-08T09:00:00.000Z'),
    });
    probe?.record('initialize');
    expect(observations(probe?.file ?? '')[0]?.at).toBe('2026-09-08T09:00:00.000Z');
  });

  it('never throws when the folder cannot be written', () => {
    // A file where the `canary/` directory would go: `mkdirSync` fails with EEXIST, and
    // the probe swallows it rather than taking the session down with it.
    const root = home();
    writeFileSync(join(root, CANARY_DIR_NAME), 'not a directory', 'utf8');
    const probe = createCanaryProbe({ enabled: true, home: root });
    expect(() => {
      probe?.record('initialize');
    }).not.toThrow();
    expect(existsSync(probe?.file ?? '')).toBe(false);
  });
});

describe('the names the probe asks about (A-02, A-23, A-24)', () => {
  it('include the pair whose whole point is that one of them is stripped', () => {
    expect(CANARY_PROBE_ENV_NAMES).toContain('HANDOFF_PROBE');
    expect(CANARY_PROBE_ENV_NAMES).toContain('HANDOFF_PROBE_TOKEN');
  });

  it('keep the probe-only pair out of the declared list, which must stay A-23 clean', () => {
    expect(ENV_VAR_NAMES as readonly string[]).not.toContain('HANDOFF_PROBE');
    expect(ENV_VAR_NAMES as readonly string[]).not.toContain('HANDOFF_PROBE_TOKEN');
  });
});

describe('the sleep_ms tool', () => {
  it('is the only tool the probe adds, and it is the name §11.5 asks for', () => {
    const probe = createCanaryProbe({ enabled: true, home: home() });
    const tools = probe?.tools() ?? [];
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe(CANARY_TOOL_NAME);
    expect(probe?.handles(CANARY_TOOL_NAME)).toBe(true);
    expect(probe?.handles('handoff_to_user')).toBe(false);
  });

  it('records the start and the end of a call that was allowed to finish', async () => {
    const probe = createCanaryProbe({ enabled: true, home: home() });
    const result = await probe?.call(CANARY_TOOL_NAME, { ms: 5 }, new AbortController().signal);
    expect(result?.isError).toBeUndefined();

    const lines = observations(probe?.file ?? '');
    expect(lines.map((line) => line.event)).toEqual(['sleep_start', 'sleep_end']);
    expect(lines[1]?.['outcome']).toBe('completed');
    expect(lines[1]?.['requested_ms']).toBe(5);
  });

  it('records an aborted call, which is what A-03, A-04 and A-09 read', async () => {
    const probe = createCanaryProbe({ enabled: true, home: home() });
    const controller = new AbortController();
    const call = probe?.call(CANARY_TOOL_NAME, { ms: CANARY_MAX_SLEEP_MS }, controller.signal);
    controller.abort();
    await call;

    const lines = observations(probe?.file ?? '');
    expect(lines[1]?.event).toBe('sleep_end');
    expect(lines[1]?.['outcome']).toBe('aborted');
    expect(lines[1]?.['waited_ms']).toBeTypeOf('number');
  });

  it('refuses an input the schema does not allow, without sleeping', async () => {
    const probe = createCanaryProbe({ enabled: true, home: home() });
    for (const args of [{}, { ms: -1 }, { ms: 1.5 }, { ms: CANARY_MAX_SLEEP_MS + 1 }, null]) {
      const result = await probe?.call(CANARY_TOOL_NAME, args, new AbortController().signal);
      expect(result?.isError, JSON.stringify(args)).toBe(true);
    }
    expect(observations(probe?.file ?? '').every((line) => line.event === 'sleep_rejected')).toBe(
      true,
    );
  });

  it('refuses a name it does not own', async () => {
    const probe = createCanaryProbe({ enabled: true, home: home() });
    const result = await probe?.call('handoff_to_user', { ms: 1 }, new AbortController().signal);
    expect(result?.isError).toBe(true);
  });
});

describe('sleepUntilAborted', () => {
  it('reports completed with the elapsed time from the injected clock', async () => {
    let clock = 1000;
    const result = await sleepUntilAborted(1, new AbortController().signal, () => {
      const value = clock;
      clock += 40;
      return value;
    });
    expect(result.outcome).toBe('completed');
    expect(result.waited_ms).toBe(40);
  });

  it('reports aborted at once when the signal is already aborted', async () => {
    const result = await sleepUntilAborted(CANARY_MAX_SLEEP_MS, AbortSignal.abort());
    expect(result.outcome).toBe('aborted');
  });
});

describe('the server with the probe on', () => {
  /** A connected client and server, with `tools/list` already done, over an isolated home. */
  async function connect(env: Record<string, string>) {
    const root = home();
    const server = createServer({
      config: readConfig({ ...env, HANDOFF_HOME: root }, root),
      version: '0.1.0-test',
      channel: NullChannel,
      runbooks: new RunbookStore([join(root, 'absent')], { warn: () => undefined }),
      logger: createLogger('error', () => undefined),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'handoff-mcp-canary-test', version: '1' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const { tools } = await client.listTools();
    const file = join(root, CANARY_DIR_NAME, CANARY_OBSERVATIONS_FILE);
    return {
      client,
      tools,
      file,
      close: async () => {
        await client.close();
        await server.close();
      },
    };
  }

  it('registers the three contract tools and nothing else while it is off', async () => {
    const session = await connect({});
    try {
      expect(session.tools.map((tool) => tool.name)).toEqual([...TOOL_NAMES]);
      expect(existsSync(session.file)).toBe(false);
    } finally {
      await session.close();
    }
  });

  it('adds sleep_ms after the three, and records the handshake and the calls', async () => {
    const session = await connect({ HANDOFF_CANARY: '1', HANDOFF_AGENT: 'claude-code' });
    try {
      expect(session.tools.map((tool) => tool.name)).toEqual([...TOOL_NAMES, CANARY_TOOL_NAME]);
      await session.client.callTool({ name: CANARY_TOOL_NAME, arguments: { ms: 1 } });

      const events = observations(session.file).map((line) => line.event);
      expect(events).toContain('initialize');
      expect(events).toContain('tools_list');
      expect(events).toContain('sleep_start');
      expect(events).toContain('sleep_end');

      const handshake = observations(session.file).find((line) => line.event === 'initialize');
      expect(handshake?.['client_name']).toBe('handoff-mcp-canary-test');
      expect(handshake?.['agent_id']).toBe('claude-code');
      // The list is drawn from the real environment — this suite itself runs under an
      // agent, so `CLAUDECODE` may well be in it — but it can only ever hold names the
      // probe asked about, and the two probe-only names are not set here.
      const present = handshake?.['env_present'] as readonly string[];
      expect(present.every((name) => CANARY_PROBE_ENV_NAMES.includes(name))).toBe(true);
      expect(present).not.toContain('HANDOFF_PROBE');
      expect(present).not.toContain('HANDOFF_PROBE_TOKEN');
    } finally {
      await session.close();
    }
  });

  it('records the status of an ordinary tool result, which is what E2E-8 reads', async () => {
    const session = await connect({ HANDOFF_CANARY: '1' });
    try {
      await session.client.callTool({
        name: 'handoff_runbooks',
        arguments: { where: 'Stripe dashboard', goal: 'Add a webhook endpoint' },
      });
      const result = observations(session.file).find((line) => line.event === 'tool_result');
      expect(result?.['method']).toBe('handoff_runbooks');
      expect(result?.['ok']).toBe(true);
    } finally {
      await session.close();
    }
  });
});

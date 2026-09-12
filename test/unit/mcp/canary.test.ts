/**
 * The canary probe (T-023, T-066, TECHNICAL-DESIGN §11.5, Appendix B A-03, A-04, A-07, A-09).
 *
 * Two properties matter more than the rest and are asserted first: the probe does not
 * exist unless `HANDOFF_CANARY=1`, and nothing it writes carries the value of an
 * environment variable. Everything else here is the arithmetic the harness reads back.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, inflateSync } from 'node:zlib';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, describe, expect, it } from 'vitest';

import {
  createCanaryProbe,
  sleepUntilAborted,
  solidPng,
  CANARY_DIR_NAME,
  CANARY_IMAGE_COLOURS,
  CANARY_IMAGE_SIZE_PX,
  CANARY_IMAGE_TOOL_NAME,
  CANARY_MAX_SLEEP_MS,
  CANARY_OBSERVATIONS_FILE,
  CANARY_PROBE_ENV_NAMES,
  CANARY_TOOL_NAME,
  type CanaryImageColour,
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

  it('include the two names the pipe is derived from, which an agent may not pass on', () => {
    // T-066: Codex starts its servers with a cleaned environment; these two reaching the
    // server is what keeps its endpoint the app's (§5.8, DD-26).
    for (const name of ['USERDOMAIN', 'USERNAME']) {
      expect(CANARY_PROBE_ENV_NAMES).toContain(name);
      expect(ENV_VAR_NAMES as readonly string[]).toContain(name);
    }
  });

  it("include what Kilo Code's editor surface hands on, recorded before it is relied on", () => {
    // T-080 saw these reach a server of the VS Code extension's `kilo serve`, and not one of
    // the CLI's (T-081). The server reads none of them: they are observations only.
    for (const name of ['KILO_CLIENT', 'KILO_PARENT_PID', 'KILO_PLATFORM', 'VSCODE_PID']) {
      expect(CANARY_PROBE_ENV_NAMES).toContain(name);
    }
    for (const name of ['KILO_CLIENT', 'KILO_PARENT_PID', 'KILO_PLATFORM']) {
      expect(ENV_VAR_NAMES as readonly string[]).not.toContain(name);
    }
  });
});

describe('the tools the probe adds', () => {
  it('are sleep_ms and image_probe, and nothing else', () => {
    const probe = createCanaryProbe({ enabled: true, home: home() });
    const tools = probe?.tools() ?? [];
    expect(tools.map((tool) => tool.name)).toEqual([CANARY_TOOL_NAME, CANARY_IMAGE_TOOL_NAME]);
    expect(probe?.handles(CANARY_TOOL_NAME)).toBe(true);
    expect(probe?.handles(CANARY_IMAGE_TOOL_NAME)).toBe(true);
    expect(probe?.handles('handoff_to_user')).toBe(false);
  });
});

describe('the sleep_ms tool', () => {
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

/** The chunks of a PNG, in order, with their CRC checked against Node's own. */
function pngChunks(png: Buffer): { type: string; data: Buffer }[] {
  expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunks: { type: string; data: Buffer }[] = [];
  let offset = 8;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const body = png.subarray(offset + 4, offset + 8 + length);
    expect(png.readUInt32BE(offset + 8 + length)).toBe(crc32(body));
    chunks.push({ type: body.subarray(0, 4).toString('ascii'), data: body.subarray(4) });
    offset += 12 + length;
  }
  return chunks;
}

describe('the image_probe tool (A-07)', () => {
  it('answers a text block and one PNG of the colour it picked, and records the colour', async () => {
    const probe = createCanaryProbe({ enabled: true, home: home(), pickColour: () => 'blue' });
    const result = await probe?.call(CANARY_IMAGE_TOOL_NAME, {}, new AbortController().signal);

    expect(result?.isError).toBeUndefined();
    expect(result?.content.map((block) => block.type)).toEqual(['text', 'image']);
    const image = result?.content[1];
    expect(image?.type === 'image' ? image.mimeType : undefined).toBe('image/png');
    const png = Buffer.from(image?.type === 'image' ? image.data : '', 'base64');
    expect(png.equals(solidPng(CANARY_IMAGE_SIZE_PX, CANARY_IMAGE_COLOURS.blue))).toBe(true);

    const lines = observations(probe?.file ?? '');
    expect(lines).toHaveLength(1);
    expect(lines[0]?.event).toBe('image_probe');
    expect(lines[0]?.['colour']).toBe('blue');
  });

  it('draws a real PNG: every pixel the colour, the size it says, and valid checksums', () => {
    const size = 5;
    const png = solidPng(size, CANARY_IMAGE_COLOURS.yellow);
    const chunks = pngChunks(png);
    expect(chunks.map((chunk) => chunk.type)).toEqual(['IHDR', 'IDAT', 'IEND']);

    const header = chunks[0]?.data ?? Buffer.alloc(0);
    expect(header.readUInt32BE(0)).toBe(size);
    expect(header.readUInt32BE(4)).toBe(size);
    expect([...header.subarray(8)]).toEqual([8, 2, 0, 0, 0]);

    const pixels = inflateSync(chunks[1]?.data ?? Buffer.alloc(0));
    expect(pixels.length).toBe(size * (1 + size * 3));
    for (let row = 0; row < size; row += 1) {
      const start = row * (1 + size * 3);
      expect(pixels[start]).toBe(0);
      for (let x = 0; x < size; x += 1) {
        expect([...pixels.subarray(start + 1 + x * 3, start + 4 + x * 3)]).toEqual([
          ...CANARY_IMAGE_COLOURS.yellow,
        ]);
      }
    }
  });

  it('picks among the six colours by default', async () => {
    const probe = createCanaryProbe({ enabled: true, home: home() });
    for (let call = 0; call < 12; call += 1) {
      await probe?.call(CANARY_IMAGE_TOOL_NAME, {}, new AbortController().signal);
    }
    const painted = observations(probe?.file ?? '').map((line) => line['colour'] as string);
    expect(painted).toHaveLength(12);
    const names = Object.keys(CANARY_IMAGE_COLOURS) as CanaryImageColour[];
    expect(painted.every((colour) => (names as string[]).includes(colour))).toBe(true);
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

  it('adds its two tools after the three, and records the handshake and the calls', async () => {
    const session = await connect({ HANDOFF_CANARY: '1', HANDOFF_AGENT: 'claude-code' });
    try {
      expect(session.tools.map((tool) => tool.name)).toEqual([
        ...TOOL_NAMES,
        CANARY_TOOL_NAME,
        CANARY_IMAGE_TOOL_NAME,
      ]);
      await session.client.callTool({ name: CANARY_TOOL_NAME, arguments: { ms: 1 } });

      const events = observations(session.file).map((line) => line.event);
      expect(events).toContain('initialize');
      expect(events).toContain('tools_list');
      expect(events).toContain('sleep_start');
      expect(events).toContain('sleep_end');

      const handshake = observations(session.file).find((line) => line.event === 'initialize');
      expect(handshake?.['client_name']).toBe('handoff-mcp-canary-test');
      expect(handshake?.['agent_id']).toBe('claude-code');
      expect(handshake?.['stop_hook']).toBe(true);
      expect(handshake?.['images_in_results']).toBe(true);
      expect(handshake?.['cwd']).toBe(process.cwd());
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

  it('hands an agent the image of image_probe as an MCP image block', async () => {
    const session = await connect({ HANDOFF_CANARY: '1' });
    try {
      const result = await session.client.callTool({ name: CANARY_IMAGE_TOOL_NAME, arguments: {} });
      const content = result.content as readonly { type: string; mimeType?: string }[];
      expect(content.map((block) => block.type)).toEqual(['text', 'image']);
      expect(content[1]?.mimeType).toBe('image/png');
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

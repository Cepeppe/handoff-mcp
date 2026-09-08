/**
 * Contract test for the internal channel protocol (TECHNICAL-DESIGN §6).
 *
 * `fixtures/channel/*.jsonl` is the golden set replayed by both test doubles — `fake-app`
 * on the server side and `fake-server` on the app side — so the two fakes cannot drift
 * from the real peers. Every line here must validate against `channel.v1.schema.json`,
 * and the sequences must also be mutually consistent: an answer answers a request that
 * was actually sent, a `call_id` in an event belongs to a call that was opened or
 * resumed, and one flow file concerns one handoff.
 *
 * Shapes that no golden flow exercises — the neutral hook answer, a non-empty
 * `secret_treated`, the five application error codes — are asserted here directly, and so
 * are the mutations the schema must reject: a validator that accepts everything passes a
 * fixture suite silently.
 *
 * The last block closes the loop for the real peer: what `src/channel/client.ts` actually
 * writes on a connection is validated against the same schema, so the client cannot drift
 * from the protocol it claims to speak while every fixture stays green (T-018).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';
import type { AnySchema, ErrorObject, ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';

import {
  APPLICATION_ERROR_CODES,
  AUTH_FAILED_CODE,
  ChannelClient,
  PROTOCOL_UNSUPPORTED_CODE,
  PROTOCOL_VERSION,
  applicationErrorName,
  encodeMessage,
  success,
} from '../../src/channel';
import { createLogger } from '../../src/log';
import type { Endpoint, TokenRead } from '../../src/platform';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PROTOCOL = join(ROOT, 'protocol', 'channel');
const FIXTURES = join(ROOT, 'fixtures', 'channel');

const BASE = 'https://raw.githubusercontent.com/Cepeppe/handoff-mcp/main/';
const CHANNEL_ID = `${BASE}protocol/channel/channel.v1.schema.json`;

type Direction = '→' | '←';

/** The methods and directions of the §6.3 table, transcribed. `↔` is both directions. */
const METHODS: Record<string, Direction[]> = {
  hello: ['→'],
  'handoff.open': ['→'],
  'handoff.continue': ['→'],
  'handoff.resume': ['→'],
  'handoff.verify': ['→'],
  'handoff.detach_call': ['→'],
  'hook.stop': ['→'],
  'session.bye': ['→'],
  'handoff.event': ['←'],
  'app.shutdown': ['←'],
  ping: ['→', '←'],
};

/** One file per flow of §9, plus the two connection-level refusals of §6.2. */
const FIXTURE_FILES = [
  'auth-failed.jsonl',
  'f01-register.jsonl',
  'f02-happy-path.jsonl',
  'f04-ask-reply.jsonl',
  'f05-defer-park.jsonl',
  'f06-heartbeat-resume.jsonl',
  'f07-user-request.jsonl',
  'f08-failed-correction.jsonl',
  'f10-hook-block.jsonl',
  'f11-transfer.jsonl',
  'protocol-mismatch.jsonl',
];

const TOKEN = 'c0ffee11d0d0f00d1234567890abcdef00112233445566778899aabbccddeeff';

type JsonObject = Record<string, unknown>;

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function explain(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? [])
    .map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`)
    .slice(0, 6)
    .join('; ');
}

const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
for (const name of ['handoff-spec', 'handoff-outcome', 'handoff-runbook']) {
  ajv.addSchema(readJson(join(ROOT, 'schemas', `${name}.v1.schema.json`)) as AnySchema);
}
const channelSchema = readJson(join(PROTOCOL, 'channel.v1.schema.json')) as JsonObject;
ajv.addSchema(channelSchema);

function compiled(id: string): ValidateFunction {
  const validate = ajv.getSchema(id);
  if (!validate) throw new Error(`schema not registered: ${id}`);
  return validate;
}

const validateMessage = compiled(CHANNEL_ID);

/** Asserts a message validates, and shows why when it does not. */
function accepts(message: unknown): void {
  const ok = validateMessage(message);
  expect(explain(validateMessage.errors)).toBe('');
  expect(ok).toBe(true);
}

function rejects(message: unknown): void {
  expect(validateMessage(message)).toBe(false);
}

interface Line {
  dir: Direction;
  msg: JsonObject;
  /** 1-based, for failure messages. */
  n: number;
}

function readFixture(name: string): Line[] {
  return readFileSync(join(FIXTURES, name), 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line, index) => {
      const parsed = readJsonLine(line);
      return { ...parsed, n: index + 1 };
    });
}

function readJsonLine(line: string): { dir: Direction; msg: JsonObject } {
  const parsed: unknown = JSON.parse(line);
  if (!isObject(parsed) || !isObject(parsed['msg'])) {
    throw new Error(`not a {dir, msg} line: ${line.slice(0, 80)}`);
  }
  const dir = parsed['dir'];
  if (dir !== '→' && dir !== '←') throw new Error(`unknown direction: ${String(dir)}`);
  return { dir, msg: parsed['msg'] };
}

const fixtures = new Map(FIXTURE_FILES.map((name) => [name, readFixture(name)]));

const methodOf = (msg: JsonObject): string | undefined =>
  typeof msg['method'] === 'string' ? msg['method'] : undefined;

/** The JSON-RPC id as text. Absent on notifications; the schema allows integers and strings. */
const idOf = (msg: JsonObject): string | undefined => {
  const id = msg['id'];
  if (typeof id === 'number') return String(id);
  return typeof id === 'string' ? id : undefined;
};

/** Every value of `key` anywhere in the message, however deep. */
function collect(value: unknown, key: string, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collect(item, key, into);
  } else if (isObject(value)) {
    for (const [name, child] of Object.entries(value)) {
      if (name === key && typeof child === 'string') into.add(child);
      else collect(child, key, into);
    }
  }
  return into;
}

const params = (msg: JsonObject): JsonObject => (isObject(msg['params']) ? msg['params'] : {});
const result = (msg: JsonObject): JsonObject => (isObject(msg['result']) ? msg['result'] : {});

describe('channel schema', () => {
  it('is a 2020-12 schema with a stable $id', () => {
    expect(channelSchema['$schema']).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(channelSchema['$id']).toBe(CHANNEL_ID);
  });

  it('compiles in ajv strict mode with the public schemas it references', () => {
    expect(typeof validateMessage).toBe('function');
  });

  it('declares exactly the methods of the §6.3 table', () => {
    const defs = channelSchema['$defs'] as Record<string, JsonObject>;
    const declared = new Set<string>();
    for (const group of ['request', 'notification']) {
      const groupDef = defs[group];
      const branches = (groupDef?.['oneOf'] ?? []) as { $ref: string }[];
      for (const branch of branches) {
        const def = defs[branch.$ref.replace('#/$defs/', '')];
        const method = (def?.['properties'] as JsonObject | undefined)?.['method'];
        expect(isObject(method)).toBe(true);
        declared.add(String((method as JsonObject)['const']));
      }
    }
    expect([...declared].sort()).toEqual(Object.keys(METHODS).sort());
  });

  it('pins the protocol version, and the protocol_version file repeats it', () => {
    const defs = channelSchema['$defs'] as Record<string, JsonObject>;
    const current = defs['protocol_version_current']?.['const'];
    expect(current).toBe(1);
    const file = readFileSync(join(PROTOCOL, 'protocol_version'), 'utf8').trim();
    expect(Number(file)).toBe(current);
    expect(file).toBe(String(current));
  });

  it('accepts a hello that claims another version, so the peer can be told to update', () => {
    // §6.5: a mismatch is answered with protocol_unsupported, not closed as a framing error.
    const hello = fixtures.get('protocol-mismatch.jsonl')?.[0];
    expect(params(hello?.msg ?? {})['protocol_version']).toBe(2);
    accepts(hello?.msg);
  });
});

describe('channel fixtures', () => {
  it('ships the eleven golden sequences and nothing else', () => {
    expect(readdirSync(FIXTURES).sort()).toEqual([...FIXTURE_FILES].sort());
  });

  it.each(FIXTURE_FILES)('every line of %s validates', (name) => {
    const lines = fixtures.get(name) ?? [];
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const ok = validateMessage(line.msg);
      expect(`${name}:${String(line.n)} ${explain(validateMessage.errors)}`).toBe(
        `${name}:${String(line.n)} `,
      );
      expect(ok).toBe(true);
    }
  });

  it('covers every method of §6.3 at least once', () => {
    const seen = new Set<string>();
    for (const lines of fixtures.values()) {
      for (const line of lines) {
        const method = methodOf(line.msg);
        if (method !== undefined) seen.add(method);
      }
    }
    expect([...seen].sort()).toEqual(Object.keys(METHODS).sort());
  });

  it.each(FIXTURE_FILES)('sends each method in its declared direction in %s', (name) => {
    for (const line of fixtures.get(name) ?? []) {
      const method = methodOf(line.msg);
      if (method === undefined) continue;
      expect(METHODS[method] ?? []).toContain(line.dir);
    }
  });

  it.each(FIXTURE_FILES)('answers every request exactly once in %s', (name) => {
    const pending = new Map<string, number>();
    for (const line of fixtures.get(name) ?? []) {
      const id = idOf(line.msg);
      if (line.msg['id'] !== undefined) expect(id).toBeDefined();
      if (id === undefined) continue;
      const key = `${line.dir}:${id}`;
      if (methodOf(line.msg) !== undefined) {
        expect(pending.has(key)).toBe(false);
        pending.set(key, line.n);
      } else {
        const answered = `${line.dir === '→' ? '←' : '→'}:${id}`;
        expect(`${name}:${String(line.n)} answers ${answered}`).toBe(
          `${name}:${String(line.n)} answers ${pending.has(answered) ? answered : 'nothing'}`,
        );
        pending.delete(answered);
      }
    }
    expect([...pending.keys()]).toEqual([]);
  });

  it.each(FIXTURE_FILES)('concerns at most one handoff in %s', (name) => {
    const ids = new Set<string>();
    for (const line of fixtures.get(name) ?? []) {
      for (const id of collect(line.msg, 'handoff_id')) ids.add(id);
      for (const id of collect(line.msg, 'request_id')) ids.add(id);
    }
    expect(ids.size).toBeLessThanOrEqual(1);
  });

  it.each(FIXTURE_FILES)('only cites calls that were opened or resumed in %s', (name) => {
    const opened = new Set<string>();
    for (const line of fixtures.get(name) ?? []) {
      const method = methodOf(line.msg);
      const callId = params(line.msg)['call_id'];
      if (typeof callId !== 'string') continue;
      if (method === 'handoff.open' || method === 'handoff.resume') {
        expect(opened.has(callId)).toBe(false);
        opened.add(callId);
      } else {
        expect(`${name}:${String(line.n)} ${callId}`).toBe(
          `${name}:${String(line.n)} ${opened.has(callId) ? callId : 'unknown call'}`,
        );
      }
    }
  });

  it('gives the handoff the id of the user request it answers (DD-13)', () => {
    const lines = fixtures.get('f07-user-request.jsonl') ?? [];
    const open = lines.find((line) => methodOf(line.msg) === 'handoff.open');
    const requestId = params(open?.msg ?? {})['request_id'];
    expect(typeof requestId).toBe('string');
    const answer = lines.find((line) => line.msg['id'] === open?.msg['id'] && !methodOf(line.msg));
    expect(result(answer?.msg ?? {})['handoff_id']).toBe(requestId);
  });

  it('leaves the hook unregistered: no session_ref for role hook (§6.2)', () => {
    const lines = fixtures.get('f10-hook-block.jsonl') ?? [];
    expect(params(lines[0]?.msg ?? {})['role']).toBe('hook');
    expect(result(lines[1]?.msg ?? {})['session_ref']).toBeNull();
    expect(result(lines[3]?.msg ?? {})['block']).toBe(true);
  });
});

describe('shapes no golden flow carries', () => {
  const request = (id: number, method: string, p: unknown): unknown => ({
    jsonrpc: '2.0',
    id,
    method,
    params: p,
  });

  it('accepts the neutral hook answer, which carries no reason', () => {
    accepts({ jsonrpc: '2.0', id: 2, result: { block: false } });
  });

  it('accepts an open that reports secret-treated values (§5.5)', () => {
    const open = fixtures.get('f02-happy-path.jsonl')?.[0]?.msg ?? {};
    const withSecrets = {
      ...open,
      params: {
        ...params(open),
        secret_treated: [{ location: 'values.api_key', kind: 'api_key' }],
      },
    };
    accepts(withSecrets);
    rejects({
      ...withSecrets,
      params: { ...params(withSecrets), secret_treated: [{ location: 'values.api_key' }] },
    });
  });

  it('accepts a resume that finds a queued outcome and one that finds nothing', () => {
    const queued = fixtures.get('f02-happy-path.jsonl')?.[2]?.msg ?? {};
    accepts({
      jsonrpc: '2.0',
      id: 3,
      result: { state: 'awaiting_verification', outcome: params(queued)['outcome'] },
    });
    accepts({ jsonrpc: '2.0', id: 3, result: { state: 'active' } });
  });

  it('accepts the detach reasons of DD-24 and nothing else', () => {
    const detach = (reason: string): unknown => ({
      jsonrpc: '2.0',
      method: 'handoff.detach_call',
      params: { handoff_id: 'hf_7k3m9p2q4r', call_id: 'call_2q7m8r1t', reason },
    });
    accepts(detach('heartbeat'));
    accepts(detach('cancelled'));
    rejects(detach('because'));
  });

  it.each([
    [-32001, 'auth_failed', undefined],
    [-32002, 'protocol_unsupported', { protocol_version: 1 }],
    [-32010, 'unknown_value_key', { keys: ['endpoint_url'] }],
    [-32011, 'not_waiting', undefined],
    [-32012, 'final', undefined],
    [-32013, 'no_verify_in_spec', undefined],
    [-32014, 'not_found', undefined],
  ])('accepts error %i %s', (code, message, data) => {
    accepts({
      jsonrpc: '2.0',
      id: 4,
      error: data === undefined ? { code, message } : { code, message, data },
    });
  });

  it('rejects an error whose code and name disagree, or whose data is missing', () => {
    rejects({ jsonrpc: '2.0', id: 4, error: { code: -32001, message: 'not_found' } });
    rejects({ jsonrpc: '2.0', id: 4, error: { code: -32010, message: 'unknown_value_key' } });
    rejects({ jsonrpc: '2.0', id: 4, error: { code: -32099, message: 'boom' } });
  });

  it('rejects the mutations a codec must not let through', () => {
    const hello = structuredClone(fixtures.get('f01-register.jsonl')?.[0]?.msg ?? {});
    const helloParams = params(hello);

    rejects({ ...hello, params: { ...helloParams, token: 'not-hex' } });
    rejects({ ...hello, params: { ...helloParams, protocol_version: 0 } });
    rejects({ ...hello, params: { ...helloParams, unexpected: true } });
    rejects({
      ...hello,
      params: {
        ...helloParams,
        identity: { pid: 1, ppid: 0, ancestors: [], cwd: '/tmp' },
      },
    });

    const open = structuredClone(fixtures.get('f02-happy-path.jsonl')?.[0]?.msg ?? {});
    rejects({ ...open, params: { ...params(open), call_id: 'call_short' } });
    rejects({
      ...open,
      params: { ...params(open), spec: { ...(params(open)['spec'] as JsonObject), goal: '' } },
    });

    rejects(request(1, 'handoff.explode', {}));
    rejects({ jsonrpc: '2.0', id: 1, method: 'session.bye', params: {} });
    rejects({ jsonrpc: '1.0', id: 1, method: 'ping', params: {} });
    rejects({ jsonrpc: '2.0', id: 1, result: { ok: true, extra: 1 } });
    rejects({
      jsonrpc: '2.0',
      method: 'handoff.event',
      params: {
        call_id: 'call_2q7m8r1t',
        handoff_id: 'hf_7k3m9p2q4r',
        outcome: { outcome_version: 1 },
      },
    });
  });

  it('rejects a hook hello that also claims a capability row', () => {
    const hook = structuredClone(fixtures.get('f10-hook-block.jsonl')?.[0]?.msg ?? {});
    rejects({
      ...hook,
      params: { ...params(hook), capability_row: { agent_id: 'claude-code' } },
    });
    rejects({ ...hook, params: { ...params(hook), token: TOKEN.toUpperCase() } });
  });
});

/**
 * A socket the test drives by hand: what the client writes is recorded, what the test
 * pushes arrives as if the app had sent it. `allowHalfOpen: false` makes `end()` close the
 * whole thing, which is what a real socket does and what lets `close()` finish at once.
 */
class Loopback extends Duplex {
  readonly written: string[] = [];

  constructor() {
    super({ allowHalfOpen: false });
  }

  override _read(): void {
    // The test pushes.
  }

  override _write(chunk: Buffer, _encoding: string, done: (error?: Error) => void): void {
    this.written.push(chunk.toString('utf8'));
    done();
  }

  override _final(done: (error?: Error) => void): void {
    this.push(null);
    done();
  }
}

const settle = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

describe('what the client puts on the wire', () => {
  it('speaks the version the schema pins and the protocol_version file repeats', () => {
    const defs = channelSchema['$defs'] as Record<string, JsonObject>;
    expect(PROTOCOL_VERSION).toBe(defs['protocol_version_current']?.['const']);
  });

  /**
   * The five application errors are numbered in `protocol/channel/README.md` and nowhere
   * else (`DEVIATIONS.md`, T-007), and the pipeline maps them to the catalogue of §4.7.5 by
   * **code alone**. A constant that drifted from the table would silently turn one refusal
   * into another — a `final` read as a `not_found` — so the table is parsed and compared.
   */
  it('numbers the application errors exactly as the README table does', () => {
    const readme = readFileSync(join(PROTOCOL, 'README.md'), 'utf8');
    const documented = new Map<string, number>();
    for (const row of readme.matchAll(/^\|\s*`(-\d+)`\s*\|\s*`(\w+)`\s*\|/gmu)) {
      documented.set(row[2] ?? '', Number(row[1]));
    }
    expect(documented.get('auth_failed')).toBe(AUTH_FAILED_CODE);
    expect(documented.get('protocol_unsupported')).toBe(PROTOCOL_UNSUPPORTED_CODE);
    for (const [name, code] of Object.entries(APPLICATION_ERROR_CODES)) {
      expect([name, documented.get(name)]).toEqual([name, code]);
      expect(applicationErrorName(code)).toBe(name);
    }
    expect(applicationErrorName(-32099)).toBeUndefined();
  });

  /**
   * The screenshot the user sent travels **beside** the outcome, because the published
   * outcome schema is closed and carries no pixels (§6.6, `DEVIATIONS.md`, T-020). It is
   * optional on both messages that can carry a screenshot outcome, and it is a string.
   */
  it('carries an optional image beside the outcome of an event and of a resume', () => {
    const image =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const outcome = params(fixtures.get('f02-happy-path.jsonl')?.[2]?.msg ?? {})[
      'outcome'
    ] as JsonObject;

    const event = {
      jsonrpc: '2.0',
      method: 'handoff.event',
      params: { call_id: 'call_2q7m8r1t', handoff_id: 'hf_7k3m9p2q4r', outcome },
    };
    accepts(event);
    accepts({ ...event, params: { ...event.params, image } });
    rejects({ ...event, params: { ...event.params, image: 42 } });
    rejects({ ...event, params: { ...event.params, image: '' } });

    accepts({ jsonrpc: '2.0', id: 3, result: { state: 'active', outcome, image } });
    rejects({ jsonrpc: '2.0', id: 3, result: { state: 'active', outcome, image: null } });
  });

  it('sends a hello, a ping answer and a session.bye the schema accepts', async () => {
    const socket = new Loopback();
    const client = new ChannelClient({
      identity: {
        pid: 48211,
        ppid: 48190,
        ancestors: [{ pid: 48190, name: 'node' }],
        cwd: '/Users/g/dev/shop',
        project_dir: '/Users/g/dev/shop',
      },
      agentId: 'claude-code',
      client: { name: 'claude-code', version: '2.1.211' },
      capabilityRow: {
        agent_id: 'claude-code',
        display_name: 'Claude Code',
        support: 'full',
        images_in_results: true,
        stop_hook: true,
        tool_timeout_ms: 1_800_000,
      },
      serverVersion: '1.0.3',
      logger: createLogger('error', () => undefined),
      endpoint: (): Endpoint => ({ kind: 'unix', path: '/tmp/handoff/app.sock' }),
      token: (): TokenRead => ({ ok: true, token: TOKEN }),
      connect: () => socket,
    });

    client.start();
    await settle();
    socket.push(
      encodeMessage(
        success(1, { app_version: '1.0.0', protocol_version: 1, session_ref: 'ses_4m7q2t9x' }),
      ),
    );
    await settle();
    expect(client.isConnected()).toBe(true);

    socket.push(encodeMessage({ jsonrpc: '2.0', id: 100, method: 'ping', params: {} }));
    await settle();
    await client.close();

    const written = socket.written
      .join('')
      .split('\n')
      .filter((line) => line !== '');
    expect(written).toHaveLength(3);
    for (const line of written) accepts(JSON.parse(line));

    const [hello, pong, bye] = written.map((line) => JSON.parse(line) as JsonObject);
    expect(methodOf(hello ?? {})).toBe('hello');
    expect(params(hello ?? {})['role']).toBe('server');
    expect(pong).toEqual({ jsonrpc: '2.0', id: 100, result: {} });
    expect(methodOf(bye ?? {})).toBe('session.bye');
  });
});

/**
 * The hook subcommand, without a socket (TECHNICAL-DESIGN §5.11, §9 F-10, SRV-11, NFR-11).
 *
 * Everything here is about the paths that must **not** produce a decision: a loop guard, a
 * payload we cannot use, a token we cannot read, an app that answers late or answers
 * something else. The real endpoint, the real fake app and the five rows of the F-10 table
 * are `test/integration/hook.test.ts`; what this file adds is the ability to make the app
 * behave in ways a listener cannot easily be asked to.
 */
import { Duplex } from 'node:stream';

import { describe, expect, it } from 'vitest';

import {
  NdjsonDecoder,
  encodeMessage,
  isRequest,
  request,
  success,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcParams,
} from '../../../src/channel';
import {
  HOOK_EVENT_NAMES,
  hookHelloParams,
  parseHookInput,
  runHookStop,
  type HookStopOptions,
} from '../../../src/hook';
import { createLogger } from '../../../src/log';
import type { ProcessIdentity, TokenRead } from '../../../src/platform';
import { channelViolation } from '../../fake-app';

const TOKEN = 'c0ffee11d0d0f00d1234567890abcdef00112233445566778899aabbccddeeff';

/** The payload A-05 documents, as Claude Code writes it on the hook's stdin. */
const HOOK_JSON = {
  session_id: '0b1e7c94-6f3a-4d21-9f0c-2ab5e8d17c43',
  transcript_path: '/Users/g/.claude/projects/shop/0b1e7c94.jsonl',
  cwd: '/Users/g/dev/shop',
  hook_event_name: 'Stop',
  stop_hook_active: false,
};

const IDENTITY: ProcessIdentity = { pid: 4242, ppid: 99, ancestors: [] };

/** What the peer answers a request with. `undefined` means "stay silent". */
type Reply = (method: string, params: JsonRpcParams, id: JsonRpcId) => JsonRpcMessage | undefined;

interface Peer {
  readonly socket: Duplex;
  readonly received: { method: string; params: JsonRpcParams }[];
}

/**
 * An app on the other end of a stream. It speaks the same NDJSON the real one does, so the
 * hook's own framing is exercised; what it does not do is listen on an endpoint, which is
 * exactly why a test can make it answer with a version from the future.
 */
function peer(reply: Reply): Peer {
  const received: { method: string; params: JsonRpcParams }[] = [];
  const decoder = new NdjsonDecoder();
  const socket: Duplex = new Duplex({
    read() {
      /* pushed from `write` */
    },
    write(chunk: Buffer, _encoding, callback) {
      const outcome = decoder.push(chunk);
      if (outcome.ok) {
        for (const message of outcome.messages) {
          if (!isRequest(message)) continue;
          received.push({ method: message.method, params: message.params });
          const answer = reply(message.method, message.params, message.id);
          if (answer !== undefined) socket.push(encodeMessage(answer));
        }
      }
      callback();
    },
  });
  return { socket, received };
}

/** The app of F-10 row 4: registers the hook, then asks for a block. */
function blockingPeer(reason: string): Peer {
  return peer((method, _params, id) => {
    if (method === 'hello') {
      return success(id, { app_version: '1.0.0', protocol_version: 1, session_ref: null });
    }
    if (method === 'hook.stop') return success(id, { block: true, reason });
    return undefined;
  });
}

/** The app of F-10 rows 2 and 3: registers the hook and has nothing to report. */
function neutralPeer(): Peer {
  return peer((method, _params, id) => {
    if (method === 'hello') {
      return success(id, { app_version: '1.0.0', protocol_version: 1, session_ref: null });
    }
    if (method === 'hook.stop') return success(id, { block: false });
    return undefined;
  });
}

interface Run {
  readonly code: number;
  readonly out: string[];
  readonly logs: string[];
  readonly connects: number;
  readonly exits: number[];
  readonly elapsedMs: number;
}

/** Runs the subcommand with everything injected, and reports what it did. */
async function hook(
  json: unknown,
  overrides: Partial<HookStopOptions> & { readonly peer?: Peer } = {},
): Promise<Run> {
  const out: string[] = [];
  const logs: string[] = [];
  const exits: number[] = [];
  let connects = 0;

  const { peer: scripted, ...rest } = overrides;
  const started = Date.now();
  const code = await runHookStop({
    out: (line) => out.push(line),
    logger: createLogger('debug', (line) => logs.push(line)),
    readInput: () => Promise.resolve(typeof json === 'string' ? json : JSON.stringify(json)),
    identity: () => Promise.resolve(IDENTITY),
    endpoint: () => ({ kind: 'unix', path: '/tmp/nowhere.sock' }),
    token: (): TokenRead => ({ ok: true, token: TOKEN }),
    cwd: () => '/tmp/process-cwd',
    hardExit: (value) => exits.push(value),
    connect: () => {
      connects += 1;
      if (scripted === undefined)
        throw Object.assign(new Error('nothing listening'), {
          code: 'ENOENT',
        });
      return scripted.socket;
    },
    budgetMs: 400,
    connectTimeoutMs: 200,
    hardExitMs: 600,
    ...rest,
  });
  return { code, out, logs, connects, exits, elapsedMs: Date.now() - started };
}

describe('parseHookInput (A-05)', () => {
  it('keeps the three required fields and the cwd, and forwards no transcript path', () => {
    const parsed = parseHookInput(JSON.stringify(HOOK_JSON));
    expect(parsed?.hook).toEqual({
      session_id: HOOK_JSON.session_id,
      hook_event_name: 'Stop',
      stop_hook_active: false,
    });
    expect(parsed?.cwd).toBe('/Users/g/dev/shop');
    expect(JSON.stringify(parsed?.hook)).not.toContain('transcript');
  });

  it('forwards the two SubagentStop fields when the agent sends them (ADPT-08)', () => {
    const parsed = parseHookInput(
      JSON.stringify({
        ...HOOK_JSON,
        hook_event_name: 'SubagentStop',
        agent_id: 'agent_7',
        agent_type: 'general-purpose',
      }),
    );
    expect(parsed?.hook).toMatchObject({
      hook_event_name: 'SubagentStop',
      agent_id: 'agent_7',
      agent_type: 'general-purpose',
    });
  });

  it('drops an optional field that would not fit the channel schema, and keeps the rest', () => {
    const parsed = parseHookInput(
      JSON.stringify({ ...HOOK_JSON, agent_id: 'a'.repeat(129), agent_type: '' }),
    );
    expect(parsed?.hook).toEqual({
      session_id: HOOK_JSON.session_id,
      hook_event_name: 'Stop',
      stop_hook_active: false,
    });
  });

  it.each<[string, unknown]>([
    ['not JSON at all', '{ not json'],
    ['an array', []],
    ['a bare string', '"Stop"'],
    ['no session_id', { ...HOOK_JSON, session_id: undefined }],
    ['an empty session_id', { ...HOOK_JSON, session_id: '' }],
    ['a session_id past the bound', { ...HOOK_JSON, session_id: 'x'.repeat(129) }],
    ['an event name we do not know', { ...HOOK_JSON, hook_event_name: 'PreToolUse' }],
    ['no stop_hook_active', { ...HOOK_JSON, stop_hook_active: undefined }],
    ['a stop_hook_active that is not a boolean', { ...HOOK_JSON, stop_hook_active: 'false' }],
  ])('refuses %s', (_name, value) => {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    expect(parseHookInput(text)).toBeUndefined();
  });

  it('accepts both events of ADPT-08 and nothing else', () => {
    for (const name of HOOK_EVENT_NAMES) {
      expect(parseHookInput(JSON.stringify({ ...HOOK_JSON, hook_event_name: name }))).toBeDefined();
    }
  });
});

describe('the hook hello (§5.8, channel.v1.schema.json)', () => {
  it('validates as a role-hook hello, with no project_dir and no capability row', () => {
    const params = hookHelloParams(TOKEN, IDENTITY, '/Users/g/dev/shop', {
      session_id: HOOK_JSON.session_id,
      hook_event_name: 'Stop',
      stop_hook_active: false,
    });
    expect(channelViolation(request(1, 'hello', params))).toBeUndefined();
    expect(params['role']).toBe('hook');
    expect(Object.keys(params).sort()).toEqual([
      'hook',
      'identity',
      'protocol_version',
      'role',
      'token',
    ]);
    expect(params['identity']).toEqual({
      pid: 4242,
      ppid: 99,
      ancestors: [],
      cwd: '/Users/g/dev/shop',
    });
  });
});

describe('the decision', () => {
  it('prints the block JSON of §5.11 and exits 0', async () => {
    const reason = 'Handoff hf_7k3m9p2q4r is awaiting your verification report.';
    const run = await hook(HOOK_JSON, { peer: blockingPeer(reason) });

    expect(run.code).toBe(0);
    expect(run.out).toEqual([JSON.stringify({ decision: 'block', reason })]);
    expect(JSON.parse(run.out[0] ?? '')).toEqual({ decision: 'block', reason });
  });

  it('sends the cwd the agent declared, not the one the process happens to have', async () => {
    const app = blockingPeer('something to do');
    await hook(HOOK_JSON, { peer: app });

    const hello = app.received.find((entry) => entry.method === 'hello');
    expect(hello?.params['identity']).toMatchObject({ cwd: '/Users/g/dev/shop' });
  });

  it('falls back to the process working directory when the payload declares none', async () => {
    const app = blockingPeer('something to do');
    await hook({ ...HOOK_JSON, cwd: undefined }, { peer: app });

    const hello = app.received.find((entry) => entry.method === 'hello');
    expect(hello?.params['identity']).toMatchObject({ cwd: '/tmp/process-cwd' });
  });

  it('caps the ancestor walk at the 200 ms of §5.8, and never past the budget', async () => {
    const asked: number[] = [];
    await hook(HOOK_JSON, {
      peer: neutralPeer(),
      identity: (timeoutMs) => {
        asked.push(timeoutMs);
        return Promise.resolve(IDENTITY);
      },
    });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toBeGreaterThan(0);
    expect(asked[0]).toBeLessThanOrEqual(200);
  });

  it('asks for the decision with hook.stop and no params (§6.3)', async () => {
    const app = neutralPeer();
    await hook(HOOK_JSON, { peer: app });
    expect(app.received.map((entry) => entry.method)).toEqual(['hello', 'hook.stop']);
    expect(app.received[1]?.params).toEqual({});
  });
});

describe('every other path is neutral (SRV-11, SRV-11a)', () => {
  it('exits at once on stop_hook_active, without opening a connection (SRV-12)', async () => {
    const run = await hook({ ...HOOK_JSON, stop_hook_active: true }, { peer: neutralPeer() });

    expect(run.code).toBe(0);
    expect(run.out).toEqual([]);
    expect(run.connects).toBe(0);
    expect(run.logs.join('\n')).toContain('hook_loop_guard');
  });

  it.each<[string, string]>([
    ['a payload that is not JSON', '{ not json'],
    ['a payload with no session_id', '{"hook_event_name":"Stop","stop_hook_active":false}'],
    ['an empty stdin', ''],
  ])('never connects for %s', async (_name, text) => {
    const run = await hook(text, { peer: neutralPeer() });
    expect(run.out).toEqual([]);
    expect(run.connects).toBe(0);
    expect(run.logs.join('\n')).toContain('hook_input_unusable');
  });

  it('never connects when the token file cannot be used (FM-10)', async () => {
    const run = await hook(HOOK_JSON, {
      peer: neutralPeer(),
      token: (): TokenRead => ({ ok: false, problem: 'missing' }),
    });
    expect(run.out).toEqual([]);
    expect(run.connects).toBe(0);
    expect(run.logs.join('\n')).toContain('hook_token_unusable');
  });

  it('is neutral when the app is not listening at all', async () => {
    const run = await hook(HOOK_JSON);
    expect(run.code).toBe(0);
    expect(run.out).toEqual([]);
    expect(run.connects).toBe(1);
    expect(run.elapsedMs).toBeLessThan(400);
  });

  it('is neutral when the app says there is nothing to report', async () => {
    const run = await hook(HOOK_JSON, { peer: neutralPeer() });
    expect(run.out).toEqual([]);
    expect(run.logs.join('\n')).toContain('hook_neutral');
  });

  it('is neutral when the app blocks without a reason', async () => {
    const app = peer((method, _params, id) => {
      if (method === 'hello') {
        return success(id, { app_version: '1.0.0', protocol_version: 1, session_ref: null });
      }
      return success(id, { block: true });
    });
    expect((await hook(HOOK_JSON, { peer: app })).out).toEqual([]);
  });

  it('is neutral when the app refuses the token (FM-10)', async () => {
    const app = peer((_method, _params, id) => ({
      jsonrpc: '2.0',
      id,
      error: { code: -32001, message: 'auth_failed' },
    }));
    const run = await hook(HOOK_JSON, { peer: app });

    expect(run.out).toEqual([]);
    expect(run.logs.join('\n')).toContain('hook_hello_refused');
  });

  it('is neutral when the app speaks another protocol version (FM-11)', async () => {
    const app = peer((method, _params, id) =>
      method === 'hello'
        ? success(id, { app_version: '2.0.0', protocol_version: 2, session_ref: null })
        : success(id, { block: true, reason: 'this must never be read' }),
    );
    expect((await hook(HOOK_JSON, { peer: app })).out).toEqual([]);
  });

  it('is neutral, and stops waiting, when the app answers hello and then goes quiet', async () => {
    const app = peer((method, _params, id) =>
      method === 'hello'
        ? success(id, { app_version: '1.0.0', protocol_version: 1, session_ref: null })
        : undefined,
    );
    const run = await hook(HOOK_JSON, { peer: app });

    expect(run.out).toEqual([]);
    expect(run.elapsedMs).toBeGreaterThanOrEqual(300);
    expect(run.elapsedMs).toBeLessThan(1_500);
  });

  it('is neutral when the socket comes up but nothing ever arrives on it', async () => {
    const silent = new Duplex({
      read() {
        /* nothing to read, ever */
      },
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    const run = await hook(HOOK_JSON, { peer: { socket: silent, received: [] } });

    expect(run.out).toEqual([]);
    // The connect timer, not the total budget: 200 ms rather than 400 ms.
    expect(run.elapsedMs).toBeLessThan(350);
  });

  it('is neutral when the whole budget is already spent before the connection', async () => {
    let clock = 0;
    const run = await hook(HOOK_JSON, {
      peer: neutralPeer(),
      now: () => {
        clock += 500;
        return clock;
      },
    });
    expect(run.out).toEqual([]);
    expect(run.connects).toBe(0);
    expect(run.logs.join('\n')).toContain('hook_budget_spent');
  });

  it('is neutral when reading the payload throws', async () => {
    const run = await hook(HOOK_JSON, {
      readInput: () => Promise.reject(new Error('stdin is gone')),
    });
    expect(run.out).toEqual([]);
    expect(run.logs.join('\n')).toContain('hook_failed');
  });
});

describe('the hard exit (§4.1, NFR-11)', () => {
  it('fires when something outlives the budget, and exits neutrally', async () => {
    const run = await hook(HOOK_JSON, {
      hardExitMs: 20,
      readInput: () =>
        new Promise<string>((resolve) => {
          setTimeout(() => {
            resolve('{}');
          }, 150);
        }),
    });
    expect(run.exits).toEqual([0]);
  });

  it('does not fire for a hook that answered in time', async () => {
    const run = await hook(HOOK_JSON, { peer: blockingPeer('something to do') });
    expect(run.exits).toEqual([]);
    expect(run.out).toHaveLength(1);
  });
});

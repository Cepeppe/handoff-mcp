/**
 * `handoff-mcp hook stop`: the Stop / SubagentStop hook (TECHNICAL-DESIGN §5.11, §9 F-10,
 * SRV-10..13, NFR-11, ADPT-08).
 *
 * The agent spawns this subcommand at every end of turn of every session that loads the
 * server (SRV-11a), writes the hook JSON on its stdin and reads a decision from its stdout.
 * The decision itself belongs to the app, which owns the queues and the once-per-item
 * counters (§7.5); this process is a transport with a stopwatch.
 *
 * Everything here follows from one rule: **the hook never blocks on uncertainty.** A missing
 * app, a refused token, a malformed input, a slow answer, an exception — every one of them
 * prints nothing and exits 0, because a hook that exits non-neutrally on an error path stops
 * the agent for a user who did nothing wrong. The only non-neutral answer is an app that
 * said, in so many words, `{ block: true, reason }`.
 *
 * The budgets of §4.1 are the second rule. NFR-11 gives the whole thing about two seconds:
 *
 * - **500 ms to connect.** An app that is not running fails in a millisecond; the timer is
 *   for the pathological case of an endpoint that accepts and never completes.
 * - **1 800 ms in total**, measured from the first line of `runHookStop` and shared by
 *   reading stdin, walking the ancestor chain, `hello` and `hook.stop`. There is no retry:
 *   the next end of turn is a fresh chance and it costs the user nothing.
 * - **1 950 ms hard exit**, on an unref'd timer. It cannot keep the process alive on its
 *   own, so it fires only if something else is holding the event loop — a socket that never
 *   errors, a write that never drains — which is exactly the case the total budget cannot
 *   cover from inside a promise. The hooks configuration also carries `timeout: 5` so that
 *   even this cannot hold the agent (SRV-11).
 *
 * The connection is this module's own, not `ChannelClient`'s: the client's budgets are ten
 * seconds per request and a retry schedule that never gives up (§5.3), which is right for a
 * session and wrong for a hook. What they share is `src/channel/codec.ts`, so both speak the
 * same framing, and the token, endpoint and identity of `src/platform/`.
 */
import { connect as netConnect } from 'node:net';
import type { Duplex } from 'node:stream';

import {
  CHANNEL_MAX_MESSAGE_BYTES,
  NdjsonDecoder,
  PROTOCOL_VERSION,
  encodeMessage,
  frameBytes,
  isFailure,
  isSuccess,
  request,
  type ChannelConnect,
  type JsonRpcFailure,
  type JsonRpcId,
  type JsonRpcParams,
  type JsonRpcSuccess,
} from '../channel';
import type { EnvRecord } from '../config';
import { createLogger, type Logger } from '../log';
import {
  ANCESTOR_TIMEOUT_MS,
  TokenFile,
  endpointTarget,
  resolveEndpoint,
  resolveProcessIdentity,
  type Endpoint,
  type ProcessIdentity,
  type TokenRead,
} from '../platform';

/** §4.1 `HOOK_CONNECT_TIMEOUT_MS`: how long the socket has to come up. */
export const HOOK_CONNECT_TIMEOUT_MS = 500;

/** §4.1 `HOOK_TOTAL_BUDGET_MS`: everything the hook does, from stdin to the decision. */
export const HOOK_TOTAL_BUDGET_MS = 1_800;

/** §4.1: the hard exit, on an unref'd timer, when something outlives the budget. */
export const HOOK_HARD_EXIT_MS = 1_950;

/**
 * How much of stdin is read before the input is called malformed. A hook payload is a few
 * hundred bytes; the cap is there so that a peer writing for ever cannot grow the buffer.
 */
export const HOOK_MAX_INPUT_BYTES = 1024 * 1024;

/** The two events of ADPT-08, treated alike by the app: same session key, same tab. */
export const HOOK_EVENT_NAMES = ['Stop', 'SubagentStop'] as const;

export type HookEventName = (typeof HOOK_EVENT_NAMES)[number];

/**
 * The part of the hook payload that travels to the app, exactly as
 * `protocol/channel/channel.v1.schema.json` closes it. `transcript_path` is deliberately
 * not forwarded — it is a path into the user's conversation and the app has no use for it —
 * and `cwd` travels in `identity`, where the app's session binding looks for it (§7.5).
 */
export interface HookInput {
  readonly session_id: string;
  readonly hook_event_name: HookEventName;
  readonly stop_hook_active: boolean;
  readonly agent_id?: string;
  readonly agent_type?: string;
}

/** What was read from stdin: the forwarded payload, plus the `cwd` the agent declared. */
export interface HookInvocation {
  readonly hook: HookInput;
  /** `input.cwd`, when the agent sent one that can be used. */
  readonly cwd: string | undefined;
}

/** The JSON a blocking decision prints on stdout (§5.11, A-05). */
export interface HookBlockDecision {
  readonly decision: 'block';
  readonly reason: string;
}

/** The longest a field of `hook_input` may be, as the channel schema closes it. */
const FIELD_MAX_LENGTH = 128;

/** A non-empty string that fits the schema's bound, or nothing. */
function boundedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (value.length === 0 || value.length > FIELD_MAX_LENGTH) return undefined;
  return value;
}

/**
 * Reads the hook JSON of A-05.
 *
 * The three required fields are required here too, in the shapes the channel schema
 * accepts: a payload we could not put in a valid `hello` is one the app would close the
 * connection over, so refusing it here costs a connection and gains a clean neutral exit.
 * That strictness is also the documented fallback of A-05 — an agent that renames a field
 * degrades to FM-03, hooks disabled, which is a degraded mode and not a broken one.
 *
 * The two optional `SubagentStop` fields are dropped rather than fatal when they do not
 * fit: they are decoration on the app's side, and losing them must not lose the decision.
 */
export function parseHookInput(text: string): HookInvocation | undefined {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    return undefined;
  }

  const record = document as Record<string, unknown>;
  const sessionId = boundedString(record['session_id']);
  const eventName = record['hook_event_name'];
  const active = record['stop_hook_active'];
  if (sessionId === undefined) return undefined;
  if (typeof eventName !== 'string') return undefined;
  if (!(HOOK_EVENT_NAMES as readonly string[]).includes(eventName)) return undefined;
  if (typeof active !== 'boolean') return undefined;

  const agentId = boundedString(record['agent_id']);
  const agentType = boundedString(record['agent_type']);
  const cwd = record['cwd'];

  return {
    hook: {
      session_id: sessionId,
      hook_event_name: eventName as HookEventName,
      stop_hook_active: active,
      ...(agentId === undefined ? {} : { agent_id: agentId }),
      ...(agentType === undefined ? {} : { agent_type: agentType }),
    },
    cwd: typeof cwd === 'string' && cwd.trim() !== '' ? cwd : undefined,
  };
}

/** Everything the hook reads and writes, injected so a test needs no processes. */
export interface HookStopOptions {
  /** Where the decision goes. Called at most once, and never on a neutral exit. */
  readonly out: (line: string) => void;
  /** Diagnostics. Everything the hook logs is `debug`: none of its failures is abnormal. */
  readonly logger?: Logger;
  readonly env?: EnvRecord;
  /** Reads the hook payload. Bounded by whatever is left of the total budget. */
  readonly readInput?: (budgetMs: number) => Promise<string>;
  readonly identity?: (timeoutMs: number) => Promise<ProcessIdentity>;
  readonly endpoint?: () => Endpoint;
  readonly token?: () => TokenRead;
  readonly connect?: ChannelConnect;
  /** The process working directory, used when the payload declares none. */
  readonly cwd?: () => string;
  readonly now?: () => number;
  /** What the hard-exit timer calls. `process.exit` in the CLI, a spy in a test. */
  readonly hardExit?: (code: number) => void;
  readonly budgetMs?: number;
  readonly connectTimeoutMs?: number;
  readonly hardExitMs?: number;
}

/** What the app answered, or the fact that it did not. */
type HookAnswer =
  | { readonly block: true; readonly reason: string }
  | { readonly block: false; readonly why: string };

/** The only exit code this subcommand has (§5.11). */
const NEUTRAL = 0;

const defaultConnect: ChannelConnect = (endpoint) => netConnect({ path: endpointTarget(endpoint) });

/** A logger that keeps its records to itself, for a caller that supplied none. */
function silentLogger(): Logger {
  return createLogger('error', () => {
    /* the CLI always passes its own; this is for a caller that did not */
  });
}

/**
 * Reads the whole of stdin, or as much of it as the budget allows.
 *
 * A terminal is answered at once with nothing: someone running the subcommand by hand has
 * no hook payload to give, and waiting the full budget for a newline would only look
 * broken. Whatever arrived when the budget runs out is what gets parsed, which is one more
 * way in: a truncated JSON document is malformed, and malformed is neutral.
 */
function readStdin(budgetMs: number): Promise<string> {
  const stream = process.stdin;
  if (stream.isTTY) return Promise.resolve('');

  return new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    let held = 0;
    let settled = false;

    const onData = (chunk: Buffer): void => {
      held += chunk.length;
      if (held > HOOK_MAX_INPUT_BYTES) {
        finish();
        return;
      }
      chunks.push(chunk);
    };

    function finish(): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.off('data', onData);
      stream.off('end', finish);
      stream.off('error', finish);
      resolve(Buffer.concat(chunks).toString('utf8'));
    }

    const timer = setTimeout(finish, budgetMs);
    stream.on('data', onData);
    stream.once('end', finish);
    stream.once('error', finish);
  });
}

/**
 * The `hello` of a hook (§5.8, `channel.v1.schema.json` `hello_hook_params`): the identity
 * fields a server sends minus `project_dir`, which a hook does not know, plus the payload
 * the agent wrote on its stdin. No `agent_id`, no `client`, no `capability_row`: a hook
 * registers no session and the app refuses a line that claims one.
 */
export function hookHelloParams(
  token: string,
  identity: ProcessIdentity,
  cwd: string,
  hook: HookInput,
): JsonRpcParams {
  return {
    protocol_version: PROTOCOL_VERSION,
    token,
    role: 'hook',
    identity: {
      pid: identity.pid,
      ppid: identity.ppid,
      ancestors: identity.ancestors.map((ancestor) => ({ pid: ancestor.pid, name: ancestor.name })),
      cwd,
    },
    hook: { ...hook },
  };
}

interface AskOptions {
  readonly endpoint: Endpoint;
  readonly token: string;
  readonly identity: ProcessIdentity;
  readonly cwd: string;
  readonly hook: HookInput;
  readonly connect: ChannelConnect;
  readonly connectTimeoutMs: number;
  readonly remainingMs: () => number;
  readonly logger: Logger;
}

/**
 * One connection, two requests, no retry: `hello`, then `hook.stop`, then the socket dies.
 *
 * The app closes the connection after answering a hook (§6.2), so there is nothing to keep
 * open and no `session.bye` to send — a hook never registered a session. Every path out of
 * here settles the promise exactly once and destroys the socket, including the ones where
 * the app answers something we did not ask about.
 */
async function askApp(options: AskOptions): Promise<HookAnswer> {
  const { connect, connectTimeoutMs, endpoint, logger, remainingMs } = options;

  let socket: Duplex;
  try {
    socket = connect(endpoint);
  } catch (cause) {
    return { block: false, why: reasonOf(cause) };
  }

  return new Promise<HookAnswer>((resolve) => {
    const decoder = new NdjsonDecoder();
    const pending = new Map<JsonRpcId, (answer: JsonRpcSuccess | JsonRpcFailure) => void>();
    const timers = new Set<NodeJS.Timeout>();
    let nextId = 1;
    let settled = false;

    const finish = (answer: HookAnswer): void => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      socket.removeAllListeners();
      // The socket is on its way out and a write already in flight can still fail; a
      // stream with no `error` listener would turn that into an uncaught exception.
      socket.on('error', () => {
        /* nothing left to report: the answer is already decided */
      });
      socket.destroy();
      resolve(answer);
    };

    const neutral = (why: string): void => {
      finish({ block: false, why });
    };

    const after = (ms: number, run: () => void): void => {
      timers.add(setTimeout(run, ms));
    };

    const send = (
      method: string,
      params: JsonRpcParams,
      onAnswer: (answer: JsonRpcSuccess | JsonRpcFailure) => void,
    ): void => {
      if (settled) return;
      const id = nextId;
      nextId += 1;
      const line = encodeMessage(request(id, method, params));
      if (frameBytes(line) > CHANNEL_MAX_MESSAGE_BYTES) {
        neutral('the request does not fit in one channel message');
        return;
      }
      pending.set(id, onAnswer);
      socket.write(line);
    };

    const connectTimer = setTimeout(() => {
      neutral('the app did not accept the connection in time');
    }, connectTimeoutMs);
    timers.add(connectTimer);

    // A completed connection or the first byte: either proves the endpoint is alive, and
    // the injected duplexes of the unit tests have no `connect` event, only data.
    const connected = (): void => {
      clearTimeout(connectTimer);
    };
    socket.once('connect', connected);

    socket.on('data', (chunk: Buffer) => {
      connected();
      const outcome = decoder.push(chunk);
      if (!outcome.ok) {
        neutral(`framing violation: ${outcome.violation}`);
        return;
      }
      for (const message of outcome.messages) {
        if (settled) return;
        if (!isSuccess(message) && !isFailure(message)) continue;
        const answer = pending.get(message.id);
        if (answer === undefined) continue;
        pending.delete(message.id);
        answer(message);
      }
    });
    socket.on('error', (cause: Error) => {
      neutral(reasonOf(cause));
    });
    socket.on('close', () => {
      neutral('the app closed the connection');
    });
    socket.on('end', () => {
      neutral('the app ended the connection');
    });

    const left = remainingMs();
    if (left <= 0) {
      neutral('the budget ran out');
      return;
    }
    after(left, () => {
      neutral('the budget ran out');
    });

    send(
      'hello',
      hookHelloParams(options.token, options.identity, options.cwd, options.hook),
      (message) => {
        if (isFailure(message)) {
          logger.debug('hook_hello_refused', { code: message.error.code });
          neutral(message.error.message);
          return;
        }
        if (message.result['protocol_version'] !== PROTOCOL_VERSION) {
          neutral('the app speaks another protocol version');
          return;
        }
        send('hook.stop', {}, (answer) => {
          if (isFailure(answer)) {
            neutral(answer.error.message);
            return;
          }
          const reason = answer.result['reason'];
          if (answer.result['block'] === true && typeof reason === 'string' && reason !== '') {
            finish({ block: true, reason });
            return;
          }
          neutral('the app has nothing to report');
        });
      },
    );
  });
}

/** A system error's `code`, or the name of whatever else was thrown. Never a path (R-19). */
function reasonOf(cause: unknown): string {
  if (typeof cause === 'object' && cause !== null) {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return cause instanceof Error ? cause.name : 'unknown';
}

/**
 * The subcommand. Always resolves with 0: §5.11 has no failing exit, only a decision or
 * silence, and the exit code is reserved for the agent's own "exit 2 blocks" convention,
 * which we deliberately do not use (A-05: JSON carries the reason unambiguously).
 */
export async function runHookStop(options: HookStopOptions): Promise<number> {
  const {
    out,
    env,
    logger = silentLogger(),
    readInput = readStdin,
    identity = (timeoutMs: number): Promise<ProcessIdentity> =>
      resolveProcessIdentity({ timeoutMs }),
    endpoint = (): Endpoint => resolveEndpoint(env === undefined ? {} : { env }),
    token = (): TokenRead => new TokenFile(env === undefined ? {} : { env }).read(),
    connect = defaultConnect,
    cwd = (): string => process.cwd(),
    now = Date.now,
    hardExit = (code: number): void => {
      process.exit(code);
    },
    budgetMs = HOOK_TOTAL_BUDGET_MS,
    connectTimeoutMs = HOOK_CONNECT_TIMEOUT_MS,
    hardExitMs = HOOK_HARD_EXIT_MS,
  } = options;

  const startedAt = now();
  const remainingMs = (): number => budgetMs - (now() - startedAt);

  // Unref'd: it cannot hold the process open by itself and fires only when something else
  // already is. Cleared on every way out, so a fast hook still exits as soon as it is done.
  const hardExitTimer = setTimeout(() => {
    hardExit(NEUTRAL);
  }, hardExitMs);
  hardExitTimer.unref();

  try {
    const text = await readInput(Math.max(remainingMs(), 0));
    const invocation = parseHookInput(text);
    if (invocation === undefined) {
      logger.debug('hook_input_unusable', { bytes: text.length });
      return NEUTRAL;
    }

    // SRV-12: the agent's own loop guard. It comes before everything else, the connection
    // included, because a hook that already blocked this turn has nothing left to ask.
    if (invocation.hook.stop_hook_active) {
      logger.debug('hook_loop_guard', { event: invocation.hook.hook_event_name });
      return NEUTRAL;
    }

    const read = token();
    if (!read.ok) {
      logger.debug('hook_token_unusable', { reason: read.problem });
      return NEUTRAL;
    }

    if (remainingMs() <= 0) {
      logger.debug('hook_budget_spent', { budget_ms: budgetMs });
      return NEUTRAL;
    }
    const resolved = await identity(Math.min(ANCESTOR_TIMEOUT_MS, remainingMs()));

    const answer = await askApp({
      endpoint: endpoint(),
      token: read.token,
      identity: resolved,
      cwd: invocation.cwd ?? cwd(),
      hook: invocation.hook,
      connect,
      connectTimeoutMs: Math.min(connectTimeoutMs, Math.max(remainingMs(), 0)),
      remainingMs,
      logger,
    });

    if (!answer.block) {
      logger.debug('hook_neutral', { reason: answer.why, elapsed_ms: now() - startedAt });
      return NEUTRAL;
    }

    const decision: HookBlockDecision = { decision: 'block', reason: answer.reason };
    out(JSON.stringify(decision));
    logger.debug('hook_block', { elapsed_ms: now() - startedAt });
    return NEUTRAL;
  } catch (cause) {
    // Nothing above is expected to throw, and if something does the answer is still
    // neutral: an exception is the strongest form of uncertainty there is.
    logger.debug('hook_failed', { reason: reasonOf(cause) });
    return NEUTRAL;
  } finally {
    clearTimeout(hardExitTimer);
  }
}

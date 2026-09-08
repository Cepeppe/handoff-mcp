/**
 * The channel client (TECHNICAL-DESIGN §5.3, §5.8, §6.2, §6.5, §6.6, SRV-20, FM-02, FM-13).
 *
 * The server is a child of the agent and connects **to** the app; the app never launches or
 * supervises a server. Registration happens in `hello` as soon as the socket connects, at
 * session start and not at the first tool call (SRV-20), and everything after that is about
 * one thing: the app being absent must degrade the session, never break it.
 *
 * - **The retry never gives up** (1, 2, 5, 10, then 30 s for ever, §5.3). A local connect
 *   attempt costs microseconds, so a session started before the app appears in the overlay
 *   within thirty seconds of the app starting (FM-02); until then calls degrade to text mode.
 * - **The token and the endpoint are resolved at every attempt** (§5.8), so a repaired token
 *   or a pointer file written later needs no restart.
 * - **A version mismatch is not a failure to retry harder.** The app answers
 *   `protocol_unsupported` and closes; the server slows to one attempt every five minutes
 *   and reports `PROTOCOL_MISMATCH`, whose fix text tells the user to update the app (§6.5,
 *   FM-11). A rejected, missing or malformed token is `CHANNEL_AUTH_FAILED` on the same
 *   principle (FM-10), but keeps the ordinary backoff, because the repair flow rewrites the
 *   token file and the next attempt is meant to pick it up.
 * - **Liveness is a ping after thirty seconds of silence**, and two unanswered pings mean
 *   the connection is dead (§6.3) — a half-open socket that never errors is otherwise
 *   indistinguishable from an idle one.
 *
 * What this module deliberately does **not** do is decide anything about handoffs. It moves
 * JSON-RPC in both directions, keeps the connection alive and says whether it is up; the
 * in-flight table, the heartbeat and the re-attach after a reconnection are T-020, above
 * this seam. `isConnected()` is the one fact the tool pipeline reads (`src/mcp/port.ts`).
 */
import { connect as netConnect } from 'node:net';
import type { Duplex } from 'node:stream';

import type { HelloCapabilityRow } from '../adapters';
import type { Logger } from '../log';
import {
  endpointTarget,
  resolveEndpoint,
  TokenFile,
  type Endpoint,
  type TokenRead,
} from '../platform';

import {
  encodeMessage,
  frameBytes,
  isFailure,
  isNotification,
  isRequest,
  isSuccess,
  NdjsonDecoder,
  notification,
  request,
  success,
  type JsonRpcFailure,
  type JsonRpcId,
  type JsonRpcParams,
  type JsonRpcMessage,
  type JsonRpcSuccess,
} from './codec';
import {
  AUTH_FAILED_CODE,
  BACKOFF_SCHEDULE_MS,
  CHANNEL_MAX_MESSAGE_BYTES,
  MISSED_PINGS_BEFORE_DEAD,
  PING_INTERVAL_MS,
  PROTOCOL_MISMATCH_RETRY_MS,
  PROTOCOL_UNSUPPORTED_CODE,
  PROTOCOL_VERSION,
  REQUEST_TIMEOUT_MS,
  backoffDelayMs,
  type AppShutdownParams,
  type ChannelFailure,
  type ChannelIdentity,
  type ClientInfo,
  type HandoffEventParams,
} from './protocol';

/**
 * How long `close` waits for `session.bye` to leave before destroying the socket. §5.3 asks
 * for a best-effort goodbye on the way out; a backstop is what keeps "best effort" from
 * meaning "the process hangs because the app stopped reading".
 */
export const SESSION_BYE_FLUSH_MS = 200;

/** A request that could not be made or could not be answered. */
export type ChannelErrorKind = 'unavailable' | 'timeout' | 'closed' | 'message_too_large';

export class ChannelError extends Error {
  readonly kind: ChannelErrorKind;

  constructor(kind: ChannelErrorKind, message: string) {
    super(message);
    this.name = 'ChannelError';
    this.kind = kind;
  }
}

/**
 * The app answered with a JSON-RPC error. `code` and `message` are the pair of §6.3 — the
 * name travels in `message` — so the caller maps them to the error catalogue without
 * guessing.
 */
export class ChannelResponseError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(error: JsonRpcFailure['error']) {
    super(error.message);
    this.name = 'ChannelResponseError';
    this.code = error.code;
    this.data = error.data;
  }
}

/** What the connection reports upwards. */
export interface ChannelEvents {
  readonly connected: { readonly session_ref: string; readonly app_version: string };
  readonly disconnected: { readonly reason: string };
  readonly 'handoff.event': HandoffEventParams;
  readonly 'app.shutdown': AppShutdownParams;
}

export type ChannelListener<K extends keyof ChannelEvents> = (payload: ChannelEvents[K]) => void;

/** Opens the transport. Injected in tests, where the peer is a stream and not a socket. */
export type ChannelConnect = (endpoint: Endpoint) => Duplex;

export interface ChannelClientOptions {
  /** The identity payload of §5.8, resolved once at startup (`src/platform/ancestors.ts`). */
  readonly identity: ChannelIdentity;
  /** The capability-table key resolved for this session (§5.6). */
  readonly agentId: string;
  /** `clientInfo` from the MCP `initialize` handshake. */
  readonly client: ClientInfo;
  /** The six-field projection of the resolved row that `hello` carries (§5.6, §6.3). */
  readonly capabilityRow: HelloCapabilityRow;
  /** The version of this server, as `package.json` declares it. */
  readonly serverVersion: string;
  readonly logger: Logger;
  /** Resolved at every attempt, so a pointer file written later is picked up (§5.8). */
  readonly endpoint?: () => Endpoint;
  /** Read at every attempt, so a regenerated token is picked up without a restart (§5.8). */
  readonly token?: () => TokenRead;
  readonly connect?: ChannelConnect;
  /** The backoff schedule, overridable so a test does not wait thirty seconds. */
  readonly backoff?: readonly number[];
}

/**
 * What `hello` says about the session (§5.6, §6.3). §5.3 resolves it from the MCP
 * `initialize`, which happens after this object is built, so it is settable: `serve`
 * describes the session and only then starts connecting. A description given between two
 * attempts applies to the next `hello`, because `helloParams` reads it every time.
 */
export interface ChannelSession {
  readonly agentId: string;
  readonly client: ClientInfo;
  readonly capabilityRow: HelloCapabilityRow;
}

interface Pending {
  readonly method: string;
  readonly resolve: (result: JsonRpcParams) => void;
  readonly reject: (cause: Error) => void;
  readonly timer: NodeJS.Timeout;
}

const defaultConnect: ChannelConnect = (endpoint) => netConnect({ path: endpointTarget(endpoint) });

export class ChannelClient {
  private readonly options: ChannelClientOptions;
  private session: ChannelSession;
  private readonly resolveToken: () => TokenRead;
  private readonly endpointOf: () => Endpoint;
  private readonly connect: ChannelConnect;
  private readonly backoff: readonly number[];
  private readonly logger: Logger;

  private readonly listeners: { [K in keyof ChannelEvents]: Set<ChannelListener<K>> } = {
    connected: new Set(),
    disconnected: new Set(),
    'handoff.event': new Set(),
    'app.shutdown': new Set(),
  };

  private readonly pending = new Map<JsonRpcId, Pending>();
  private decoder = new NdjsonDecoder();
  private socket: Duplex | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private pingTimer: NodeJS.Timeout | undefined;

  private started = false;
  private stopped = false;
  private registered = false;
  private attempt = 0;
  private nextId = 1;
  private missedPings = 0;
  private lastActivityAt = 0;
  private sessionRefValue: string | undefined;
  private appVersionValue: string | undefined;
  private failureValue: ChannelFailure | undefined;

  constructor(options: ChannelClientOptions) {
    this.options = options;
    this.session = {
      agentId: options.agentId,
      client: options.client,
      capabilityRow: options.capabilityRow,
    };
    this.logger = options.logger;
    this.connect = options.connect ?? defaultConnect;
    this.backoff = options.backoff ?? BACKOFF_SCHEDULE_MS;
    this.endpointOf = options.endpoint ?? ((): Endpoint => resolveEndpoint());
    if (options.token === undefined) {
      const file = new TokenFile();
      this.resolveToken = (): TokenRead => file.read();
    } else {
      this.resolveToken = options.token;
    }
  }

  /** Whether the channel is registered and usable right now (§5.3). */
  isConnected(): boolean {
    return this.registered;
  }

  /** The reference the app assigned this registration, while it lasts. */
  get sessionRef(): string | undefined {
    return this.sessionRefValue;
  }

  /** The app's version, as reported by the last successful `hello`. */
  get appVersion(): string | undefined {
    return this.appVersionValue;
  }

  /** Why registration is not happening, in the vocabulary of the error catalogue (§4.7.5). */
  get failure(): ChannelFailure | undefined {
    return this.failureValue;
  }

  /** Subscribes; the returned function unsubscribes. */
  on<K extends keyof ChannelEvents>(event: K, listener: ChannelListener<K>): () => void {
    const set = this.listeners[event];
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }

  /**
   * Replaces what `hello` says about this session. §5.3 resolves the capability row from the
   * `clientInfo` of the MCP `initialize`, which arrives after this object exists, so `serve`
   * calls this and then `start()`; the constructor's values are what the server knew before.
   */
  describeSession(session: ChannelSession): void {
    this.session = session;
  }

  /** Connects now and keeps reconnecting until `close` (§5.3). Calling it twice is a no-op. */
  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.tryConnect();
  }

  /**
   * One non-blocking request, with the 10 s timeout of §6.6. Rejects with `ChannelError`
   * when the channel is not up and with `ChannelResponseError` when the app answers an
   * error, so a caller can tell "the app is unreachable" from "the app said no".
   */
  request(method: string, params: JsonRpcParams = {}): Promise<JsonRpcParams> {
    if (!this.registered) {
      return Promise.reject(
        new ChannelError('unavailable', `the app is not reachable, so ${method} was not sent`),
      );
    }
    return this.sendRequest(method, params);
  }

  /** One notification. `false` when the channel is down and nothing was sent. */
  notify(method: string, params: JsonRpcParams = {}): boolean {
    if (!this.registered) return false;
    return this.write(notification(method, params));
  }

  /**
   * Says goodbye and stops. §5.3: on stdin EOF the server sends `session.bye` best effort
   * and exits 0; the wiring into `serve` is T-020's, this is the half that belongs to the
   * connection.
   */
  async close(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.clearReconnect();
    this.clearPing();
    this.rejectPending(new ChannelError('closed', 'the channel was closed'));

    const socket = this.socket;
    const wasRegistered = this.registered;
    this.socket = undefined;
    this.registered = false;
    this.sessionRefValue = undefined;
    if (socket === undefined) return;

    if (wasRegistered) socket.write(encodeMessage(notification('session.bye', {})));
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        socket.destroy();
        resolve();
      }, SESSION_BYE_FLUSH_MS);
      socket.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.end();
    });
  }

  // ── connection ────────────────────────────────────────────────────────────────────

  private tryConnect(): void {
    if (this.stopped || this.socket !== undefined) return;

    const token = this.resolveToken();
    if (!token.ok) {
      this.failureValue = 'CHANNEL_AUTH_FAILED';
      this.logger.error('channel_token_unusable', { reason: token.problem });
      this.retry();
      return;
    }

    let socket: Duplex;
    try {
      socket = this.connect(this.endpointOf());
    } catch (cause) {
      this.logger.debug('channel_connect_failed', { reason: reasonOf(cause) });
      this.retry();
      return;
    }

    this.socket = socket;
    this.decoder = new NdjsonDecoder();
    this.lastActivityAt = Date.now();
    socket.on('data', (chunk: Buffer) => {
      this.onData(chunk);
    });
    socket.on('error', (cause: Error) => {
      this.drop(`socket error ${reasonOf(cause)}`);
    });
    socket.on('close', () => {
      this.drop('the app closed the connection');
    });
    socket.on('end', () => {
      this.drop('the app ended the connection');
    });

    this.sendHello(token.token);
  }

  /**
   * The identity payload of §5.8. It is written by hand rather than spread from an object,
   * so that a field added to `ChannelIdentity` cannot reach the wire without passing the
   * schema check of `test/contract/channel.test.ts`.
   */
  private helloParams(token: string): JsonRpcParams {
    const { identity, serverVersion } = this.options;
    const { agentId, client, capabilityRow } = this.session;
    return {
      protocol_version: PROTOCOL_VERSION,
      token,
      role: 'server',
      server_version: serverVersion,
      identity: {
        pid: identity.pid,
        ppid: identity.ppid,
        ancestors: identity.ancestors.map((ancestor) => ({
          pid: ancestor.pid,
          name: ancestor.name,
        })),
        cwd: identity.cwd,
        project_dir: identity.project_dir,
      },
      agent_id: agentId,
      client: { name: client.name, version: client.version },
      capability_row: capabilityRow,
    };
  }

  private sendHello(token: string): void {
    void this.sendRequest('hello', this.helloParams(token)).then(
      (result) => {
        this.onHello(result);
      },
      (cause: unknown) => {
        this.onHelloFailed(cause);
      },
    );
  }

  private onHello(result: JsonRpcParams): void {
    const version = result['protocol_version'];
    if (version !== PROTOCOL_VERSION) {
      this.failureValue = 'PROTOCOL_MISMATCH';
      this.logger.error('channel_protocol_mismatch', {
        protocol_version: typeof version === 'number' ? version : -1,
      });
      this.drop('the app answered hello with another protocol version', PROTOCOL_MISMATCH_RETRY_MS);
      return;
    }

    const sessionRef = result['session_ref'];
    const appVersion = result['app_version'];
    if (typeof sessionRef !== 'string' || typeof appVersion !== 'string') {
      this.drop('the app answered hello without a session reference');
      return;
    }

    this.registered = true;
    this.attempt = 0;
    this.missedPings = 0;
    this.failureValue = undefined;
    this.sessionRefValue = sessionRef;
    this.appVersionValue = appVersion;
    this.startPing();
    this.logger.debug('channel_registered', { session_ref: sessionRef, app_version: appVersion });
    this.emit('connected', { session_ref: sessionRef, app_version: appVersion });
  }

  private onHelloFailed(cause: unknown): void {
    if (cause instanceof ChannelResponseError) {
      if (cause.code === AUTH_FAILED_CODE) {
        this.failureValue = 'CHANNEL_AUTH_FAILED';
        this.logger.error('channel_auth_failed', { code: cause.code });
        this.drop('the app refused the token');
        return;
      }
      if (cause.code === PROTOCOL_UNSUPPORTED_CODE) {
        this.failureValue = 'PROTOCOL_MISMATCH';
        this.logger.error('channel_protocol_mismatch', { code: cause.code });
        this.drop('the app speaks another protocol version', PROTOCOL_MISMATCH_RETRY_MS);
        return;
      }
    }
    this.logger.debug('channel_hello_failed', { reason: reasonOf(cause) });
    this.drop('hello was not answered');
  }

  /**
   * Tears the connection down and schedules the next attempt. Everything that can end a
   * connection funnels through here — a socket error, EOF, `app.shutdown`, a framing
   * violation, two unanswered pings — so there is one place where pending requests are
   * rejected and one place where the backoff is decided.
   */
  private drop(reason: string, delayMs?: number): void {
    const socket = this.socket;
    const wasRegistered = this.registered;
    this.socket = undefined;
    this.registered = false;
    this.sessionRefValue = undefined;
    this.clearPing();
    this.rejectPending(new ChannelError('closed', `the channel was lost: ${reason}`));

    if (socket !== undefined) {
      socket.removeAllListeners();
      socket.destroy();
    }
    if (wasRegistered) {
      this.logger.debug('channel_disconnected', { reason });
      this.emit('disconnected', { reason });
    }
    this.retry(delayMs);
  }

  private retry(delayMs?: number): void {
    if (this.stopped || this.reconnectTimer !== undefined) return;
    const delay = delayMs ?? backoffDelayMs(this.attempt, this.backoff);
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.tryConnect();
    }, delay);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer === undefined) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  // ── traffic ───────────────────────────────────────────────────────────────────────

  private onData(chunk: Buffer): void {
    this.lastActivityAt = Date.now();
    this.missedPings = 0;
    const outcome = this.decoder.push(chunk);
    if (!outcome.ok) {
      this.logger.error('channel_framing_violation', { reason: outcome.violation });
      this.drop(`framing violation: ${outcome.violation}`);
      return;
    }
    for (const message of outcome.messages) this.onMessage(message);
  }

  private onMessage(message: JsonRpcMessage): void {
    if (isRequest(message)) {
      if (message.method === 'ping') {
        this.write(success(message.id, {}));
        return;
      }
      this.logger.error('channel_unknown_request', { method: message.method });
      this.drop(`the app sent an unknown request: ${message.method}`);
      return;
    }

    if (isNotification(message)) {
      this.onNotification(message.method, message.params);
      return;
    }

    if (isSuccess(message) || isFailure(message)) this.settle(message);
  }

  /**
   * An unknown notification is ignored rather than fatal, which is the opposite of the rule
   * for requests. A request left unanswered would strand the app for ten seconds, while a
   * notification nobody understands costs nothing — and the pending calls this connection
   * carries are worth more than punctilio about a message that means nothing to us.
   */
  private onNotification(method: string, params: JsonRpcParams): void {
    if (method === 'handoff.event') {
      const event = asHandoffEvent(params);
      if (event === undefined) {
        this.logger.error('channel_malformed_event', { method });
        return;
      }
      this.emit('handoff.event', event);
      return;
    }

    if (method === 'app.shutdown') {
      const reason = params['reason'];
      this.emit('app.shutdown', { reason: typeof reason === 'string' ? reason : '' });
      this.drop('the app is shutting down');
      return;
    }

    this.logger.debug('channel_unknown_notification', { method });
  }

  private settle(message: JsonRpcSuccess | JsonRpcFailure): void {
    const pending = this.pending.get(message.id);
    if (pending === undefined) {
      this.logger.debug('channel_unmatched_response');
      return;
    }
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (isSuccess(message)) pending.resolve(message.result);
    else pending.reject(new ChannelResponseError(message.error));
  }

  private sendRequest(method: string, params: JsonRpcParams): Promise<JsonRpcParams> {
    const socket = this.socket;
    if (socket === undefined) {
      return Promise.reject(
        new ChannelError('unavailable', `the channel is down, so ${method} was not sent`),
      );
    }

    const id = this.nextId;
    this.nextId += 1;
    const line = encodeMessage(request(id, method, params));
    if (frameBytes(line) > CHANNEL_MAX_MESSAGE_BYTES) {
      return Promise.reject(
        new ChannelError('message_too_large', `${method} does not fit in one channel message`),
      );
    }

    return new Promise<JsonRpcParams>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new ChannelError(
            'timeout',
            `${method} was not answered within ${String(REQUEST_TIMEOUT_MS)} ms`,
          ),
        );
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { method, resolve, reject, timer });
      socket.write(line);
    });
  }

  private write(message: JsonRpcMessage): boolean {
    const socket = this.socket;
    if (socket === undefined) return false;
    const line = encodeMessage(message);
    if (frameBytes(line) > CHANNEL_MAX_MESSAGE_BYTES) {
      this.logger.error('channel_message_too_large', { bytes: frameBytes(line) });
      return false;
    }
    socket.write(line);
    return true;
  }

  private rejectPending(cause: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(cause);
    }
  }

  // ── liveness ──────────────────────────────────────────────────────────────────────

  private startPing(): void {
    this.clearPing();
    this.pingTimer = setInterval(() => {
      this.pingTick();
    }, PING_INTERVAL_MS);
  }

  private clearPing(): void {
    if (this.pingTimer === undefined) return;
    clearInterval(this.pingTimer);
    this.pingTimer = undefined;
  }

  private pingTick(): void {
    if (!this.registered) return;
    if (Date.now() - this.lastActivityAt < PING_INTERVAL_MS) return;
    void this.sendRequest('ping', {}).then(
      () => {
        this.missedPings = 0;
      },
      () => {
        if (!this.registered) return;
        this.missedPings += 1;
        if (this.missedPings < MISSED_PINGS_BEFORE_DEAD) return;
        this.logger.error('channel_ping_lost', { count: this.missedPings });
        this.drop(`${String(MISSED_PINGS_BEFORE_DEAD)} pings were not answered`);
      },
    );
  }

  private emit<K extends keyof ChannelEvents>(event: K, payload: ChannelEvents[K]): void {
    for (const listener of this.listeners[event]) listener(payload);
  }
}

/**
 * What went wrong, as a short code rather than a sentence: `ENOENT` when the app is not
 * listening, `ECONNREFUSED` when the endpoint is stale. The message of a system error names
 * the endpoint and would put a path in a log field for no diagnostic gain (R-19).
 */
function reasonOf(cause: unknown): string {
  if (typeof cause === 'object' && cause !== null) {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return cause instanceof Error ? cause.name : 'unknown';
}

/**
 * The fields of `handoff.event`; the outcome itself is read by the calls layer. The image
 * is passed through as it arrived and never decoded here: this module moves JSON-RPC and
 * decides nothing about handoffs, and base64 that is not a PNG is the app's mistake to
 * make, not something a framing layer can improve on.
 */
function asHandoffEvent(params: JsonRpcParams): HandoffEventParams | undefined {
  const callId = params['call_id'];
  const handoffId = params['handoff_id'];
  const outcome = params['outcome'];
  const image = params['image'];
  if (typeof callId !== 'string' || typeof handoffId !== 'string') return undefined;
  if (typeof outcome !== 'object' || outcome === null || Array.isArray(outcome)) return undefined;
  return {
    call_id: callId,
    handoff_id: handoffId,
    outcome: outcome as Record<string, unknown>,
    ...(typeof image === 'string' ? { image } : {}),
  };
}

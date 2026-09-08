/**
 * `fake-app`: the scripted channel listener the server's integration tests talk to
 * (TECHNICAL-DESIGN §11.3, §6.2, §6.3).
 *
 * It is an open implementation of the app's half of the channel, and it is deliberately
 * *strict* where the server is tolerant. §6.3 lets the server ignore unknown fields in a
 * result so a patch release of the app cannot break a stale server; the app has the
 * opposite duty — it "validates every incoming message against `channel.v1.schema.json`;
 * violations close the connection" — and a double that did not would let the server grow a
 * field the real app refuses, with nothing failing until T-042.
 *
 * Three consequences of that, each visible in the code below:
 *
 * - **The raw line is what gets validated**, before anything classifies it. `classify()` in
 *   `src/channel/codec.ts` fills an absent `params` with `{}` on purpose; running the schema
 *   after it would excuse exactly the sloppiness the app is supposed to refuse.
 * - **What the fake sends is validated too.** A double that answers with a message the
 *   schema rejects teaches the server a protocol that does not exist, so every outgoing
 *   line goes through the same check and a failure lands in `violations` rather than on the
 *   wire unnoticed.
 * - **It listens on the real endpoint**, a named pipe on Windows and a Unix socket
 *   elsewhere, under a `HANDOFF_HOME` of its own (§0.4 item 4 of `TASKS.md`) so it can never
 *   meet the app the owner is actually running. `env` is what the peer must be given for
 *   the two sides to derive the same name.
 *
 * The scripted behaviour is `scenario.ts`; the golden comparison is `golden.ts`;
 * `README.md` is how to write a scenario.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { timingSafeEqual } from 'node:crypto';

import {
  CHANNEL_MAX_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  classify,
  encodeMessage,
  isNotification,
  isRequest,
  notification,
  request,
  success,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcParams,
} from '../../src/channel';
import { newHandoffId, newSessionRef } from '../../src/ids';
import type { EnvRecord } from '../../src/config';
import { endpointTarget, resolveEndpoint, type Endpoint } from '../../src/platform';

import { canonicalSequence, isObject, readGolden, type JsonObject } from './golden';
import {
  APPLICATION_ERROR_CODES,
  HANDOFF_ID_SENTINEL,
  REQUEST_ID_SENTINEL,
  emptyScenario,
  expectationOf,
  isEmission,
  type Action,
  type ErrorReply,
  type Scenario,
} from './scenario';
import { channelViolation } from './validate';

/** §6.2: the first message must be `hello` within two seconds, or the app closes. */
export const HELLO_TIMEOUT_MS = 2_000;

/** The two connection-level errors of §6.3. */
const AUTH_FAILED = { code: -32001, message: 'auth_failed' } as const;

/** A token the fixtures use, so a test that does not care can hand it to both sides. */
export const FIXTURE_TOKEN = 'c0ffee11d0d0f00d1234567890abcdef00112233445566778899aabbccddeeff';

/** Everything received, in arrival order, with the connection it arrived on. */
export interface Recorded {
  readonly connection: number;
  readonly role: 'server' | 'hook' | 'unknown';
  readonly message: JsonRpcMessage;
}

/** A line one side got wrong. `direction` says which side, so a failure names the culprit. */
export interface Violation {
  readonly direction: 'in' | 'out';
  readonly connection: number;
  readonly reason: string;
  /** The offending message, with any token removed: a fixture is still not a place for one. */
  readonly message: unknown;
}

export interface FakeAppOptions {
  readonly scenario?: Scenario;
  /** `HANDOFF_HOME`. A private temporary folder is created and removed when absent. */
  readonly home?: string;
  /** The token both sides use. Written to `channel.token` so a peer can read it from there. */
  readonly token?: string;
  readonly appVersion?: string;
  /**
   * Refuse every `hello` with this error, whatever it carries. `protocol_unsupported` is
   * the only way to reach the peer's mismatch branch from here: the app answers with the
   * version *it* speaks, and the schema pins that to the current one, so a fake claiming
   * version 2 could not put a valid message on the wire (§6.5).
   */
  readonly refuse?: 'auth_failed' | 'protocol_unsupported';
  readonly helloTimeoutMs?: number;
}

interface Connection {
  readonly index: number;
  readonly socket: Socket;
  role: 'server' | 'hook' | 'unknown';
  sessionRef: string | null;
  handoffId: string | undefined;
  callId: string | undefined;
  buffer: Buffer;
  helloTimer: NodeJS.Timeout | undefined;
  closed: boolean;
}

const NEWLINE = 0x0a;

function redact(message: unknown): unknown {
  if (!isObject(message) || !isObject(message['params'])) return message;
  const params = message['params'];
  if (!('token' in params)) return message;
  return { ...message, params: { ...params, token: '<token>' } };
}

/** Constant-time comparison of two tokens, as §6.2 requires of the app. */
function sameToken(offered: string, expected: string): boolean {
  const a = Buffer.from(offered, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function deepSubstitute(value: unknown, from: string, to: string): unknown {
  if (Array.isArray(value)) return value.map((item) => deepSubstitute(item, from, to));
  if (isObject(value)) {
    const out: JsonObject = {};
    for (const [key, child] of Object.entries(value)) out[key] = deepSubstitute(child, from, to);
    return out;
  }
  return value === from ? to : value;
}

export class FakeApp {
  private readonly server: Server;
  private readonly connections = new Map<number, Connection>();
  private readonly queue: Action[];
  private readonly timers = new Set<NodeJS.Timeout>();
  private readonly ownsHome: boolean;
  private readonly appVersion: string;
  private readonly refuse: 'auth_failed' | 'protocol_unsupported' | undefined;
  private readonly helloTimeoutMs: number;

  private readonly sockets = new Set<Socket>();
  private nextConnection = 0;
  private nextId = 100;
  private active: Connection | undefined;
  private stopped = false;
  private markIn = 0;
  private markOut = 0;

  /** Everything received, in order (the `→` half of a golden sequence). */
  readonly recorded: Recorded[] = [];

  /** Everything sent, in order (the `←` half). */
  readonly sent: JsonRpcMessage[] = [];

  /** Lines either side got wrong. A green run leaves this empty. */
  readonly violations: Violation[] = [];

  /** Where the scenario had nothing to say and a default had to be invented. */
  readonly gaps: string[] = [];

  /** Every `session_ref` handed out, in order. */
  readonly sessions: string[] = [];

  readonly scenario: Scenario;
  readonly home: string;
  readonly token: string;
  readonly endpoint: Endpoint;
  /** What a peer must be given so that it derives this same endpoint (§0.4 item 4). */
  readonly env: EnvRecord;

  private constructor(options: FakeAppOptions, home: string, ownsHome: boolean, server: Server) {
    this.scenario = options.scenario ?? emptyScenario();
    this.queue = [...this.scenario.actions];
    this.home = home;
    this.ownsHome = ownsHome;
    this.token = options.token ?? FIXTURE_TOKEN;
    this.appVersion = options.appVersion ?? '1.0.0';
    this.refuse = options.refuse;
    this.helloTimeoutMs = options.helloTimeoutMs ?? HELLO_TIMEOUT_MS;
    this.env = { ...process.env, HANDOFF_HOME: home };
    this.endpoint = resolveEndpoint({ env: this.env });
    this.server = server;
  }

  /** Starts listening. The returned instance is ready for a peer to connect. */
  static async start(options: FakeAppOptions = {}): Promise<FakeApp> {
    const ownsHome = options.home === undefined;
    // A Unix socket path has to fit in 104 bytes, and the per-user temporary folder of
    // macOS is long enough to make that a close call; `/tmp` is four characters on both.
    const base = process.platform === 'win32' ? tmpdir() : '/tmp';
    const home = options.home ?? mkdtempSync(join(base, 'handoff-fake-app-'));
    const server = createServer();
    const app = new FakeApp(options, home, ownsHome, server);

    writeFileSync(join(home, 'channel.token'), `${app.token}\n`, { encoding: 'utf8', mode: 0o600 });
    server.on('connection', (socket: Socket) => {
      app.accept(socket);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(endpointTarget(app.endpoint), () => {
        resolve();
      });
    });
    if (app.endpoint.kind === 'unix') chmodSync(app.endpoint.path, 0o600);
    return app;
  }

  /** Stops listening, drops every connection and removes the temporary home. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    for (const connection of [...this.connections.values()]) this.close(connection, true);
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    await new Promise<void>((resolve) => {
      this.server.close(() => {
        resolve();
      });
    });
    if (this.ownsHome) rmSync(this.home, { recursive: true, force: true });
  }

  /** The messages received, without the bookkeeping: the `→` half of a golden sequence. */
  received(): JsonRpcMessage[] {
    return this.recorded.slice(this.markIn).map((entry) => entry.message);
  }

  /** The `expect` list as it actually happened, in the notation of a scenario file. */
  expectations(): string[] {
    return this.received().map((message) => expectationOf(message));
  }

  /**
   * Where the golden comparison starts. Every sequence except `f01`, `f10` and the two
   * refusals "begins after a successful registration", so a driver that had to register
   * first calls this once it is registered and the comparison starts where the file does.
   */
  mark(): void {
    this.markIn = this.recorded.length;
    this.markOut = this.sent.length;
  }

  /** The actions the scenario has not reached yet. Empty means the script ran to the end. */
  remaining(): readonly Action[] {
    return [...this.queue];
  }

  /**
   * What was received and what the golden says should have been, both canonical and both
   * numbered from their own first appearance. A test compares the two arrays and gets the
   * offending message as a diff.
   */
  goldenComparison(): { actual: string[]; expected: string[] } {
    const golden = this.scenario.golden;
    if (golden === undefined) throw new Error(`scenario ${this.scenario.name} names no golden`);
    const expected = readGolden(golden)
      .filter((line) => line.dir === '→')
      .map((line) => line.msg);
    return {
      actual: canonicalSequence(this.received(), this.scenario.ignore),
      expected: canonicalSequence(expected, this.scenario.ignore),
    };
  }

  /** The same comparison for the app's own half: what the scenario answered. */
  goldenAnswers(): { actual: string[]; expected: string[] } {
    const golden = this.scenario.golden;
    if (golden === undefined) throw new Error(`scenario ${this.scenario.name} names no golden`);
    const expected = readGolden(golden)
      .filter((line) => line.dir === '←')
      .map((line) => line.msg);
    return {
      actual: canonicalSequence(this.sent.slice(this.markOut), this.scenario.ignore),
      expected: canonicalSequence(expected, this.scenario.ignore),
    };
  }

  /** Resolves once `condition` holds, or rejects after `timeoutMs`. */
  async waitFor(condition: () => boolean, timeoutMs = 5_000, what = 'a condition'): Promise<void> {
    const started = Date.now();
    for (;;) {
      if (condition()) return;
      if (Date.now() - started > timeoutMs) {
        throw new Error(`fake-app timed out waiting for ${what}`);
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 5);
      });
    }
  }

  // ── connections ──────────────────────────────────────────────────────────────────

  private accept(socket: Socket): void {
    const index = this.nextConnection;
    this.nextConnection += 1;
    const connection: Connection = {
      index,
      socket,
      role: 'unknown',
      sessionRef: null,
      handoffId: undefined,
      callId: undefined,
      buffer: Buffer.alloc(0),
      helloTimer: undefined,
      closed: false,
    };
    this.connections.set(index, connection);
    this.sockets.add(socket);

    connection.helloTimer = this.later(() => {
      this.violations.push({
        direction: 'in',
        connection: index,
        reason: `no hello within ${String(this.helloTimeoutMs)} ms`,
        message: null,
      });
      this.close(connection);
    }, this.helloTimeoutMs);

    socket.on('data', (chunk: Buffer) => {
      this.onData(connection, chunk);
    });
    socket.on('error', () => {
      // A peer destroying its side is how several flows end; it is not a failure here.
    });
    socket.on('close', () => {
      this.forget(connection);
    });
  }

  /**
   * `abrupt` is `dropConnection` and `stop()`: the socket dies with whatever was in flight.
   * Everywhere else the connection is ended politely, because the app's refusals are
   * answered *and then* closed (§6.2) and a `destroy()` would discard the answer that
   * tells the peer why.
   */
  private close(connection: Connection, abrupt = false): void {
    if (connection.closed) return;
    connection.closed = true;
    if (connection.helloTimer !== undefined) clearTimeout(connection.helloTimer);
    if (abrupt) connection.socket.destroy();
    else connection.socket.end();
    this.forget(connection);
  }

  private forget(connection: Connection): void {
    connection.closed = true;
    if (connection.helloTimer !== undefined) clearTimeout(connection.helloTimer);
    this.connections.delete(connection.index);
    this.sockets.delete(connection.socket);
    if (this.active?.index === connection.index) this.active = undefined;
  }

  private later(run: () => void, ms: number): NodeJS.Timeout {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (!this.stopped) run();
    }, ms);
    this.timers.add(timer);
    return timer;
  }

  // ── framing and validation ───────────────────────────────────────────────────────

  private onData(connection: Connection, chunk: Buffer): void {
    if (connection.closed) return;
    connection.buffer = Buffer.concat([connection.buffer, chunk]);

    for (;;) {
      const end = connection.buffer.indexOf(NEWLINE);
      if (end === -1) break;
      const line = connection.buffer.toString('utf8', 0, end);
      connection.buffer = connection.buffer.subarray(end + 1);
      if (line.trim() === '') continue;
      if (Buffer.byteLength(line, 'utf8') > CHANNEL_MAX_MESSAGE_BYTES) {
        this.closeOnViolation(connection, 'message_too_large', null);
        return;
      }
      if (!this.onLine(connection, line)) return;
    }
    if (connection.buffer.length > CHANNEL_MAX_MESSAGE_BYTES) {
      this.closeOnViolation(connection, 'message_too_large', null);
    }
  }

  /** `false` when the connection was closed and the rest of the buffer must be dropped. */
  private onLine(connection: Connection, line: string): boolean {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.closeOnViolation(connection, 'invalid_json', null);
      return false;
    }

    const reason = channelViolation(parsed);
    if (reason !== undefined) {
      this.closeOnViolation(connection, reason, parsed);
      return false;
    }

    const message = classify(parsed);
    if (message === undefined) {
      this.closeOnViolation(connection, 'not_jsonrpc', parsed);
      return false;
    }

    this.recorded.push({ connection: connection.index, role: connection.role, message });
    const alive = this.dispatch(connection, message);
    // The barrier is released *after* the message has been dealt with, so an emission the
    // flow places behind it — the app's own ping in F-01 — cannot overtake the answer.
    this.arrive(expectationOf(parsed));
    this.pump();
    return alive;
  }

  /** Releases a barrier waiting for this message. */
  private arrive(expectation: string): void {
    const head = this.queue[0];
    if (head?.kind === 'awaitMessage' && head.expect === expectation) this.queue.shift();
  }

  private closeOnViolation(connection: Connection, reason: string, message: unknown): void {
    this.violations.push({
      direction: 'in',
      connection: connection.index,
      reason,
      message: redact(message),
    });
    this.close(connection);
  }

  private write(connection: Connection, message: JsonRpcMessage): void {
    if (connection.closed) return;
    const reason = channelViolation(message);
    if (reason !== undefined) {
      this.violations.push({
        direction: 'out',
        connection: connection.index,
        reason,
        message: redact(message),
      });
      return;
    }
    this.sent.push(message);
    connection.socket.write(encodeMessage(message));
  }

  // ── dispatch ─────────────────────────────────────────────────────────────────────

  private dispatch(connection: Connection, message: JsonRpcMessage): boolean {
    if (connection.role === 'unknown') return this.onHello(connection, message);

    this.active = connection;
    if (isRequest(message)) {
      return this.onRequest(connection, message.id, message.method, message.params);
    }
    if (isNotification(message)) {
      // `handoff.detach_call` needs no answer (§6.3); `session.bye` ends the connection.
      if (message.method === 'session.bye') this.close(connection);
      return !connection.closed;
    }
    // A response to our own `ping`: nothing to do beyond having recorded it.
    return true;
  }

  private onHello(connection: Connection, message: JsonRpcMessage): boolean {
    if (!isRequest(message) || message.method !== 'hello') {
      this.closeOnViolation(connection, 'the first message must be hello (§6.2)', message);
      return false;
    }
    if (connection.helloTimer !== undefined) {
      clearTimeout(connection.helloTimer);
      connection.helloTimer = undefined;
    }

    const token = message.params['token'];
    const badToken = typeof token !== 'string' || !sameToken(token, this.token);
    if (this.refuse === 'auth_failed' || badToken) {
      this.write(connection, { jsonrpc: '2.0', id: message.id, error: { ...AUTH_FAILED } });
      this.close(connection);
      return false;
    }

    const claimed = message.params['protocol_version'];
    if (this.refuse === 'protocol_unsupported' || claimed !== PROTOCOL_VERSION) {
      this.write(connection, {
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: -32002,
          message: 'protocol_unsupported',
          data: { protocol_version: PROTOCOL_VERSION },
        },
      });
      this.close(connection);
      return false;
    }

    connection.role = message.params['role'] === 'hook' ? 'hook' : 'server';
    connection.sessionRef = connection.role === 'hook' ? null : newSessionRef();
    if (connection.sessionRef !== null) this.sessions.push(connection.sessionRef);
    this.active = connection;

    const result = {
      app_version: this.appVersion,
      protocol_version: PROTOCOL_VERSION,
      session_ref: connection.sessionRef,
    };
    const delay = this.takeIfHead('delayHello');
    if (delay !== undefined && delay.kind === 'delayHello' && delay.ms > 0) {
      this.later(() => {
        this.write(connection, success(message.id, result));
        this.pump();
      }, delay.ms);
      return true;
    }
    this.write(connection, success(message.id, result));
    return true;
  }

  private onRequest(
    connection: Connection,
    id: JsonRpcId,
    method: string,
    params: JsonRpcParams,
  ): boolean {
    const handoffId = params['handoff_id'];
    if (typeof handoffId === 'string') connection.handoffId = handoffId;
    const callId = params['call_id'];
    if (typeof callId === 'string') connection.callId = callId;

    switch (method) {
      case 'ping':
        this.write(connection, success(id, {}));
        break;
      case 'handoff.open':
        this.answerOpen(connection, id, params);
        break;
      case 'handoff.continue':
        this.answerContinue(connection, id);
        break;
      case 'handoff.resume':
        this.answerResume(connection, id);
        break;
      case 'handoff.verify':
        this.answerVerify(connection, id);
        break;
      case 'hook.stop':
        this.answerHookStop(connection, id);
        break;
      default:
        // The schema declares no other request, so this is unreachable by a valid line.
        this.closeOnViolation(connection, `unknown request ${method}`, null);
        return false;
    }

    if (method === 'hook.stop') this.close(connection); // §6.2: one answer, then the door.
    return !connection.closed;
  }

  private answerOpen(connection: Connection, id: JsonRpcId, params: JsonRpcParams): void {
    const action = this.takeIfHead('onOpen');
    if (action?.kind === 'onOpen' && action.error !== undefined) {
      this.writeError(connection, id, action.error);
      return;
    }
    const wanted = action?.kind === 'onOpen' ? action.handoff_id : undefined;
    const requestId = params['request_id'];
    let assigned: string;
    if (wanted === REQUEST_ID_SENTINEL) {
      if (typeof requestId !== 'string') {
        this.gaps.push('onOpen asked for $request_id and the open carried none');
        assigned = newHandoffId();
      } else {
        assigned = requestId;
      }
    } else if (wanted !== undefined) {
      assigned = wanted;
    } else {
      assigned = typeof requestId === 'string' ? requestId : newHandoffId();
    }

    connection.handoffId = assigned;
    const resumedFrom = action?.kind === 'onOpen' ? (action.resumed_from ?? null) : null;
    this.write(connection, success(id, { handoff_id: assigned, resumed_from: resumedFrom }));
  }

  private answerContinue(connection: Connection, id: JsonRpcId): void {
    const action = this.takeIfHead('onContinue');
    if (action?.kind === 'onContinue' && action.error !== undefined) {
      this.writeError(connection, id, action.error);
      return;
    }
    this.write(connection, success(id, { ok: true }));
  }

  private answerResume(connection: Connection, id: JsonRpcId): void {
    const action = this.takeIfHead('onResume');
    if (action?.kind !== 'onResume') {
      this.write(connection, success(id, { state: 'active' }));
      return;
    }
    if (action.error !== undefined) {
      this.writeError(connection, id, action.error);
      return;
    }
    const result: JsonObject = { state: action.state };
    if (action.outcome !== undefined) {
      result['outcome'] = action.outcome === null ? null : this.resolve(connection, action.outcome);
    }
    if (action.resumed_from !== undefined) result['resumed_from'] = action.resumed_from;
    this.write(connection, success(id, result));
  }

  private answerVerify(connection: Connection, id: JsonRpcId): void {
    const action = this.takeIfHead('onVerify');
    if (action?.kind !== 'onVerify') {
      this.gaps.push('handoff.verify arrived with no onVerify rule; answered not_found');
      this.writeError(connection, id, { name: 'not_found', keys: undefined });
      return;
    }
    if (action.error !== undefined) {
      this.writeError(connection, id, action.error);
      return;
    }
    if (action.outcome === undefined) {
      this.gaps.push('onVerify carries no outcome; answered not_found');
      this.writeError(connection, id, { name: 'not_found', keys: undefined });
      return;
    }
    this.write(connection, success(id, { outcome: this.resolve(connection, action.outcome) }));
  }

  private answerHookStop(connection: Connection, id: JsonRpcId): void {
    const action = this.takeIfHead('answerHookStop');
    if (action?.kind !== 'answerHookStop') {
      // F-10's "nothing to report" row: neutral, and the hook prints nothing.
      this.write(connection, success(id, { block: false }));
      return;
    }
    const result: JsonObject = { block: action.block };
    if (action.reason !== undefined) result['reason'] = action.reason;
    this.write(connection, success(id, result));
  }

  private writeError(connection: Connection, id: JsonRpcId, error: ErrorReply): void {
    const code = APPLICATION_ERROR_CODES[error.name];
    const payload =
      error.name === 'unknown_value_key'
        ? { code, message: error.name, data: { keys: error.keys ?? [] } }
        : { code, message: error.name };
    this.write(connection, { jsonrpc: '2.0', id, error: payload });
  }

  /** `$handoff_id` becomes the handoff this connection is working on. */
  private resolve(connection: Connection, value: JsonObject): JsonObject {
    const handoffId = connection.handoffId;
    if (handoffId === undefined) return value;
    return deepSubstitute(value, HANDOFF_ID_SENTINEL, handoffId) as JsonObject;
  }

  // ── the scenario queue ───────────────────────────────────────────────────────────

  /** Consumes the head when it is the reply rule for `kind`, otherwise leaves it alone. */
  private takeIfHead(kind: Action['kind']): Action | undefined {
    const head = this.queue[0];
    if (head === undefined || head.kind !== kind) return undefined;
    this.queue.shift();
    return head;
  }

  /** Fires every emission that has reached the head of the queue. */
  private pump(): void {
    for (;;) {
      const head = this.queue[0];
      if (head === undefined || !isEmission(head) || this.stopped) return;
      this.queue.shift();
      if (head.afterMs > 0) {
        this.later(() => {
          this.perform(head);
          this.pump();
        }, head.afterMs);
        return;
      }
      this.perform(head);
    }
  }

  private perform(action: Action): void {
    const connection = this.active;
    if (connection === undefined || connection.closed) {
      this.gaps.push(`${action.kind} had no live connection to use`);
      return;
    }

    switch (action.kind) {
      case 'emitEvent': {
        const handoffId =
          action.handoff_id === undefined || action.handoff_id === HANDOFF_ID_SENTINEL
            ? connection.handoffId
            : action.handoff_id;
        if (handoffId === undefined || connection.callId === undefined) {
          this.gaps.push('emitEvent before any call was opened or resumed');
          return;
        }
        this.write(
          connection,
          notification('handoff.event', {
            call_id: connection.callId,
            handoff_id: handoffId,
            outcome: this.resolve(connection, action.outcome),
            ...(action.image === undefined ? {} : { image: action.image }),
          }),
        );
        break;
      }
      case 'sendPing':
        this.write(connection, request(this.takeId(), 'ping', {}));
        break;
      case 'sendAppShutdown':
        this.write(connection, notification('app.shutdown', { reason: action.reason }));
        break;
      case 'dropConnection':
        this.close(connection, true);
        break;
      default:
        this.gaps.push(`${action.kind} is not an emission`);
    }
  }

  private takeId(): number {
    const id = this.nextId;
    this.nextId += 1;
    return id;
  }
}

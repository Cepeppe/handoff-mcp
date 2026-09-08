/**
 * The scenario DSL: what the fake app does when a peer talks to it (§11.3).
 *
 * A scenario is a **queue**, not a set of callbacks, and the whole DSL follows from that:
 *
 * - The head of the queue is either a **reply rule** — `onOpen`, `onContinue`, `onResume`,
 *   `onVerify`, `answerHookStop`, `delayHello` — which waits there until a request of its
 *   method arrives, or an **emission** — `emitEvent`, `sendPing`, `sendAppShutdown`,
 *   `dropConnection` — which fires `afterMs` after reaching the head and advances, or a
 *   **barrier**, `awaitMessage`, which waits for one `→` message and then advances.
 * - A request whose method is not the head's is answered with the documented default and
 *   leaves the queue alone, so a scenario never has to enumerate the traffic it does not
 *   care about; the mismatch is recorded in `gaps[]` when the default had to invent a
 *   payload the flow should have specified.
 *
 * That is enough to express every golden flow of §9 in file order, which is the point:
 * a scenario reads like the sequence diagram it came from.
 *
 * **Scenario files never copy a payload out of `fixtures/channel/`.** A file that names a
 * `golden` has its actions derived from that fixture, and the `expect` and `send` lines it
 * writes down are checked against the derivation when it loads — so a fixture that changes
 * under a scenario is a loud failure and never a fake that quietly answers last month's
 * protocol. `test/fake-app/README.md` is the tutorial; this module is the grammar.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isObject, readGolden, type JsonObject } from './golden';

/** Where the scenario files live. */
export const SCENARIO_DIR = fileURLToPath(new URL('./scenarios/', import.meta.url));

/** The five application errors of §6.3, with the codes `protocol/channel/README.md` fixes. */
export const APPLICATION_ERROR_CODES = {
  unknown_value_key: -32010,
  not_waiting: -32011,
  final: -32012,
  no_verify_in_spec: -32013,
  not_found: -32014,
} as const;

export type ErrorName = keyof typeof APPLICATION_ERROR_CODES;

/** The states of §8.1, as `channel.v1.schema.json` enumerates them. */
export const HANDOFF_STATES = [
  'awaiting_spec',
  'active',
  'deferred',
  'parked',
  'awaiting_verification',
  'verified',
  'confirmed_by_user',
  'failed',
  'not_verified',
  'abandoned',
] as const;

export type HandoffState = (typeof HANDOFF_STATES)[number];

/** An application error instead of a result. `keys` belongs to `unknown_value_key` alone. */
export interface ErrorReply {
  readonly name: ErrorName;
  readonly keys: readonly string[] | undefined;
}

/** The opening session of a transferred handoff (TOOL-08), or `null`. */
export type ResumedFrom = { readonly agent: string; readonly project: string } | null;

export interface DelayHello {
  readonly kind: 'delayHello';
  /** How long the app takes to answer `hello`. The peer's own budget decides the rest. */
  readonly ms: number;
}

export interface OnOpen {
  readonly kind: 'onOpen';
  /**
   * The id the app assigns. `$request_id` gives the handoff the id of the user request it
   * answers (DD-13); absent means a fresh `hf_` id, which is what a live driver wants.
   */
  readonly handoff_id: string | undefined;
  readonly resumed_from: ResumedFrom | undefined;
  readonly error: ErrorReply | undefined;
}

export interface OnContinue {
  readonly kind: 'onContinue';
  readonly error: ErrorReply | undefined;
}

export interface OnResume {
  readonly kind: 'onResume';
  readonly state: HandoffState;
  /** A queued undelivered event or a final outcome; absent when the call just attaches. */
  readonly outcome: JsonObject | null | undefined;
  readonly resumed_from: ResumedFrom | undefined;
  readonly error: ErrorReply | undefined;
}

export interface OnVerify {
  readonly kind: 'onVerify';
  readonly outcome: JsonObject | undefined;
  readonly error: ErrorReply | undefined;
}

export interface AnswerHookStop {
  readonly kind: 'answerHookStop';
  readonly block: boolean;
  readonly reason: string | undefined;
}

export interface EmitEvent {
  readonly kind: 'emitEvent';
  readonly outcome: JsonObject;
  /** Defaults to the handoff this connection is working on; the call is always the live one. */
  readonly handoff_id: string | undefined;
  /**
   * The base64 PNG of a screenshot the user sent as an image, beside the outcome (§6.6): the
   * published outcome is closed and carries no pixels. No golden has one, because a fixture
   * with a real screenshot in it would be a fixture nobody can read.
   */
  readonly image: string | undefined;
  readonly afterMs: number;
}

export interface SendPing {
  readonly kind: 'sendPing';
  readonly afterMs: number;
}

export interface SendAppShutdown {
  readonly kind: 'sendAppShutdown';
  readonly reason: string;
  readonly afterMs: number;
}

export interface DropConnection {
  readonly kind: 'dropConnection';
  readonly afterMs: number;
}

/**
 * A barrier: the queue does not advance until a `→` message of this shape has arrived and
 * been dealt with. It is what keeps an emission from overtaking traffic the flow expects
 * first — the app's own `ping` of F-01 goes out after the server's ping has been answered,
 * not the instant the connection registers — and it is the only way a scenario can wait on
 * a message that carries no reply rule, a notification or a response.
 */
export interface AwaitMessage {
  readonly kind: 'awaitMessage';
  /** The method, or `(result)` / `(error)` for a response, as `expect` writes it. */
  readonly expect: string;
}

export type ReplyAction = DelayHello | OnOpen | OnContinue | OnResume | OnVerify | AnswerHookStop;
export type Emission = EmitEvent | SendPing | SendAppShutdown | DropConnection;
export type Action = ReplyAction | Emission | AwaitMessage;

/** Which request each reply rule answers. */
export const REPLY_METHOD: Record<ReplyAction['kind'], string> = {
  delayHello: 'hello',
  onOpen: 'handoff.open',
  onContinue: 'handoff.continue',
  onResume: 'handoff.resume',
  onVerify: 'handoff.verify',
  answerHookStop: 'hook.stop',
};

const EMISSION_KINDS = ['emitEvent', 'sendPing', 'sendAppShutdown', 'dropConnection'] as const;

export function isEmission(action: Action): action is Emission {
  return (EMISSION_KINDS as readonly string[]).includes(action.kind);
}

export interface Scenario {
  /** The file name without its extension. */
  readonly name: string;
  /** The flow of §9 this scenario plays, when it plays one. */
  readonly flow: string | undefined;
  readonly why: string;
  /** The golden sequence in `fixtures/channel/` the actions were derived from. */
  readonly golden: string | undefined;
  /** Paths excused from the golden comparison, because they belong to the peer. */
  readonly ignore: readonly string[];
  /** The `→` messages the peer is expected to send, in order. */
  readonly expect: readonly string[];
  /** The action kinds, in order: the scenario's own shape, in one line. */
  readonly send: readonly string[];
  readonly actions: readonly Action[];
}

/** How a received message appears in `expect`: its method, or the kind of its envelope. */
export function expectationOf(message: unknown): string {
  if (!isObject(message)) return '(unknown)';
  const method = message['method'];
  if (typeof method === 'string') return method;
  return 'error' in message ? '(error)' : '(result)';
}

// ── derivation from a golden sequence ────────────────────────────────────────────────

/** The sentinel a payload uses for the handoff this connection is working on. */
export const HANDOFF_ID_SENTINEL = '$handoff_id';

/** The sentinel `onOpen.handoff_id` uses to take the id of the request it answers (DD-13). */
export const REQUEST_ID_SENTINEL = '$request_id';

function asObject(value: unknown): JsonObject {
  return isObject(value) ? value : {};
}

function asResumedFrom(value: unknown): ResumedFrom | undefined {
  if (value === null) return null;
  if (!isObject(value)) return undefined;
  const agent = value['agent'];
  const project = value['project'];
  if (typeof agent !== 'string' || typeof project !== 'string') return undefined;
  return { agent, project };
}

function substitute(value: unknown, from: string, to: string): unknown {
  if (Array.isArray(value)) return value.map((item) => substitute(item, from, to));
  if (isObject(value)) {
    const out: JsonObject = {};
    for (const [key, child] of Object.entries(value)) out[key] = substitute(child, from, to);
    return out;
  }
  return value === from ? to : value;
}

function withSentinel(action: Action, handoffId: string): Action {
  if (action.kind === 'emitEvent') {
    return {
      ...action,
      outcome: substitute(action.outcome, handoffId, HANDOFF_ID_SENTINEL) as JsonObject,
      handoff_id: action.handoff_id === handoffId ? HANDOFF_ID_SENTINEL : action.handoff_id,
    };
  }
  if (action.kind === 'onResume' && action.outcome !== undefined && action.outcome !== null) {
    return {
      ...action,
      outcome: substitute(action.outcome, handoffId, HANDOFF_ID_SENTINEL) as JsonObject,
    };
  }
  if (action.kind === 'onVerify' && action.outcome !== undefined) {
    return {
      ...action,
      outcome: substitute(action.outcome, handoffId, HANDOFF_ID_SENTINEL) as JsonObject,
    };
  }
  return action;
}

export interface DerivedScenario {
  readonly expect: readonly string[];
  readonly send: readonly string[];
  readonly actions: readonly Action[];
}

/**
 * The script a golden sequence describes: the `→` lines become expectations, the `←` lines
 * become actions. `hello` and `ping` are left out on purpose — the connection layer answers
 * both, on every connection, whatever the scenario says — and so are the two `hello`
 * refusals, which the fake produces from its own token and version check rather than from a
 * script; `auth-failed` and `protocol-mismatch` are therefore scenarios with no actions.
 */
export function scenarioFromGolden(file: string, afterMs = 0): DerivedScenario {
  const lines = readGolden(file);
  const methodById = new Map<string, string>();
  const expect: string[] = [];
  const raw: Action[] = [];
  let handoffId: string | undefined;
  let requestId: string | undefined;

  for (const line of lines) {
    const method = typeof line.msg['method'] === 'string' ? line.msg['method'] : undefined;
    const id = line.msg['id'];
    const idText = typeof id === 'number' || typeof id === 'string' ? String(id) : undefined;

    if (line.dir === '→') {
      const expectation = expectationOf(line.msg);
      expect.push(expectation);
      if (method !== undefined && idText !== undefined) methodById.set(idText, method);
      if (method === 'handoff.open') {
        const value = asObject(line.msg['params'])['request_id'];
        if (typeof value === 'string') requestId = value;
      }
      // A request that a reply rule answers is its own barrier: the rule waits at the head
      // of the queue until it arrives. Everything else — a notification, a response, the
      // peer's own ping — needs one written down, or an emission placed after it in the
      // golden would go out before it.
      const answered = Object.values(REPLY_METHOD).includes(expectation);
      if (!answered && expectation !== 'hello') {
        raw.push({ kind: 'awaitMessage', expect: expectation });
      }
      continue;
    }

    if (method !== undefined) {
      const params = asObject(line.msg['params']);
      if (method === 'handoff.event') {
        const outcome = asObject(params['outcome']);
        const eventHandoff = params['handoff_id'];
        raw.push({
          kind: 'emitEvent',
          outcome,
          handoff_id: typeof eventHandoff === 'string' ? eventHandoff : undefined,
          // No golden carries pixels; a hand-written scenario is where an image comes from.
          image: typeof params['image'] === 'string' ? params['image'] : undefined,
          afterMs,
        });
      } else if (method === 'app.shutdown') {
        const reason = params['reason'];
        raw.push({
          kind: 'sendAppShutdown',
          reason: typeof reason === 'string' ? reason : '',
          afterMs,
        });
      } else if (method === 'ping') {
        raw.push({ kind: 'sendPing', afterMs });
      } else {
        throw new Error(`${file}:${String(line.n)} the app does not send ${method}`);
      }
      continue;
    }

    // A response: it answers the `→` request that carries the same id.
    const answered = idText === undefined ? undefined : methodById.get(idText);
    if (answered === undefined) throw new Error(`${file}:${String(line.n)} answers nothing`);
    if (answered === 'hello' || answered === 'ping') continue;

    const result = asObject(line.msg['result']);
    const error = isObject(line.msg['error']) ? line.msg['error'] : undefined;
    const errorReply = error === undefined ? undefined : errorReplyOf(error, file, line.n);

    if (answered === 'handoff.open') {
      const assigned = result['handoff_id'];
      if (typeof assigned === 'string') handoffId = assigned;
      raw.push({
        kind: 'onOpen',
        handoff_id:
          handoffId === undefined
            ? undefined
            : handoffId === requestId
              ? REQUEST_ID_SENTINEL
              : handoffId,
        resumed_from: asResumedFrom(result['resumed_from']),
        error: errorReply,
      });
    } else if (answered === 'handoff.continue') {
      raw.push({ kind: 'onContinue', error: errorReply });
    } else if (answered === 'handoff.resume') {
      const state = result['state'];
      raw.push({
        kind: 'onResume',
        state: (HANDOFF_STATES as readonly string[]).includes(String(state))
          ? (state as HandoffState)
          : 'active',
        outcome:
          result['outcome'] === undefined ? undefined : (result['outcome'] as JsonObject | null),
        resumed_from: asResumedFrom(result['resumed_from']),
        error: errorReply,
      });
    } else if (answered === 'handoff.verify') {
      raw.push({
        kind: 'onVerify',
        outcome: isObject(result['outcome']) ? result['outcome'] : undefined,
        error: errorReply,
      });
    } else if (answered === 'hook.stop') {
      const reason = result['reason'];
      raw.push({
        kind: 'answerHookStop',
        block: result['block'] === true,
        reason: typeof reason === 'string' ? reason : undefined,
      });
    } else {
      throw new Error(`${file}:${String(line.n)} answers ${answered}, which has no reply rule`);
    }
  }

  const assigned = handoffId;
  const actions =
    assigned === undefined ? raw : raw.map((action) => withSentinel(action, assigned));
  return { expect, send: actions.map((action) => action.kind), actions };
}

function errorReplyOf(error: JsonObject, file: string, n: number): ErrorReply {
  const name = error['message'];
  if (typeof name !== 'string' || !(name in APPLICATION_ERROR_CODES)) {
    throw new Error(`${file}:${String(n)} is not one of the five application errors`);
  }
  const data = asObject(error['data'])['keys'];
  return {
    name: name as ErrorName,
    keys: Array.isArray(data) ? data.map((key) => String(key)) : undefined,
  };
}

// ── scenario files ───────────────────────────────────────────────────────────────────

function requireString(document: JsonObject, key: string, where: string): string {
  const value = document[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${where}: "${key}" must be a non-empty string`);
  }
  return value;
}

function optionalStrings(document: JsonObject, key: string, where: string): string[] | undefined {
  const value = document[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${where}: "${key}" must be an array of strings`);
  }
  return value as string[];
}

function sameList(actual: readonly string[], declared: readonly string[] | undefined): boolean {
  return (
    declared === undefined ||
    (actual.length === declared.length && actual.every((item, i) => item === declared[i]))
  );
}

/**
 * One action of a hand-written scenario: an object with exactly one DSL key and an optional
 * `afterMs`. Refusing anything else is what keeps a typo — `onOpened`, `after_ms` — from
 * becoming a scenario that silently does nothing.
 */
export function parseAction(value: unknown, where: string): Action {
  if (!isObject(value)) throw new Error(`${where}: an action must be an object`);
  const afterMsRaw = value['afterMs'];
  if (afterMsRaw !== undefined && (typeof afterMsRaw !== 'number' || afterMsRaw < 0)) {
    throw new Error(`${where}: "afterMs" must be a number of milliseconds`);
  }
  const afterMs = typeof afterMsRaw === 'number' ? afterMsRaw : 0;

  const keys = Object.keys(value).filter((key) => key !== 'afterMs');
  const kind = keys[0];
  if (keys.length !== 1 || kind === undefined) {
    throw new Error(
      `${where}: an action names exactly one of ${[...Object.keys(REPLY_METHOD), ...EMISSION_KINDS].join(', ')}`,
    );
  }
  const body = asObject(value[kind]);

  switch (kind) {
    case 'delayHello': {
      const ms = body['ms'];
      if (typeof ms !== 'number' || ms < 0) throw new Error(`${where}: delayHello needs "ms"`);
      return { kind: 'delayHello', ms };
    }
    case 'onOpen': {
      const handoffId = body['handoff_id'];
      return {
        kind: 'onOpen',
        handoff_id: typeof handoffId === 'string' ? handoffId : undefined,
        resumed_from: asResumedFrom(body['resumed_from']),
        error: parseError(body, where),
      };
    }
    case 'onContinue':
      return { kind: 'onContinue', error: parseError(body, where) };
    case 'onResume': {
      const state = body['state'];
      if (typeof state !== 'string' || !(HANDOFF_STATES as readonly string[]).includes(state)) {
        throw new Error(`${where}: onResume needs a "state" of §8.1`);
      }
      return {
        kind: 'onResume',
        state: state as HandoffState,
        outcome: body['outcome'] === undefined ? undefined : (body['outcome'] as JsonObject | null),
        resumed_from: asResumedFrom(body['resumed_from']),
        error: parseError(body, where),
      };
    }
    case 'onVerify':
      return {
        kind: 'onVerify',
        outcome: isObject(body['outcome']) ? body['outcome'] : undefined,
        error: parseError(body, where),
      };
    case 'answerHookStop': {
      const block = body['block'];
      const reason = body['reason'];
      if (typeof block !== 'boolean') throw new Error(`${where}: answerHookStop needs "block"`);
      if (block && typeof reason !== 'string') {
        throw new Error(`${where}: answerHookStop with block true needs a "reason" (§6.3)`);
      }
      return {
        kind: 'answerHookStop',
        block,
        reason: typeof reason === 'string' ? reason : undefined,
      };
    }
    case 'emitEvent': {
      const outcome = body['outcome'];
      if (!isObject(outcome)) throw new Error(`${where}: emitEvent needs an "outcome"`);
      const handoffId = body['handoff_id'];
      const image = body['image'];
      if (image !== undefined && typeof image !== 'string') {
        throw new Error(`${where}: emitEvent "image" must be base64 PNG`);
      }
      return {
        kind: 'emitEvent',
        outcome,
        handoff_id: typeof handoffId === 'string' ? handoffId : undefined,
        image,
        afterMs,
      };
    }
    case 'sendPing':
      return { kind: 'sendPing', afterMs };
    case 'sendAppShutdown': {
      const reason = body['reason'];
      if (typeof reason !== 'string' || reason === '') {
        throw new Error(`${where}: sendAppShutdown needs a "reason"`);
      }
      return { kind: 'sendAppShutdown', reason, afterMs };
    }
    case 'dropConnection':
      return { kind: 'dropConnection', afterMs };
    case 'awaitMessage': {
      const expected = body['expect'];
      if (typeof expected !== 'string' || expected === '') {
        throw new Error(`${where}: awaitMessage needs an "expect" method or (result)`);
      }
      return { kind: 'awaitMessage', expect: expected };
    }
    default:
      throw new Error(`${where}: "${kind}" is not an action of the DSL`);
  }
}

function parseError(body: JsonObject, where: string): ErrorReply | undefined {
  const error = body['error'];
  if (error === undefined) return undefined;
  if (!isObject(error)) throw new Error(`${where}: "error" must be an object`);
  const name = error['name'];
  if (typeof name !== 'string' || !(name in APPLICATION_ERROR_CODES)) {
    throw new Error(`${where}: "${String(name)}" is not one of the five application errors`);
  }
  const keys = optionalStrings(error, 'keys', where);
  return { name: name as ErrorName, keys };
}

/**
 * A scenario document. A file that names a `golden` derives its actions from it and may
 * write down `expect` and `send`; both are then checked against the derivation, so the
 * fixture and the scenario cannot drift apart without a failure that says which one moved.
 */
export function parseScenario(document: unknown, name: string): Scenario {
  const where = `scenarios/${name}.json`;
  if (!isObject(document)) throw new Error(`${where}: a scenario must be an object`);

  const declared = requireString(document, 'scenario', where);
  if (declared !== name) throw new Error(`${where}: "scenario" says ${declared}`);
  const why = requireString(document, 'why', where);
  const flowRaw = document['flow'];
  const flow = typeof flowRaw === 'string' ? flowRaw : undefined;
  const ignore = optionalStrings(document, 'ignore', where) ?? [];
  const declaredExpect = optionalStrings(document, 'expect', where);
  const declaredSend = optionalStrings(document, 'send', where);
  const goldenRaw = document['golden'];
  const golden = typeof goldenRaw === 'string' ? goldenRaw : undefined;

  if (golden !== undefined) {
    if (document['actions'] !== undefined) {
      throw new Error(`${where}: a golden scenario derives its actions and declares none`);
    }
    const afterMsRaw = document['afterMs'];
    const afterMs = typeof afterMsRaw === 'number' ? afterMsRaw : 0;
    const derived = scenarioFromGolden(golden, afterMs);
    if (!sameList(derived.expect, declaredExpect)) {
      throw new Error(
        `${where}: "expect" is stale; ${golden} now sends [${derived.expect.join(', ')}]`,
      );
    }
    if (!sameList(derived.send, declaredSend)) {
      throw new Error(
        `${where}: "send" is stale; ${golden} now asks for [${derived.send.join(', ')}]`,
      );
    }
    return {
      name,
      flow,
      why,
      golden,
      ignore,
      expect: derived.expect,
      send: derived.send,
      actions: derived.actions,
    };
  }

  const rawActions = document['actions'];
  if (!Array.isArray(rawActions)) throw new Error(`${where}: "actions" must be an array`);
  const actions = rawActions.map((action, index) =>
    parseAction(action, `${where}[${String(index)}]`),
  );
  const send = actions.map((action) => action.kind);
  if (!sameList(send, declaredSend)) throw new Error(`${where}: "send" does not list the actions`);
  return {
    name,
    flow,
    why,
    golden: undefined,
    ignore,
    expect: declaredExpect ?? [],
    send,
    actions,
  };
}

/** Reads `scenarios/<name>.json`. */
export function loadScenario(name: string): Scenario {
  const document: unknown = JSON.parse(readFileSync(join(SCENARIO_DIR, `${name}.json`), 'utf8'));
  return parseScenario(document, name);
}

/** Every scenario file, by name, sorted. */
export function scenarioNames(): string[] {
  return readdirSync(SCENARIO_DIR)
    .filter((file) => file.endsWith('.json'))
    .map((file) => file.slice(0, -'.json'.length))
    .sort();
}

/** A scenario with no actions: every request gets the documented default. */
export function emptyScenario(name = 'default'): Scenario {
  return {
    name,
    flow: undefined,
    why: 'defaults only',
    golden: undefined,
    ignore: [],
    expect: [],
    send: [],
    actions: [],
  };
}

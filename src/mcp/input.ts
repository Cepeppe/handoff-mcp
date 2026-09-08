/**
 * Tool input parsing: shape inference and type guards (TECHNICAL-DESIGN §4.7.1, DD-07,
 * §4.7.3, §5.2 step 1).
 *
 * `handoff_to_user` takes **one flat object** and the server works out which of the three
 * calls was meant from the fields that are present: `spec` opens, `reply` (with
 * `handoff_id`) continues, `resume` re-attaches. A top-level `oneOf` would say it better,
 * but agent runtimes flatten or mishandle `oneOf` in tool schemas, so the shapes live in
 * the description and the discrimination lives here.
 *
 * Everything that is not exactly one well-formed shape is `SHAPE_AMBIGUOUS`, whose fix
 * text spells the three shapes out again. That covers a field borrowed from another shape
 * ("Nothing else may be combined with them"), a field the input schema does not declare,
 * and a control field whose type or bounds are wrong: none of those leave the server with
 * a call it can carry out, and the agent's next move is the same in every case. The one
 * exception is `spec` itself, which goes to the validation pipeline untouched so the agent
 * gets `SPEC_INVALID` with a problem per mistake instead of one flat refusal.
 *
 * Bounds and patterns are read out of the registered input schemas rather than written
 * again here, so the shape an agent is shown and the shape the server enforces cannot
 * drift. A schema that stops declaring one of them is a build failure, not a silent
 * default.
 */
import { catalogueFix, handoffError, type HandoffError } from '../format/errors';
import { HANDOFF_ID_RE } from '../ids';

import { TOOL_INPUT_SCHEMAS, type ToolName } from './generated/contract';

/** The seven fields of the flat input object, in the order §4.7.1 lists them. */
export const INPUT_FIELDS = [
  'spec',
  'request_id',
  'ignore_runbook',
  'handoff_id',
  'reply',
  'replacement_steps',
  'resume',
] as const;

export type InputField = (typeof INPUT_FIELDS)[number];

/** Which of the three calls of TOOL-01 the input describes. */
export type ShapeKind = 'open' | 'continue' | 'resume';

/** The field whose presence names the shape (§4.7.1: "exactly one of …"). */
const SHAPE_MARKER: Readonly<Record<ShapeKind, InputField>> = {
  open: 'spec',
  continue: 'reply',
  resume: 'resume',
};

/** What each shape may carry besides its marker. Anything else is ambiguous. */
const SHAPE_FIELDS: Readonly<Record<ShapeKind, readonly InputField[]>> = {
  open: ['spec', 'request_id', 'ignore_runbook'],
  continue: ['handoff_id', 'reply', 'replacement_steps'],
  resume: ['resume'],
};

/** One well-formed call, with the control fields already typed. */
export type CallShape =
  | {
      readonly kind: 'open';
      /** Unparsed: `validateSpec` owns the spec and writes its own problems. */
      readonly spec: unknown;
      readonly requestId: string | undefined;
      readonly ignoreRunbook: boolean;
    }
  | {
      readonly kind: 'continue';
      readonly handoffId: string;
      readonly reply: string;
      /** Unparsed: `validateReplacementSteps` needs the handoff's value keys (T-020). */
      readonly replacementSteps: readonly unknown[] | undefined;
    }
  | { readonly kind: 'resume'; readonly handoffId: string };

export type ShapeInference =
  | { readonly ok: true; readonly shape: CallShape }
  | { readonly ok: false; readonly error: HandoffError };

// ------------------------------------------------------------- limits of the schema

/** The `properties` map of a registered input schema, or a contract that has to be fixed. */
function properties(tool: ToolName): Record<string, unknown> {
  const found = (TOOL_INPUT_SCHEMAS[tool] as { properties?: unknown }).properties;
  if (typeof found !== 'object' || found === null) {
    throw new Error(`the registered input schema of ${tool} declares no properties`);
  }
  return found as Record<string, unknown>;
}

/** One keyword of one declared field, checked at import so a drift cannot go unnoticed. */
function keyword(tool: ToolName, field: string, name: string): unknown {
  const schema = properties(tool)[field];
  const value =
    typeof schema === 'object' && schema !== null
      ? (schema as Record<string, unknown>)[name]
      : undefined;
  if (value === undefined) {
    throw new Error(`the registered input schema of ${tool} declares no ${field}.${name}`);
  }
  return value;
}

function numberKeyword(tool: ToolName, field: string, name: string): number {
  const value = keyword(tool, field, name);
  if (typeof value !== 'number') {
    throw new Error(`${tool}.${field}.${name} is not a number in the registered input schema`);
  }
  return value;
}

/**
 * The same, one level down: `verify.detail` is declared inside its parent object, so the
 * bound the server enforces is still read out of the registered schema rather than written
 * here a second time.
 */
function nestedNumberKeyword(tool: ToolName, field: string, child: string, name: string): number {
  const parent = properties(tool)[field];
  const nested =
    typeof parent === 'object' && parent !== null
      ? (parent as { properties?: unknown }).properties
      : undefined;
  const schema =
    typeof nested === 'object' && nested !== null
      ? (nested as Record<string, unknown>)[child]
      : undefined;
  const value =
    typeof schema === 'object' && schema !== null
      ? (schema as Record<string, unknown>)[name]
      : undefined;
  if (typeof value !== 'number') {
    throw new Error(`the registered input schema of ${tool} declares no ${field}.${child}.${name}`);
  }
  return value;
}

function patternKeyword(tool: ToolName, field: string): RegExp {
  const value = keyword(tool, field, 'pattern');
  if (typeof value !== 'string') {
    throw new Error(`${tool}.${field}.pattern is not a string in the registered input schema`);
  }
  return new RegExp(value, 'u');
}

/** §4.7.1: the reply is 1 to 4000 characters, as the registered schema declares it. */
export const REPLY_MIN_LENGTH: number = numberKeyword('handoff_to_user', 'reply', 'minLength');
export const REPLY_MAX_LENGTH: number = numberKeyword('handoff_to_user', 'reply', 'maxLength');

/** §4.7.3: `where` and `goal` are 1 to 300 characters. */
export const QUERY_MIN_LENGTH: number = numberKeyword('handoff_runbooks', 'where', 'minLength');
export const QUERY_MAX_LENGTH: number = numberKeyword('handoff_runbooks', 'where', 'maxLength');

/** §4.7.3: the BCP-47 shape the tool accepts for `lang`. */
export const LANG_PATTERN: RegExp = patternKeyword('handoff_runbooks', 'lang');

/**
 * The id pattern of the three control fields that carry one. It is the same shape
 * `src/ids.ts` generates and the same one the registered schema declares; the contract
 * test asserts the two agree rather than letting this module choose.
 */
const HANDOFF_ID_FIELDS = ['request_id', 'handoff_id', 'resume'] as const;

export const REGISTERED_HANDOFF_ID_PATTERNS: readonly RegExp[] = HANDOFF_ID_FIELDS.map((field) =>
  patternKeyword('handoff_to_user', field),
);

// ------------------------------------------------------------------ shape inference

/** Builds the one error this module produces, with the catalogue's fix text. */
function ambiguous(problem: string, path = ''): HandoffError {
  return handoffError('SHAPE_AMBIGUOUS', [{ path, problem, fix: catalogueFix('SHAPE_AMBIGUOUS') }]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A field counts as sent when the key is there with anything but `undefined`. `null` is
 * "sent, and wrong": an agent writing `"resume": null` meant a shape, and being told which
 * one it looks like beats being told it named none.
 */
function present(input: Record<string, unknown>, field: string): boolean {
  return Object.hasOwn(input, field) && input[field] !== undefined;
}

/** A handoff or request id: the shape of §4.1 (`src/ids.ts`). */
function isHandoffId(value: unknown): value is string {
  return typeof value === 'string' && HANDOFF_ID_RE.test(value);
}

/** `a`, `a and b`, `a, b and c` — field names only, never their values (R-19). */
function list(names: readonly string[]): string {
  const last = names.at(-1);
  if (names.length <= 1 || last === undefined) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${last}`;
}

/** The open shape: a spec, optionally linked to a user request and skipping the safety net. */
function openShape(input: Record<string, unknown>): ShapeInference {
  let requestId: string | undefined;
  if (present(input, 'request_id')) {
    const value = input['request_id'];
    if (!isHandoffId(value)) {
      return { ok: false, error: ambiguous('request_id is not a handoff id.', 'request_id') };
    }
    requestId = value;
  }

  let ignoreRunbook = false;
  if (present(input, 'ignore_runbook')) {
    const value = input['ignore_runbook'];
    if (typeof value !== 'boolean') {
      return { ok: false, error: ambiguous('ignore_runbook is not a boolean.', 'ignore_runbook') };
    }
    ignoreRunbook = value;
  }

  return { ok: true, shape: { kind: 'open', spec: input['spec'], requestId, ignoreRunbook } };
}

/** The continue shape: an answer on the current step, optionally correcting the rest. */
function continueShape(input: Record<string, unknown>): ShapeInference {
  if (!present(input, 'handoff_id')) {
    return {
      ok: false,
      error: ambiguous('The continue shape needs handoff_id next to reply.', 'handoff_id'),
    };
  }
  const handoffId = input['handoff_id'];
  if (!isHandoffId(handoffId)) {
    return { ok: false, error: ambiguous('handoff_id is not a handoff id.', 'handoff_id') };
  }

  const reply = input['reply'];
  if (
    typeof reply !== 'string' ||
    reply.length < REPLY_MIN_LENGTH ||
    reply.length > REPLY_MAX_LENGTH
  ) {
    return {
      ok: false,
      error: ambiguous(
        `reply is not a string of ${String(REPLY_MIN_LENGTH)} to ${String(REPLY_MAX_LENGTH)} characters.`,
        'reply',
      ),
    };
  }

  let replacementSteps: readonly unknown[] | undefined;
  if (present(input, 'replacement_steps')) {
    const value = input['replacement_steps'];
    if (!Array.isArray(value)) {
      return {
        ok: false,
        error: ambiguous('replacement_steps is not an array of steps.', 'replacement_steps'),
      };
    }
    replacementSteps = value as readonly unknown[];
  }

  return { ok: true, shape: { kind: 'continue', handoffId, reply, replacementSteps } };
}

/** The resume shape: an id and nothing else, from any session of this installation. */
function resumeShape(input: Record<string, unknown>): ShapeInference {
  const resume = input['resume'];
  if (!isHandoffId(resume)) {
    return { ok: false, error: ambiguous('resume is not a handoff id.', 'resume') };
  }
  return { ok: true, shape: { kind: 'resume', handoffId: resume } };
}

/**
 * Which of the three calls this input is, or why it is none of them.
 *
 * The marker fields are counted first, because "which shape did you mean" is the question
 * an agent has to answer before any field can be judged: a call carrying both `spec` and
 * `resume` has no right reading, and complaining about one of its fields would send the
 * agent to fix the wrong thing.
 */
export function inferShape(input: unknown): ShapeInference {
  if (!isRecord(input)) {
    return { ok: false, error: ambiguous('The tool arguments are not a JSON object.') };
  }

  const kinds = (Object.keys(SHAPE_MARKER) as ShapeKind[]).filter((kind) =>
    present(input, SHAPE_MARKER[kind]),
  );
  const kind = kinds[0];
  if (kind === undefined) {
    return {
      ok: false,
      error: ambiguous('The call carries none of spec, reply or resume, so it names no shape.'),
    };
  }
  if (kinds.length > 1) {
    const markers = kinds.map((each) => SHAPE_MARKER[each]);
    return {
      ok: false,
      error: ambiguous(`The call carries ${list(markers)}, so it names more than one shape.`),
    };
  }

  const allowed = SHAPE_FIELDS[kind];
  const foreign = Object.keys(input)
    .filter((name) => present(input, name) && !allowed.includes(name as InputField))
    .sort();
  if (foreign.length > 0) {
    return { ok: false, error: ambiguous(`The ${kind} shape does not take ${list(foreign)}.`) };
  }

  if (kind === 'open') return openShape(input);
  if (kind === 'continue') return continueShape(input);
  return resumeShape(input);
}

// ---------------------------------------------------------------- handoff_verify input

/** §4.7.2: the verification report, once it is known to be well formed. */
export interface VerifyInput {
  readonly handoffId: string;
  readonly ok: boolean | null;
  readonly detail: string;
}

export type VerifyParse =
  | { readonly ok: true; readonly input: VerifyInput }
  | { readonly ok: false; readonly problem: string };

/** §4.7.2: `verify.detail` is 1 to 4000 characters, as the registered schema declares it. */
export const DETAIL_MIN_LENGTH: number = nestedNumberKeyword(
  'handoff_verify',
  'verify',
  'detail',
  'minLength',
);
export const DETAIL_MAX_LENGTH: number = nestedNumberKeyword(
  'handoff_verify',
  'verify',
  'detail',
  'maxLength',
);

/**
 * `handoff_verify` has one shape, so arguments that do not fit its registered schema are a
 * protocol violation rather than one of the catalogue's errors, exactly as for
 * `handoff_runbooks`: the caller turns this message into the MCP `Invalid params` that layer
 * is for. `NO_VERIFY_IN_SPEC` and `HANDOFF_NOT_FOUND` are answers about a handoff and stay
 * in the catalogue; a `verify` that is not an object is not about a handoff at all.
 *
 * The message names fields and limits, never a value: a `detail` can quote what the agent
 * observed, and that is not something to echo into an error (R-19).
 */
export function parseVerifyInput(input: unknown): VerifyParse {
  if (!isRecord(input)) return { ok: false, problem: 'the arguments are not a JSON object' };

  const unknownFields = Object.keys(input)
    .filter((name) => name !== 'handoff_id' && name !== 'verify')
    .sort();
  if (unknownFields.length > 0) {
    return { ok: false, problem: `handoff_verify has no field ${list(unknownFields)}` };
  }

  const handoffId = input['handoff_id'];
  if (!isHandoffId(handoffId)) {
    return { ok: false, problem: 'handoff_id is not a handoff id' };
  }

  const verify = input['verify'];
  if (!isRecord(verify)) return { ok: false, problem: 'verify is not an object' };
  const strayVerifyFields = Object.keys(verify)
    .filter((name) => name !== 'ok' && name !== 'detail')
    .sort();
  if (strayVerifyFields.length > 0) {
    return { ok: false, problem: `verify has no field ${list(strayVerifyFields)}` };
  }

  const ok = verify['ok'];
  if (typeof ok !== 'boolean' && ok !== null) {
    return { ok: false, problem: 'verify.ok is not true, false or null' };
  }

  const detail = verify['detail'];
  if (
    typeof detail !== 'string' ||
    detail.length < DETAIL_MIN_LENGTH ||
    detail.length > DETAIL_MAX_LENGTH
  ) {
    return {
      ok: false,
      problem: `verify.detail must be a string of ${String(DETAIL_MIN_LENGTH)} to ${String(DETAIL_MAX_LENGTH)} characters`,
    };
  }

  return { ok: true, input: { handoffId, ok, detail } };
}

// -------------------------------------------------------------- handoff_runbooks input

/** The three inputs of `handoff_runbooks` (§4.7.3), once they are known to be well formed. */
export interface RunbooksQuery {
  readonly where: string;
  readonly goal: string;
  readonly lang?: string;
}

export type QueryParse =
  | { readonly ok: true; readonly query: RunbooksQuery }
  | { readonly ok: false; readonly problem: string };

/**
 * `handoff_runbooks` has one shape, so arguments that do not fit its registered schema are
 * a protocol violation rather than one of the catalogue's errors; the caller turns this
 * message into the MCP `Invalid params` the transport is meant to carry. The message names
 * fields and limits, never a value.
 */
export function parseRunbooksQuery(input: unknown): QueryParse {
  if (!isRecord(input)) return { ok: false, problem: 'the arguments are not a JSON object' };

  const bounded = (field: 'where' | 'goal'): string | null => {
    const value = input[field];
    if (
      typeof value !== 'string' ||
      value.length < QUERY_MIN_LENGTH ||
      value.length > QUERY_MAX_LENGTH
    ) {
      return null;
    }
    return value;
  };

  const where = bounded('where');
  const goal = bounded('goal');
  const bad = [where === null ? 'where' : '', goal === null ? 'goal' : ''].filter((n) => n !== '');
  if (where === null || goal === null) {
    return {
      ok: false,
      problem: `${list(bad)} must be a string of ${String(QUERY_MIN_LENGTH)} to ${String(QUERY_MAX_LENGTH)} characters`,
    };
  }

  const unknownFields = Object.keys(input)
    .filter((name) => name !== 'where' && name !== 'goal' && name !== 'lang')
    .sort();
  if (unknownFields.length > 0) {
    return { ok: false, problem: `handoff_runbooks has no field ${list(unknownFields)}` };
  }

  if (!present(input, 'lang')) return { ok: true, query: { where, goal } };
  const lang = input['lang'];
  if (typeof lang !== 'string' || !LANG_PATTERN.test(lang)) {
    return { ok: false, problem: 'lang is not a BCP-47 language tag' };
  }
  return { ok: true, query: { where, goal, lang } };
}

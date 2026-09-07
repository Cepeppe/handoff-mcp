/**
 * The error object every tool and the `validate` CLI return (TECHNICAL-DESIGN §4.7.5).
 *
 * An error is the JSON `{ "error": { code, message, problems: [{ path, problem, fix }] } }`.
 * `message` and, for every code except `SPEC_INVALID`, `fix` come from the generated tool
 * contract, so the catalogue has one source and cannot drift from the published document.
 * `SPEC_INVALID` is the exception the catalogue itself names: its `fix` is written per
 * problem by the validation pipeline, because a missing field, a broken limit and a bad URL
 * scheme each need their own sentence.
 *
 * Errors never carry spec values: they cite paths, field names, limits and expected shapes
 * only (§4.7.5, R-19).
 */
import { ERROR_TEXTS, type ErrorCode } from '../mcp/generated/contract';

export type { ErrorCode };

/** One thing that is wrong, where it is, and what to do about it. */
export interface Problem {
  /** Display path of the offending location: `goal`, `steps[0].text`, `values.events[0]`. */
  readonly path: string;
  /** What is wrong at that path. */
  readonly problem: string;
  /** What the agent should do about it. */
  readonly fix: string;
}

/** The error an agent receives, and what `handoff-mcp validate` prints. */
export interface HandoffError {
  readonly code: ErrorCode;
  readonly message: string;
  readonly problems: readonly Problem[];
}

/** The wire shape: the error is nested under a single `error` key. */
export interface HandoffErrorPayload {
  readonly error: HandoffError;
}

/** Builds an error with problems written by the caller (the `SPEC_INVALID` case). */
export function handoffError(code: ErrorCode, problems: readonly Problem[]): HandoffError {
  return { code, message: ERROR_TEXTS[code].message, problems };
}

/**
 * The single fix sentence of a code, for the eleven codes that have one.
 *
 * `SPEC_INVALID` is the twelfth and does not: asking for its fix is a programming error.
 */
export function catalogueFix(code: ErrorCode): string {
  const fix = ERROR_TEXTS[code].fix;
  if (fix === null) {
    throw new Error(`${code} writes a fix per problem; use handoffError instead`);
  }
  return fix;
}

/**
 * Builds an error whose fix is the one sentence the catalogue gives for that code.
 *
 * `path` names the input field the agent should look at (`handoff_id`, `resume`, …); it is
 * empty when the error is about the call rather than about a field.
 */
export function catalogueError(code: ErrorCode, path = ''): HandoffError {
  const message = ERROR_TEXTS[code].message;
  return { code, message, problems: [{ path, problem: message, fix: catalogueFix(code) }] };
}

/** Wraps an error in the object that travels in the tool result and on stdout. */
export function toErrorPayload(error: HandoffError): HandoffErrorPayload {
  return { error };
}

/** The exact text `handoff-mcp validate` prints and the tool result carries. */
export function errorJson(error: HandoffError): string {
  return JSON.stringify(toErrorPayload(error), null, 2);
}

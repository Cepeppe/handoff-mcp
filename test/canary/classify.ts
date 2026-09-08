/**
 * Protocol failure or model behaviour (T-023, TECHNICAL-DESIGN §11.5 "Model
 * non-determinism ... a classifier that separates protocol failures (a gate) from
 * model-behaviour failures (an alert)").
 *
 * The distinction is not a guess about severity, it is a question about *what was
 * observed*, and it has one operational consequence: a model failure is retried once, a
 * protocol failure never is. Retrying a protocol failure would only buy a second identical
 * red, and — worse — a flaky retry could hide a real regression behind a lucky run.
 *
 * The rule:
 *
 * - **protocol** — the shape of the run is wrong: the agent could not start, the server did
 *   not register, an observation the server writes without the model's help is missing or
 *   says the wrong thing, a tool result carried the wrong `status`. Nothing a different
 *   sampling of the model would change.
 * - **model** — the run was well formed and the model did not do what the prompt asked: it
 *   never called the tool, called it with something the schema rejects, or ran out of turns
 *   while doing something else.
 *
 * An assertion declares its own kind, because only the assertion knows which of the two it
 * looked at. `classify` is the summary over a list of them: a run with even one protocol
 * failure is a protocol failure, because that is the one that must not be retried.
 */

/** What a failing assertion looked at. */
export type FailureKind = 'protocol' | 'model';

/** One thing a scenario checked, and what it found. */
export interface Assertion {
  /** The assumption or scenario id this belongs to, `A-01`, `E2E-8`, … */
  readonly id: string;
  /** What was checked, in one line, in the present tense. */
  readonly what: string;
  readonly ok: boolean;
  /** Which half of §11.5 a failure here belongs to. Meaningless when `ok`. */
  readonly kind: FailureKind;
  /**
   * An observation the design does not depend on, so its failure is reported and does not
   * decide the verdict. A-09 is the one Appendix B marks that way itself ("informational";
   * the design's fallback is "not relied on: the heartbeat detaches the call").
   */
  readonly informational?: boolean;
  /** What was actually seen, for the report. Never a spec value. */
  readonly detail?: string;
}

/** The verdict over one run of one scenario. */
export type RunVerdict = 'passed' | 'protocol' | 'model';

/**
 * The verdict of a list of assertions: `passed` when none failed, `protocol` when at least
 * one protocol assertion failed, `model` when the only failures were model ones.
 */
export function classify(assertions: readonly Assertion[]): RunVerdict {
  const failed = assertions.filter(
    (assertion) => !assertion.ok && assertion.informational !== true,
  );
  if (failed.length === 0) return 'passed';
  return failed.some((assertion) => assertion.kind === 'protocol') ? 'protocol' : 'model';
}

/** Whether §11.5's single retry applies: model failures only, and only once. */
export function shouldRetry(verdict: RunVerdict, attempt: number): boolean {
  return verdict === 'model' && attempt === 1;
}

/** The failures of a run, most useful first: protocol before model, in assertion order. */
export function failures(assertions: readonly Assertion[]): Assertion[] {
  const failed = assertions.filter(
    (assertion) => !assertion.ok && assertion.informational !== true,
  );
  return [
    ...failed.filter((assertion) => assertion.kind === 'protocol'),
    ...failed.filter((assertion) => assertion.kind === 'model'),
  ];
}

/** Builds a passing or failing assertion in one call, so a scenario reads as a list. */
export function check(
  id: string,
  what: string,
  kind: FailureKind,
  ok: boolean,
  detail?: string,
): Assertion {
  return { id, what, kind, ok, ...(detail === undefined ? {} : { detail }) };
}

/** The same, for an observation that is recorded but never decides a verdict (A-09). */
export function note(id: string, what: string, ok: boolean, detail?: string): Assertion {
  return {
    id,
    what,
    kind: 'protocol',
    ok,
    informational: true,
    ...(detail === undefined ? {} : { detail }),
  };
}

/** Every failing assertion, including the informational ones, for the report. */
export function reported(assertions: readonly Assertion[]): Assertion[] {
  return assertions.filter((assertion) => !assertion.ok);
}

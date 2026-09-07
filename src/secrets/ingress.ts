/**
 * The certain detector at ingress (TECHNICAL-DESIGN §5.5, SPEC-13, DET-04).
 *
 * Every string a spec carries as content is scanned with the public patterns: the values
 * (array items included), `goal`, `where`, `why_human`, `verify` and each step's `text` and
 * `warning`. A match is never an error — an agent told "your spec is invalid" would only
 * send it again — and it never removes anything from the spec that travels on: the app
 * receives the spec unchanged, because the copy button must copy the true value (DET-04),
 * and the accompanying `secret_treated` list is what makes it mask the value on screen.
 *
 * What leaves this module is a location and a family, never the matched text (R-19). The
 * spans stay here, where masking needs them: `SecretSpan` is internal to the server and
 * `SecretTreated` is the wire shape of the outcome field, which the schema pins to exactly
 * those two keys.
 *
 * Text mode is the one place where the spec itself is rewritten (§5.9): the rendered text
 * goes into the chat, so a secret in it would reach the transcript the design keeps it out
 * of. `maskSpecForText` builds that masked copy, and only that copy.
 */
import { childPath } from '../format/paths';
import type { HandoffSpec, HandoffStep, SpecValue } from '../format/types';
import { scanText, type CertainSecretKind } from './patterns';

/** One certain secret found at ingress: where it is, and which family it belongs to. */
export interface SecretTreated {
  /** Display path of the string it was found in, e.g. `values.api_key`, `steps[1].text`. */
  readonly location: string;
  /** The family of the pattern that matched, never the pattern id (§4.6). */
  readonly kind: CertainSecretKind;
}

/**
 * A hit with the span it occupies inside its string.
 *
 * Server-internal: the outcome's `secret_treated` is `SecretTreated`, and the outcome
 * schema forbids any other key.
 */
export interface SecretSpan extends SecretTreated {
  readonly start: number;
  readonly end: number;
}

/** What a masked secret reads as in text mode (§5.9). */
export function secretMask(kind: CertainSecretKind): string {
  return `[treated as secret: ${kind}]`;
}

/** Every hit in one string, tagged with the location that string has in the spec. */
function spansIn(location: string, text: string): SecretSpan[] {
  return scanText(text).map((match) => ({
    location,
    kind: match.kind,
    start: match.start,
    end: match.end,
  }));
}

/** One entry of `values`: a string, or a list whose items are located by index. */
function valueSpans(key: string, value: SpecValue): SecretSpan[] {
  const path = childPath('values', key);
  if (typeof value === 'string') return spansIn(path, value);
  return value.flatMap((item, index) => spansIn(childPath(path, index), item));
}

/**
 * Every certain secret in a spec, with its span, in the field order of §5.5.
 *
 * `url` and `steps[].url` are deliberately not scanned: the design lists the fields, and a
 * URL is already confined to the three allowed schemes (S5). A Slack webhook URL sent as a
 * value or written into a step text is caught, which is where it is put in practice.
 */
export function scanSpecSpans(spec: HandoffSpec): SecretSpan[] {
  const found: SecretSpan[] = [];
  for (const [key, value] of Object.entries(spec.values)) found.push(...valueSpans(key, value));
  found.push(...spansIn('goal', spec.goal));
  found.push(...spansIn('where', spec.where));
  found.push(...spansIn('why_human', spec.why_human));
  if (spec.verify !== undefined) found.push(...spansIn('verify', spec.verify));
  spec.steps.forEach((step, index) => {
    const at = childPath('steps', index);
    found.push(...spansIn(childPath(at, 'text'), step.text));
    if (step.warning !== undefined) found.push(...spansIn(childPath(at, 'warning'), step.warning));
  });
  return found;
}

/** Drops the spans, leaving the shape the outcome and `handoff.open` carry. */
export function toSecretTreated(spans: readonly SecretSpan[]): SecretTreated[] {
  return spans.map(({ location, kind }) => ({ location, kind }));
}

/** Every certain secret in a spec, as the outcome reports it (§4.3 `secret_treated`). */
export function scanSpec(spec: HandoffSpec): SecretTreated[] {
  return toSecretTreated(scanSpecSpans(spec));
}

/** Replaces the spans of one string, from the end so earlier offsets stay valid. */
function maskString(text: string, spans: readonly SecretSpan[]): string {
  let masked = text;
  for (const span of [...spans].sort((a, b) => b.start - a.start)) {
    masked = masked.slice(0, span.start) + secretMask(span.kind) + masked.slice(span.end);
  }
  return masked;
}

/**
 * A copy of the spec with every matched span replaced by `[treated as secret: <kind>]`.
 *
 * The argument is never modified: the spec object that goes to the app, to the log and to
 * the copy button is the one the agent sent (DET-04). Only the span is replaced, not the
 * whole field, so a step that says "paste sk_live_… into .env" keeps its instruction and
 * loses only the secret.
 */
export function maskSpecForText(spec: HandoffSpec, treated: readonly SecretSpan[]): HandoffSpec {
  const byLocation = new Map<string, SecretSpan[]>();
  for (const span of treated) {
    const at = byLocation.get(span.location);
    if (at === undefined) byLocation.set(span.location, [span]);
    else at.push(span);
  }
  const mask = (location: string, text: string): string =>
    maskString(text, byLocation.get(location) ?? []);

  const values: Record<string, SpecValue> = {};
  for (const [key, value] of Object.entries(spec.values)) {
    const path = childPath('values', key);
    values[key] =
      typeof value === 'string'
        ? mask(path, value)
        : value.map((item, index) => mask(childPath(path, index), item));
  }

  const steps: HandoffStep[] = spec.steps.map((step, index) => {
    const at = childPath('steps', index);
    return {
      ...step,
      text: mask(childPath(at, 'text'), step.text),
      ...(step.warning === undefined
        ? {}
        : { warning: mask(childPath(at, 'warning'), step.warning) }),
    };
  });

  return {
    ...spec,
    goal: mask('goal', spec.goal),
    where: mask('where', spec.where),
    why_human: mask('why_human', spec.why_human),
    values,
    steps,
    ...(spec.verify === undefined ? {} : { verify: mask('verify', spec.verify) }),
  };
}

/**
 * Conversion of a runbook to a draft spec (TECHNICAL-DESIGN §4.5.4, DD-19, RUN-05).
 *
 * `{{name}}` in step texts, warnings and `verify` becomes `[name]`; every name found is
 * added to that step's `values`; `draft_spec.values` maps each name to `""` and
 * `values_to_fill` maps each name to its description. The draft is deliberately **not**
 * valid: the empty strings fail S6, so an agent cannot open a handoff with blanks or with
 * placeholders left in it. Annotations travel beside the draft, never inside it.
 *
 * Two shapes the design leaves implicit and that this module settles, because a draft that
 * contradicts the spec schema would be useless to the agent it is offered to:
 *
 * - A runbook field that is `null` is **omitted** from the draft rather than sent as null:
 *   the spec schema has no nullable field, so `url: null` would fail it. The same goes for
 *   a step's `values` when the step has no placeholder, which the spec schema requires to
 *   be absent rather than empty (`minItems: 1`).
 * - `draft_spec.values` carries the union of the runbook's declared value names and any
 *   name found in a placeholder. A placeholder that no declared value covers would
 *   otherwise make the step cite a key that `values` does not declare, which is S3 — an
 *   error the agent has no way to fix.
 *
 * A `{{…}}` whose content is not a value name is left exactly as it is. It cannot become a
 * `values` key, and leaving it in makes the validator report it as the residual placeholder
 * it is (S4) instead of quietly turning a malformed runbook into a plausible-looking spec.
 */
import { SUPPORTED_SPEC_VERSION, VALUE_NAME_PATTERN } from '../format/schema';
import type { HandoffSpec, HandoffStep } from '../format/types';

import type { Runbook, RunbookAnnotation, RunbookMatch, RunbookStep, StoredRunbook } from './types';

/**
 * `{{name}}` where `name` is a value name. The inner shape is the schema's own
 * `value_name` pattern with its anchors removed, so the two can never drift apart.
 */
const PLACEHOLDER = new RegExp(`\\{\\{(${VALUE_NAME_PATTERN.slice(1, -1)})\\}\\}`, 'gu');

/** The value the draft gives every name: what makes it fail S6 until the agent fills it. */
const UNFILLED = '';

/** A text with its placeholders turned into markers, and the names they carried. */
interface Converted {
  readonly text: string;
  readonly names: readonly string[];
}

function convertText(text: string): Converted {
  const names: string[] = [];
  const converted = text.replaceAll(PLACEHOLDER, (_match: string, name: string): string => {
    if (!names.includes(name)) names.push(name);
    return `[${name}]`;
  });
  return { text: converted, names };
}

/**
 * One step of the draft, in the field order of the spec schema.
 *
 * The names come from the placeholders actually found, in the order they appear in the
 * text and then in the warning; the runbook's own `values` array is not copied, because
 * DD-19 defines the draft's `values` as what the conversion found.
 */
function convertStep(step: RunbookStep): { readonly step: HandoffStep; readonly names: string[] } {
  const text = convertText(step.text);
  const warning = step.warning === null ? null : convertText(step.warning);
  const names = [...new Set([...text.names, ...(warning?.names ?? [])])];
  return {
    step: {
      text: text.text,
      ...(step.url === null ? {} : { url: step.url }),
      ...(names.length === 0 ? {} : { values: names }),
      ...(warning === null ? {} : { warning: warning.text }),
    },
    names,
  };
}

/** What a conversion produces beyond the header fields of the outcome item. */
export interface ConvertedRunbook {
  readonly draft_spec: HandoffSpec;
  readonly values_to_fill: Readonly<Record<string, string | null>>;
  readonly annotations: readonly RunbookAnnotation[];
}

/**
 * Converts one runbook (§4.5.4).
 *
 * The annotations of every step are flattened in step order and then in their own order:
 * the outcome carries them beside the draft, and the item of §4.3 has one flat list.
 */
export function convertRunbook(runbook: Runbook): ConvertedRunbook {
  const converted = runbook.steps.map(convertStep);
  const verify = runbook.verify === null ? null : convertText(runbook.verify);

  const names = [
    ...new Set([
      ...Object.keys(runbook.values),
      ...converted.flatMap((step) => step.names),
      ...(verify?.names ?? []),
    ]),
  ];

  const values: Record<string, string> = {};
  const valuesToFill: Record<string, string | null> = {};
  for (const name of names) {
    values[name] = UNFILLED;
    valuesToFill[name] = runbook.values[name]?.description ?? null;
  }

  const draftSpec: HandoffSpec = {
    spec_version: SUPPORTED_SPEC_VERSION,
    goal: runbook.goal,
    where: runbook.where,
    ...(runbook.url === null ? {} : { url: runbook.url }),
    why_human: runbook.why_human,
    values,
    ...(Object.keys(runbook.secrets).length === 0 ? {} : { secrets: { ...runbook.secrets } }),
    steps: converted.map((step) => step.step),
    ...(verify === null ? {} : { verify: verify.text }),
    ...(runbook.lang === null ? {} : { lang: runbook.lang }),
  };

  return {
    draft_spec: draftSpec,
    values_to_fill: valuesToFill,
    annotations: runbook.steps.flatMap((step) => step.annotations),
  };
}

/**
 * One item of the outcome's `runbooks[]` (§4.3), in the field order the schema declares.
 */
export function toRunbookMatch(
  stored: StoredRunbook,
  matchedWords: readonly string[],
): RunbookMatch {
  const { runbook } = stored;
  const converted = convertRunbook(runbook);
  return {
    id: runbook.id,
    path: stored.path,
    where: runbook.where,
    goal: runbook.goal,
    trust: runbook.trust,
    last_verified_at: runbook.last_verified_at,
    last_run_failed_at: runbook.last_run_failed_at,
    runs: runbook.runs,
    matched_words: matchedWords,
    draft_spec: converted.draft_spec,
    values_to_fill: converted.values_to_fill,
    annotations: converted.annotations,
  };
}

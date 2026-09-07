/**
 * The `text_mode` outcome (TECHNICAL-DESIGN §4.3, §5.9, SRV-14..16, ARCH-04).
 *
 * The one outcome the server produces entirely on its own: no app answered, so there is no
 * handoff, no round to advance and nothing to resume. `handoff_id` is null and
 * `app_reachable` is false, which is how an agent tells this apart from every other
 * outcome; every remaining field is still present, empty or null, because an agent must
 * never branch on absence (TOOL-13).
 *
 * The instruction comes from the generated tool contract, not from a literal here: the
 * contract document is the normative source of the sentence and the drift test keeps the
 * two together. Remote agents reach this path with no extra code (SRV-16, ADPT-07).
 */
import { INSTRUCTIONS, STATUS_FINAL, type HookVariant } from '../mcp/generated/contract';
import type { HandoffSpec } from '../format/types';
import { maskSpecForText, scanSpecSpans, toSecretTreated, type SecretTreated } from '../secrets';
import { renderSpecText } from './render';

/**
 * The outcome returned when the app is unreachable.
 *
 * The fields that cannot vary in this mode are typed with the value they hold, including
 * the three lists that are always empty: there is no state anywhere to fill them from. The
 * general outcome type belongs to the outcome builder (T-017).
 */
export interface TextModeOutcome {
  readonly outcome_version: 1;
  readonly handoff_id: null;
  readonly status: 'text_mode';
  readonly final: boolean;
  readonly instruction: string;
  readonly round: 1;
  readonly current_step: null;
  readonly user_text: null;
  readonly screenshot: null;
  readonly context: null;
  readonly skipped_steps: readonly [];
  readonly notes: readonly [];
  readonly secret_treated: readonly SecretTreated[];
  readonly verify: null;
  readonly deferral_count: 0;
  readonly resumed_from: null;
  readonly app_reachable: false;
  readonly already_delivered: false;
  readonly runbooks: readonly [];
  readonly spec_text: string;
}

/**
 * Builds the `text_mode` outcome for a spec that passed validation.
 *
 * Scan once, then report and mask from the same hits: the outcome tells the agent which
 * locations were treated, and `spec_text` carries the masked copy while the spec the caller
 * holds stays untouched (DET-04).
 *
 * `hookVariant` comes from the session's capability row (§5.6). Both variants of this
 * status read the same today; passing it keeps the choice where the contract makes it.
 */
export function textModeOutcome(spec: HandoffSpec, hookVariant: HookVariant): TextModeOutcome {
  const spans = scanSpecSpans(spec);
  return {
    outcome_version: 1,
    handoff_id: null,
    status: 'text_mode',
    final: STATUS_FINAL.text_mode,
    instruction: INSTRUCTIONS.text_mode[hookVariant],
    round: 1,
    current_step: null,
    user_text: null,
    screenshot: null,
    context: null,
    skipped_steps: [],
    notes: [],
    secret_treated: toSecretTreated(spans),
    verify: null,
    deferral_count: 0,
    resumed_from: null,
    app_reachable: false,
    already_delivered: false,
    runbooks: [],
    spec_text: renderSpecText(maskSpecForText(spec, spans)),
  };
}

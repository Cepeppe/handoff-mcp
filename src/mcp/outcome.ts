/**
 * Outcomes and how they become MCP tool results (TECHNICAL-DESIGN §4.3, §4.7.4, §4.7.5).
 *
 * Three things happen here and nowhere else.
 *
 * 1. **The instruction is the server's, not the app's.** Whatever produced the outcome, the
 *    sentence the agent reads comes from the generated tool contract: the status picks the
 *    text, the session's capability row picks the Stop-hook variant (§4.7.4), and `<id>` is
 *    replaced with the handoff id. `final` is taken from the same table. An outcome that
 *    travelled over the channel therefore cannot carry an instruction the published
 *    contract does not have, and the app never has to know which variant a session gets.
 * 2. **The image block is gated twice.** `content[1]` exists only when the user actually
 *    sent an image *and* the client can display one (`images_in_results`). A client that
 *    cannot is offered the text path instead and the outcome says `image_attached: false`.
 * 3. **Outcomes are never `isError`.** `failed`, `abandoned` and `not_verified` are
 *    results, not faults; only the catalogue errors of §4.7.5 set the flag.
 *
 * The `outputSchema` the tools register is the published outcome schema with the spec
 * schema **bundled into it** as an embedded resource, so the one `$ref` that points at a
 * sibling file resolves without a network fetch on the client. Nothing else about the
 * published schema changes, and a contract test validates the fourteen outcome fixtures
 * through the bundled copy.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import outcomeSchema from '../../schemas/handoff-outcome.v1.schema.json';
import specSchema from '../../schemas/handoff-spec.v1.schema.json';
import type { ResolvedCapabilityRow } from '../adapters';
import type { ChannelFailure } from '../channel';
import { catalogueFix, errorJson, type HandoffError } from '../format/errors';
import type { RunbookMatch } from '../runbooks';
import type { SecretTreated } from '../secrets';

import {
  ERROR_TEXTS,
  ID_PLACEHOLDER,
  INSTRUCTIONS,
  OUTCOME_STATUSES,
  STATUS_FINAL,
  type HookVariant,
  type JsonSchema,
  type OutcomeStatus,
} from './generated/contract';

// ------------------------------------------------------------------ the outcome shape

/** `{ index, total, text }`: the step the overlay is showing, 1-based like its counter. */
export interface OutcomeStep {
  readonly index: number;
  readonly total: number;
  readonly text: string;
}

/** What the user sent, and how (§4.3). `text` is null when the image itself travelled. */
export interface OutcomeScreenshot {
  readonly mode: 'image' | 'text';
  readonly text: string | null;
  readonly image_attached: boolean;
  readonly width: number;
  readonly height: number;
  readonly redactions: number;
  readonly ocr_engine: string | null;
}

/** Enough of the handoff for the agent to answer on the right step (CTX-01). */
export interface OutcomeContext {
  readonly goal: string;
  readonly where: string;
  readonly step: OutcomeStep & { readonly url: string | null; readonly warning: string | null };
  readonly step_values: Readonly<Record<string, string | readonly string[]>>;
}

export interface OutcomeNote {
  readonly step: number;
  readonly text: string;
  readonly at: string;
}

export interface OutcomeVerify {
  readonly ok: boolean | null;
  readonly detail: string | null;
  readonly reported_at: string;
  readonly late: boolean;
}

export interface ResumedFrom {
  readonly agent: string;
  readonly project: string;
}

/**
 * The outcome of §4.3, field for field. Every field is always present — `null` or `[]`
 * where it does not apply — so an agent never branches on absence (TOOL-13).
 */
export interface Outcome {
  readonly outcome_version: 1;
  readonly handoff_id: string | null;
  readonly status: OutcomeStatus;
  readonly final: boolean;
  readonly instruction: string;
  readonly round: number;
  readonly current_step: OutcomeStep | null;
  readonly user_text: string | null;
  readonly screenshot: OutcomeScreenshot | null;
  readonly context: OutcomeContext | null;
  readonly skipped_steps: readonly number[];
  readonly notes: readonly OutcomeNote[];
  readonly secret_treated: readonly SecretTreated[];
  readonly verify: OutcomeVerify | null;
  readonly deferral_count: number;
  readonly resumed_from: ResumedFrom | null;
  readonly app_reachable: boolean;
  readonly already_delivered: boolean;
  readonly runbooks: readonly RunbookMatch[];
  readonly spec_text: string | null;
}

// ------------------------------------------------------------------ registered schemas

/**
 * The name the outcome schema's only cross-file `$ref` is bundled under. Any name works —
 * the reference resolves through the embedded `$id`, not through this key — so it is
 * chosen to read as what it is when an agent prints the registered schema.
 */
const BUNDLED_SPEC_DEF = 'handoff_spec_v1';

/**
 * The published outcome schema, self-contained.
 *
 * `$defs/runbook_match/properties/draft_spec` refers to `handoff-spec.v1.schema.json` by
 * its absolute `$id`, which is the right thing for a file published next to it and the
 * wrong thing for a schema handed to a client over stdio. Embedding the spec schema with
 * its `$id` intact makes the document a bundle in the sense of JSON Schema 2020-12: the
 * reference resolves inside the document, and the published files stay untouched.
 */
export const OUTCOME_OUTPUT_SCHEMA: JsonSchema = {
  ...outcomeSchema,
  $defs: { ...outcomeSchema.$defs, [BUNDLED_SPEC_DEF]: specSchema },
};

/** `{ runbooks: [ … ] }` — what `handoff_runbooks` returns (§4.7.3, TOOL-15). */
export const RUNBOOKS_OUTPUT_SCHEMA: JsonSchema = {
  $schema: outcomeSchema.$schema,
  title: 'Runbook search result',
  description:
    'What handoff_runbooks returns: the matching runbooks, in the shape the outcome field runbooks[] takes.',
  type: 'object',
  additionalProperties: false,
  required: ['runbooks'],
  properties: { runbooks: outcomeSchema.properties.runbooks },
  $defs: { ...outcomeSchema.$defs, [BUNDLED_SPEC_DEF]: specSchema },
};

/** The result `handoff_runbooks` and `handoff-mcp runbooks search` both produce. */
export interface RunbooksResult {
  readonly runbooks: readonly RunbookMatch[];
}

// ------------------------------------------------------------------ instruction texts

/** Which instruction variant a session gets (§4.7.4): the row decides, nothing else. */
export function hookVariant(row: ResolvedCapabilityRow): HookVariant {
  return row.stop_hook ? 'stop_hook' : 'no_stop_hook';
}

/**
 * The exact sentence of the tool contract for this status, with `<id>` replaced.
 *
 * `runbook_match` and `text_mode` have no handoff id and their texts carry no placeholder,
 * so nothing is substituted there; a unit test pins that pairing, because an instruction
 * that reached an agent still saying `<id>` would be an instruction it cannot follow.
 */
export function instructionFor(
  status: OutcomeStatus,
  variant: HookVariant,
  handoffId: string | null,
): string {
  const text = INSTRUCTIONS[status][variant];
  return handoffId === null ? text : text.replaceAll(ID_PLACEHOLDER, handoffId);
}

// ------------------------------------------------------------------ MCP results

/** `image/png`, base64 — the only image form the outcome carries (§4.3). */
const IMAGE_MIME_TYPE = 'image/png';

/** The JSON in a text block is compact, as the published mapping example shows it. */
function textBlock(value: unknown): { type: 'text'; text: string } {
  return { type: 'text', text: JSON.stringify(value) };
}

/**
 * The MCP result of an outcome (§4.3 MCP mapping, §4.7.4).
 *
 * `image` is the base64 PNG the app delivered with the outcome; T-020 passes what came
 * over the channel. It is attached only when the user chose the image path **and** the
 * client can show one, which is the whole of the capability adaptation on this side.
 */
export function renderOutcome(
  outcome: Outcome,
  row: ResolvedCapabilityRow,
  image?: string,
): CallToolResult {
  const variant = hookVariant(row);
  const rendered: Outcome = {
    ...outcome,
    final: STATUS_FINAL[outcome.status],
    instruction: instructionFor(outcome.status, variant, outcome.handoff_id),
  };

  const content: CallToolResult['content'] = [textBlock(rendered)];
  if (image !== undefined && row.images_in_results && rendered.screenshot?.mode === 'image') {
    content.push({ type: 'image', data: image, mimeType: IMAGE_MIME_TYPE });
  }

  return { content, structuredContent: { ...rendered }, isError: false };
}

/** The MCP result of `handoff_runbooks` (§4.7.3), mapped the same way as an outcome. */
export function renderRunbooks(runbooks: readonly RunbookMatch[]): CallToolResult {
  const result: RunbooksResult = { runbooks };
  return { content: [textBlock(result)], structuredContent: { ...result }, isError: false };
}

/**
 * The MCP result of a catalogue error (§4.7.5): the same JSON `handoff-mcp validate`
 * prints, in a text block, with `isError`. No `structuredContent`: an error is not an
 * outcome and does not answer the declared `outputSchema`.
 */
export function renderError(error: HandoffError): CallToolResult {
  return { content: [{ type: 'text', text: errorJson(error) }], isError: true };
}

/**
 * FM-10 and FM-11: text mode **with the right fix text**.
 *
 * A channel that is refusing the token or speaking another protocol version is not the same
 * degradation as an app that is simply not running, and the design says the agent is told
 * which it is. The status stays `text_mode` — the handoff still happens in chat, exactly as
 * SRV-14 says — so the outcome is untouched: the sentence goes in a second **text** block
 * instead. It carries the catalogue's own message and fix for `CHANNEL_AUTH_FAILED` or
 * `PROTOCOL_MISMATCH`, so what the agent reads here and what it would read from the matching
 * error result are one text, written once, in the generated contract.
 *
 * `content[1]` is where §4.3 puts the image block, and there is no image in text mode, so
 * the two can never both be there.
 */
export function withChannelFailure(
  result: CallToolResult,
  failure: ChannelFailure | undefined,
): CallToolResult {
  if (failure === undefined) return result;
  const text = `${ERROR_TEXTS[failure].message} ${catalogueFix(failure)}`;
  return { ...result, content: [...result.content, { type: 'text', text }] };
}

// ------------------------------------------------------------------ outcome builders

/**
 * The `runbook_match` outcome of the safety net (RUN-07, §4.3, F-03).
 *
 * No handoff was opened, so `handoff_id` is null and there is nothing to resume. The
 * detector still ran before the safety net (§5.2 step 2), and what it found is reported
 * here: the agent is about to send this spec again with `ignore_runbook`, and it should
 * see which of its values the server will treat as secret either way.
 *
 * `app_reachable` stays true, as §4.3 requires ("false only in `text_mode`") and the
 * published fixture shows: this outcome says nothing about the app, only that a recipe
 * already exists.
 */
export function runbookMatchOutcome(
  runbooks: readonly RunbookMatch[],
  secretTreated: readonly SecretTreated[],
  variant: HookVariant,
): Outcome {
  return {
    outcome_version: 1,
    handoff_id: null,
    status: 'runbook_match',
    final: STATUS_FINAL.runbook_match,
    instruction: INSTRUCTIONS.runbook_match[variant],
    round: 1,
    current_step: null,
    user_text: null,
    screenshot: null,
    context: null,
    skipped_steps: [],
    notes: [],
    secret_treated: secretTreated,
    verify: null,
    deferral_count: 0,
    resumed_from: null,
    app_reachable: true,
    already_delivered: false,
    runbooks,
    spec_text: null,
  };
}

/**
 * An outcome about a handoff that the server writes on its own, because the app was not
 * asked and has nothing to say: the `in_progress` of a heartbeat (TOOL-06) and the
 * `transferred_to_other_session` of a call this same server displaced (TOOL-08).
 *
 * Every field the app would have filled — the round, the step, the notes — is left at the
 * empty value §4.3 reserves for "not applicable", because inventing one would tell the
 * agent something nobody measured. `app_reachable` stays true: the app is there, it is this
 * call that stopped waiting.
 */
export function serverOutcome(status: OutcomeStatus, handoffId: string): Outcome {
  return {
    outcome_version: 1,
    handoff_id: handoffId,
    status,
    final: STATUS_FINAL[status],
    instruction: instructionFor(status, 'stop_hook', handoffId),
    round: 1,
    current_step: null,
    user_text: null,
    screenshot: null,
    context: null,
    skipped_steps: [],
    notes: [],
    secret_treated: [],
    verify: null,
    deferral_count: 0,
    resumed_from: null,
    app_reachable: true,
    already_delivered: false,
    runbooks: [],
    spec_text: null,
  };
}

// ------------------------------------------------------- outcomes that came over the channel

/** The value §4.3 gives each field when it does not apply, so none is ever absent (TOOL-13). */
const OUTCOME_DEFAULTS = {
  handoff_id: null,
  round: 1,
  current_step: null,
  user_text: null,
  screenshot: null,
  context: null,
  skipped_steps: [],
  notes: [],
  secret_treated: [],
  verify: null,
  deferral_count: 0,
  resumed_from: null,
  app_reachable: true,
  already_delivered: false,
  runbooks: [],
  spec_text: null,
} as const;

function isStatus(value: unknown): value is OutcomeStatus {
  return (OUTCOME_STATUSES as readonly unknown[]).includes(value);
}

/**
 * Reads the outcome the app sent into the shape the tool returns (§4.3, §6.3).
 *
 * The app is the authority on what happened, so its fields are taken as they are; but the
 * published outcome schema is **closed** and every field of it is required, so a key the
 * schema does not know is dropped and a key the app left out takes the empty value of the
 * table above. That is what "the server tolerates unknown fields in a result" (§6.3) has to
 * mean on this side: tolerate them, and still answer the agent with something that validates
 * against the `outputSchema` the tool declared.
 *
 * `status` is the one field that cannot be defaulted: it chooses the instruction and `final`,
 * both of which `renderOutcome` recomputes from the contract. An outcome without a status we
 * know is not an outcome, and the caller answers `INTERNAL`.
 */
export function outcomeFromChannel(raw: Record<string, unknown>): Outcome | undefined {
  const status = raw['status'];
  if (!isStatus(status)) return undefined;

  const picked: Record<string, unknown> = { outcome_version: 1, status };
  for (const [name, fallback] of Object.entries(OUTCOME_DEFAULTS)) {
    picked[name] = raw[name] === undefined ? fallback : raw[name];
  }
  // `final` and `instruction` are recomputed by `renderOutcome` from the contract; they are
  // filled here only so what comes out is a complete `Outcome`.
  picked['final'] = STATUS_FINAL[status];
  picked['instruction'] = instructionFor(status, 'stop_hook', null);
  return picked as unknown as Outcome;
}

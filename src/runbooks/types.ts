/**
 * The shape of a runbook that passed validation (TECHNICAL-DESIGN §4.5).
 *
 * These types describe what the reader guarantees when it hands a file on;
 * `schemas/handoff-runbook.v1.schema.json` stays the contract and is what actually
 * validates. Nothing here may add a constraint the schema does not have.
 *
 * A runbook is written by the app and read here, so every optional field of the spec is
 * present and explicitly `null` when it does not apply: the converter turns those nulls
 * into omitted spec fields (§4.5.4).
 */
import type { HandoffSpec } from '../format/types';

/** What happened on a step: notes, questions and replies, an error, a correction. */
export type AnnotationKind = 'note' | 'question' | 'reply' | 'error' | 'correction';

export interface RunbookAnnotation {
  readonly kind: AnnotationKind;
  readonly text: string;
  readonly round: number;
}

/** How the last execution ended (RUN-01). */
export type RunbookTrust = 'verified' | 'confirmed_by_user';

/** One step of the sequence actually executed (§4.5.1), with `{{name}}` placeholders. */
export interface RunbookStep {
  readonly text: string;
  readonly url: string | null;
  readonly values: readonly string[];
  readonly warning: string | null;
  readonly annotations: readonly RunbookAnnotation[];
}

/** A value name and the sentence it appeared in, with `{{name}}` in its place (RUN-04). */
export interface RunbookValue {
  readonly description: string | null;
}

/** A runbook file, version 1. */
export interface Runbook {
  readonly runbook_version: number;
  readonly id: string;
  readonly where: string;
  readonly goal: string;
  readonly why_human: string;
  readonly url: string | null;
  readonly lang: string | null;
  readonly values: Readonly<Record<string, RunbookValue>>;
  readonly secrets: Readonly<Record<string, string>>;
  readonly steps: readonly RunbookStep[];
  readonly verify: string | null;
  readonly trust: RunbookTrust;
  readonly last_verified_at: string;
  readonly last_run_failed_at: string | null;
  readonly runs: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly origin: { readonly app: string; readonly app_version: string };
}

/** A runbook and the absolute path it was read from, which the outcome reports. */
export interface StoredRunbook {
  readonly path: string;
  readonly runbook: Runbook;
}

/**
 * One item of the outcome's `runbooks[]` (§4.3), which is what `handoff_runbooks` returns
 * and what the `runbook_match` outcome of the safety net carries.
 *
 * `draft_spec` is spec-shaped but intentionally not yet valid: its values are empty
 * strings, which fail S6 until the agent fills them (§4.5.4).
 */
export interface RunbookMatch {
  readonly id: string;
  readonly path: string;
  readonly where: string;
  readonly goal: string;
  readonly trust: RunbookTrust;
  readonly last_verified_at: string;
  readonly last_run_failed_at: string | null;
  readonly runs: number;
  readonly matched_words: readonly string[];
  readonly draft_spec: HandoffSpec;
  readonly values_to_fill: Readonly<Record<string, string | null>>;
  readonly annotations: readonly RunbookAnnotation[];
}

/**
 * The shape of a handoff spec that passed validation (TECHNICAL-DESIGN §4.2).
 *
 * These types describe what `validateSpec` guarantees when it returns `ok`; the schema
 * `schemas/handoff-spec.v1.schema.json` stays the contract, and it is what actually
 * validates. Nothing here may add a constraint the schema does not have.
 */

/** A value of the top-level `values` map: one string, or a list of strings. */
export type SpecValue = string | readonly string[];

/** One step of a handoff. Always an object, never a string (SPEC-03). */
export interface HandoffStep {
  readonly text: string;
  readonly url?: string;
  readonly values?: readonly string[];
  readonly warning?: string;
}

/** A handoff spec, version 1. */
export interface HandoffSpec {
  readonly spec_version: number;
  readonly goal: string;
  readonly where: string;
  readonly url?: string;
  readonly why_human: string;
  readonly values: Readonly<Record<string, SpecValue>>;
  readonly secrets?: Readonly<Record<string, string>>;
  readonly steps: readonly HandoffStep[];
  readonly verify?: string;
  readonly lang?: string;
}

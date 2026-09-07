/**
 * The text-mode rendering of a spec (TECHNICAL-DESIGN §5.9, SRV-14..16).
 *
 * When the app is not reachable the handoff happens in the chat, so the spec has to be
 * readable by a person who only sees the agent's message: one heading, the place and the
 * reason, the values the project supplies, the numbered steps, the secrets to copy by hand
 * and the verification. The layout is the block printed in §5.9 and is rendered exactly,
 * which is why the snapshots of this module are reviewed against that block rather than
 * regenerated when they move.
 *
 * A section whose field is absent is omitted rather than printed empty: a spec with no
 * values, no secrets or no verification is valid (`minimal.json`), and a bare "Values (from
 * the project):" with nothing under it reads as a defect.
 *
 * This renderer prints whatever it is given. Masking is the caller's step, so that the two
 * can be tested apart; `textModeOutcome` composes them in the one order that is correct.
 */
import type { HandoffSpec, HandoffStep, SpecValue } from '../format/types';

/** Between the segments of a step line, as §5.9 prints them. */
const SEGMENT_GAP = '   ';

/** Between the place and its link on the `Where:` line, as §5.9 prints it. */
const URL_GAP = '  ';

/** A value is one string, or a list read as one line. */
function renderValue(value: SpecValue): string {
  return typeof value === 'string' ? value : value.join(', ');
}

/**
 * One step: its number and text, then only the segments it has.
 *
 * `[…]` around the URL is the notation of the `Where:` line one line above, so a person
 * reading the message knows the bracketed text is the link to open.
 */
function renderStep(step: HandoffStep, index: number): string {
  const segments = [`  ${String(index + 1)}. ${step.text}`];
  if (step.values !== undefined && step.values.length > 0) {
    segments.push(`(values: ${step.values.join(', ')})`);
  }
  if (step.url !== undefined) segments.push(`[${step.url}]`);
  if (step.warning !== undefined) segments.push(`WARNING: ${step.warning}`);
  return segments.join(SEGMENT_GAP);
}

/**
 * The spec as the Markdown text of §5.9, returned as the outcome's `spec_text`.
 *
 * Pass the masked copy from `maskSpecForText` when the spec carries certain secrets: what
 * this returns goes into the chat transcript verbatim.
 */
export function renderSpecText(spec: HandoffSpec): string {
  const lines: string[] = [
    `# Handoff (text mode): ${spec.goal}`,
    spec.url === undefined ? `Where: ${spec.where}` : `Where: ${spec.where}${URL_GAP}[${spec.url}]`,
    `Why a person: ${spec.why_human}`,
  ];

  const values = Object.entries(spec.values);
  if (values.length > 0) {
    lines.push('Values (from the project):');
    for (const [key, value] of values) lines.push(`  - ${key}: ${renderValue(value)}`);
  }

  lines.push('Steps:');
  spec.steps.forEach((step, index) => lines.push(renderStep(step, index)));

  const secrets = Object.entries(spec.secrets ?? {});
  if (secrets.length > 0) {
    lines.push(
      'After the steps, the user copies these values into project files (never paste them in chat):',
    );
    for (const [name, destination] of secrets) lines.push(`  - ${name} → ${destination}`);
  }

  if (spec.verify !== undefined) {
    lines.push(`Verification you must perform afterwards: ${spec.verify}`);
  }

  return lines.join('\n');
}

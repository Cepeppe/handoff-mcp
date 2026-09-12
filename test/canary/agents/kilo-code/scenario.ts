/**
 * What a Kilo Code canary scenario is, and the checks the Kilo Code scenarios share (T-081).
 *
 * The shape is OpenCode's (`../opencode/scenario.ts`) with Kilo's run options. Kilo prints
 * OpenCode's events and names our tools as OpenCode does, so the helpers that read a tool's
 * event are OpenCode's, and those that read only the server's observations or the shared
 * transcript are Codex's, imported rather than copied: nothing in them is about which agent ran.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Assertion } from '../../classify.ts';
import { REPO_ROOT, type CanaryRun } from '../../runner.ts';
import type { KiloRunOptions } from './runner.ts';

export { outcomesReceived, samePath, serverRegistered } from '../codex/scenario.ts';
export { toolDurationMs, toolUseEvent } from '../opencode/scenario.ts';

export interface KiloScenario {
  /** File-name id, also the key in the results document. Always `kilo-code-…`. */
  readonly id: string;
  /** One line, in the present tense, for the report. */
  readonly title: string;
  /** The Appendix B, §10 and §11.5 ids this covers, read for Kilo Code. */
  readonly covers: readonly string[];
  /** How the agent is launched. */
  readonly options: KiloRunOptions;
  /** What was checked. Order is the order of the report. */
  check(run: CanaryRun): Assertion[];
  /** What was measured, for `docs/agent-facts.md`. Never a spec value, never a path. */
  facts?(run: CanaryRun): Record<string, unknown>;
}

/** The facts of the kilo-code row a scenario compares its measurement against. */
export interface KiloRow {
  readonly client_names: readonly string[];
  readonly images_in_results: boolean | null;
  readonly stop_hook: boolean | null;
  readonly cancellation_notifications: boolean | null;
  readonly tool_timeout_ms_default: number | null;
}

interface TableRow {
  readonly agent_id: string;
  readonly match: { readonly client_names: readonly string[] };
  readonly images_in_results: boolean | null;
  readonly stop_hook: boolean | null;
  readonly cancellation_notifications: boolean | null;
  readonly tool_timeout_ms_default: number | null;
}

/**
 * The kilo-code row, read from the table the server bundles: a canary exists to notice when the
 * agent stops matching the table, so the expected values come from the table itself.
 */
export function kiloRow(): KiloRow {
  const table = JSON.parse(
    readFileSync(join(REPO_ROOT, 'src', 'adapters', 'capabilities.json'), 'utf8'),
  ) as { readonly rows: readonly TableRow[] };
  const row = table.rows.find((candidate) => candidate.agent_id === 'kilo-code');
  if (row === undefined) throw new Error('src/adapters/capabilities.json has no kilo-code row');
  return {
    client_names: row.match.client_names,
    images_in_results: row.images_in_results,
    stop_hook: row.stop_hook,
    cancellation_notifications: row.cancellation_notifications,
    tool_timeout_ms_default: row.tool_timeout_ms_default,
  };
}

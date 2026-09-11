/**
 * What an OpenCode canary scenario is, and the checks the OpenCode scenarios share (T-074).
 *
 * The shape is the Codex one of `../codex/scenario.ts` with OpenCode's run options. The checks
 * that read only the server's observations or the shared transcript — the registration order
 * of A-01, the outcomes a run received, the folder comparison — are the Codex ones, imported
 * rather than copied: nothing in them is about which agent ran.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Assertion } from '../../classify.ts';
import { REPO_ROOT, type CanaryRun, type TranscriptMessage } from '../../runner.ts';
import type { OpenCodeRunOptions } from './runner.ts';
import { OPENCODE_MCP_SERVER_NAME } from './workspace.ts';

export { outcomesReceived, samePath, serverRegistered } from '../codex/scenario.ts';

export interface OpenCodeScenario {
  /** File-name id, also the key in the results document. Always `opencode-…`. */
  readonly id: string;
  /** One line, in the present tense, for the report. */
  readonly title: string;
  /** The Appendix B, §10 and §11.5 ids this covers, read for OpenCode. */
  readonly covers: readonly string[];
  /** How the agent is launched. */
  readonly options: OpenCodeRunOptions;
  /** What was checked. Order is the order of the report. */
  check(run: CanaryRun): Assertion[];
  /** What was measured, for `docs/agent-facts.md`. Never a spec value, never a path. */
  facts?(run: CanaryRun): Record<string, unknown>;
}

/** The facts of the opencode row a scenario compares its measurement against. */
export interface OpenCodeRow {
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
 * The opencode row, read from the table the server bundles: a canary exists to notice when the
 * agent stops matching the table, so the expected values come from the table itself.
 */
export function opencodeRow(): OpenCodeRow {
  const table = JSON.parse(
    readFileSync(join(REPO_ROOT, 'src', 'adapters', 'capabilities.json'), 'utf8'),
  ) as { readonly rows: readonly TableRow[] };
  const row = table.rows.find((candidate) => candidate.agent_id === 'opencode');
  if (row === undefined) throw new Error('src/adapters/capabilities.json has no opencode row');
  return {
    client_names: row.match.client_names,
    images_in_results: row.images_in_results,
    stop_hook: row.stop_hook,
    cancellation_notifications: row.cancellation_notifications,
    tool_timeout_ms_default: row.tool_timeout_ms_default,
  };
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** The `tool_use` event OpenCode printed when a call of our `tool` ended, if it did. */
export function toolUseEvent(run: CanaryRun, tool: string): TranscriptMessage | undefined {
  return run.transcript.find(
    (event) =>
      event.type === 'tool_use' &&
      asRecord(event['part'])?.['tool'] === `${OPENCODE_MCP_SERVER_NAME}_${tool}`,
  );
}

/**
 * How long OpenCode says a call of our `tool` lasted, from its own `state.time`, in
 * milliseconds: the agent's side of a timeout, beside the server's.
 */
export function toolDurationMs(run: CanaryRun, tool: string): number | undefined {
  const time = asRecord(asRecord(asRecord(toolUseEvent(run, tool)?.['part'])?.['state'])?.['time']);
  const start = time?.['start'];
  const end = time?.['end'];
  return typeof start === 'number' && typeof end === 'number' ? end - start : undefined;
}

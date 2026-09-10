/**
 * What a Codex canary scenario is, and the checks the Codex scenarios share (T-066).
 *
 * The shape is the Claude one of `../../scenarios/scenario.ts` with Codex's run options: a
 * scenario names what it covers, says how to run the agent, turns one `CanaryRun` into
 * assertions and reports what it measured. The covered ids are Appendix B's and §10's, read
 * for Codex: A-08 is "the clientInfo Codex sends", A-04 "Codex's per-server timeout field".
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { check, type Assertion } from '../../classify.ts';
import {
  firstObservation,
  REPO_ROOT,
  type CanaryRun,
  type TranscriptMessage,
} from '../../runner.ts';
import type { CodexRunOptions } from './runner.ts';

export interface CodexScenario {
  /** File-name id, also the key in the results document. Always `codex-…`. */
  readonly id: string;
  /** One line, in the present tense, for the report. */
  readonly title: string;
  /** The Appendix B, §10 and §11.5 ids this covers, read for Codex. */
  readonly covers: readonly string[];
  /** How the agent is launched. */
  readonly options: CodexRunOptions;
  /** What was checked. Order is the order of the report. */
  check(run: CanaryRun): Assertion[];
  /** What was measured, for `docs/agent-facts.md`. Never a spec value, never a path. */
  facts?(run: CanaryRun): Record<string, unknown>;
}

/** The facts of the codex row a scenario compares its measurement against. */
export interface CodexRow {
  readonly client_names: readonly string[];
  readonly images_in_results: boolean | null;
  readonly stop_hook: boolean | null;
  readonly cancellation_notifications: boolean | null;
}

interface TableRow {
  readonly agent_id: string;
  readonly match: { readonly client_names: readonly string[] };
  readonly images_in_results: boolean | null;
  readonly stop_hook: boolean | null;
  readonly cancellation_notifications: boolean | null;
}

/**
 * The codex row, read from the table the server bundles. A canary exists to notice when the
 * agent stops matching the table, so the expected values come from the table itself rather
 * than from a copy of it here.
 */
export function codexRow(): CodexRow {
  const table = JSON.parse(
    readFileSync(join(REPO_ROOT, 'src', 'adapters', 'capabilities.json'), 'utf8'),
  ) as { readonly rows: readonly TableRow[] };
  const row = table.rows.find((candidate) => candidate.agent_id === 'codex');
  if (row === undefined) throw new Error('src/adapters/capabilities.json has no codex row');
  return {
    client_names: row.match.client_names,
    images_in_results: row.images_in_results,
    stop_hook: row.stop_hook,
    cancellation_notifications: row.cancellation_notifications,
  };
}

/** The server registered before the model could use it: Codex's half of A-01. */
export function serverRegistered(run: CanaryRun): Assertion {
  const init = firstObservation(run, 'initialize');
  const call = firstObservation(run, 'tool_call');
  return check(
    'A-01',
    'the server records initialize before the first tool call',
    'protocol',
    init !== undefined && (call === undefined || Date.parse(init.at) <= Date.parse(call.at)),
    `initialize at ${String(init?.at)}, first tool call at ${String(call?.at)}`,
  );
}

/**
 * Two paths name the same folder: resolved, trailing separators dropped, and compared without
 * case on the two platforms whose file systems ignore it by default (REQUIREMENTS §1.5).
 */
export function samePath(
  a: string,
  b: string,
  foldCase = process.platform === 'win32' || process.platform === 'darwin',
): boolean {
  if (a === '' || b === '') return false;
  const normal = (path: string): string => {
    const resolved = resolve(path).replace(/[\\/]+$/u, '');
    return foldCase ? resolved.toLowerCase() : resolved;
  };
  return normal(a) === normal(b);
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** The event Codex printed when a call of our `tool` ended, if it did. */
export function completedToolCall(run: CanaryRun, tool: string): TranscriptMessage | undefined {
  return run.transcript.find((event) => {
    if (event.type !== 'item.completed') return false;
    const item = asRecord(event['item']);
    return item?.['type'] === 'mcp_tool_call' && item['tool'] === tool;
  });
}

/** The instant the harness received an event, in epoch milliseconds, when it recorded one. */
export function receivedAt(event: TranscriptMessage | undefined): number | undefined {
  const at = event?.['received_at'];
  return typeof at === 'string' ? Date.parse(at) : undefined;
}

/**
 * Every outcome the agent received, in order, parsed from the text of its tool results. The
 * outcome is the first text block of a `handoff_to_user` result (§4.3), a single line of
 * JSON; anything else a result carries is not an outcome and is skipped.
 */
export function outcomesReceived(run: CanaryRun): Readonly<Record<string, unknown>>[] {
  const outcomes: Readonly<Record<string, unknown>>[] = [];
  for (const result of run.toolResults) {
    for (const candidate of [result.text, result.text.split('\n')[0] ?? '']) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(candidate);
      } catch {
        continue;
      }
      const outcome = asRecord(parsed);
      if (outcome !== undefined && typeof outcome['status'] === 'string') {
        outcomes.push(outcome);
        break;
      }
    }
  }
  return outcomes;
}

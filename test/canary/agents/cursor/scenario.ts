/**
 * What a Cursor canary scenario is, and the checks the Cursor scenarios share (T-069).
 *
 * Cursor has two surfaces and they are run two ways: a `cli` scenario runs the Cursor Agent CLI
 * (`runner.ts`) and spends one of the account's requests, an `editor` scenario launches the
 * editor on a throw-away project (`editor-runner.ts`) and spends none. The checks that read only
 * the server's observations, the shared transcript or what the overlay received are the Codex
 * ones, imported rather than copied.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Assertion } from '../../classify.ts';
import {
  REPO_ROOT,
  type CanaryRun,
  type HookRecord,
  type TranscriptMessage,
} from '../../runner.ts';
import type { CursorEditorRunOptions } from './editor-runner.ts';
import { cursorToolCall, cursorToolName, type CursorRunOptions } from './runner.ts';

export { outcomesReceived, samePath, serverRegistered } from '../codex/scenario.ts';

interface CursorScenarioBase {
  /** File-name id, also the key in the results document. Always `cursor-…`. */
  readonly id: string;
  /** One line, in the present tense, for the report. */
  readonly title: string;
  /** The Appendix B, §10, §11.5 and §14 ids this covers, read for Cursor. */
  readonly covers: readonly string[];
  /** What was checked. Order is the order of the report. */
  check(run: CanaryRun): Assertion[];
  /** What was measured, for `docs/agent-facts.md`. Never a spec value, never a path. */
  facts?(run: CanaryRun): Record<string, unknown>;
}

/** A scenario that runs the Cursor Agent CLI. */
export interface CursorCliScenario extends CursorScenarioBase {
  readonly surface: 'cli';
  readonly options: CursorRunOptions;
}

/** A scenario that launches Cursor's editor. */
export interface CursorEditorScenario extends CursorScenarioBase {
  readonly surface: 'editor';
  readonly options: CursorEditorRunOptions;
}

export type CursorScenario = CursorCliScenario | CursorEditorScenario;

/** The facts of the cursor row a scenario compares its measurement against. */
export interface CursorRow {
  readonly client_names: readonly string[];
  readonly images_in_results: boolean | null;
  readonly stop_hook: boolean | null;
  readonly cancellation_notifications: boolean | null;
  readonly tool_timeout_ms_default: number | null;
  readonly session_identity: string;
}

interface TableRow {
  readonly agent_id: string;
  readonly match: { readonly client_names: readonly string[] };
  readonly images_in_results: boolean | null;
  readonly stop_hook: boolean | null;
  readonly cancellation_notifications: boolean | null;
  readonly tool_timeout_ms_default: number | null;
  readonly session_identity: string;
}

/**
 * The cursor row, read from the table the server bundles: a canary exists to notice when the
 * agent stops matching the table, so the expected values come from the table itself.
 */
export function cursorRow(): CursorRow {
  const table = JSON.parse(
    readFileSync(join(REPO_ROOT, 'src', 'adapters', 'capabilities.json'), 'utf8'),
  ) as { readonly rows: readonly TableRow[] };
  const row = table.rows.find((candidate) => candidate.agent_id === 'cursor');
  if (row === undefined) throw new Error('src/adapters/capabilities.json has no cursor row');
  return {
    client_names: row.match.client_names,
    images_in_results: row.images_in_results,
    stop_hook: row.stop_hook,
    cancellation_notifications: row.cancellation_notifications,
    tool_timeout_ms_default: row.tool_timeout_ms_default,
    session_identity: row.session_identity,
  };
}

/** The `tool_call` events the CLI printed for our `tool`, in order. */
export function toolCallEvents(run: CanaryRun, tool: string): TranscriptMessage[] {
  const wanted = `mcp__handoff__${tool}`;
  return run.transcript.filter((event) => {
    if (event.type !== 'tool_call') return false;
    const call = cursorToolCall(event['tool_call']);
    return call !== undefined && cursorToolName(call.kind, call.body) === wanted;
  });
}

/** A millisecond stamp, which Cursor's protocol prints as a string because it is 64-bit. */
function stamp(value: unknown): number | undefined {
  const ms = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof ms === 'number' && Number.isFinite(ms) ? ms : undefined;
}

/**
 * How long the CLI says a call of our `tool` lasted, in milliseconds: the agent's side of a
 * timeout, beside the server's. Cursor stamps the call itself — `startedAtMs` and
 * `completedAtMs` on the completed event (measured) — and those are read first; the stamps of
 * the `started` and `completed` events are the fallback, for a call whose completed event
 * carries none.
 */
export function toolCallDurationMs(run: CanaryRun, tool: string): number | undefined {
  const events = toolCallEvents(run, tool);
  const completed = events.find((event) => event['subtype'] === 'completed');
  const call = completed?.['tool_call'];
  const own =
    typeof call === 'object' && call !== null ? (call as Record<string, unknown>) : undefined;
  const ownStart = stamp(own?.['startedAtMs']);
  const ownEnd = stamp(own?.['completedAtMs']);
  if (ownStart !== undefined && ownEnd !== undefined) return ownEnd - ownStart;
  const startedAt = stamp(events.find((event) => event['subtype'] === 'started')?.['timestamp_ms']);
  const endedAt = stamp(completed?.['timestamp_ms']);
  return startedAt !== undefined && endedAt !== undefined ? endedAt - startedAt : undefined;
}

/** The `hello` a server sent the scripted overlay, when one was listening and it arrived. */
export function serverHello(run: CanaryRun): Readonly<Record<string, unknown>> | undefined {
  for (const message of run.app?.received ?? []) {
    const record = message as { method?: unknown; params?: unknown } | null;
    const params = record?.params as Record<string, unknown> | undefined;
    if (record?.method === 'hello' && params?.['role'] === 'server') return params;
  }
  return undefined;
}

/** A hook record of the Cursor recorder: the shared shape, plus what only it writes. */
export interface CursorHookRecord extends HookRecord {
  readonly label?: string;
  readonly keys?: readonly string[];
  readonly ancestor_names?: readonly string[];
  readonly env_present?: readonly string[];
}

/** The records one declaration of the recording hook wrote, `cursor-stop` or `claude-stop`. */
export function hookRecordsOf(run: CanaryRun, label: string): CursorHookRecord[] {
  return (run.hookRecords as readonly CursorHookRecord[]).filter(
    (record) => record.label === label,
  );
}

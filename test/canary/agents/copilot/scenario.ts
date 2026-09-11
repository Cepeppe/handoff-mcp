/**
 * What a Copilot canary scenario is, and the checks the Copilot scenarios share (T-072).
 *
 * Copilot has two surfaces and they are run two ways: a `cli` scenario runs the GitHub Copilot
 * CLI (`runner.ts`) and spends the account's AI credits, an `editor` scenario launches VS Code
 * on a throw-away project (`editor-runner.ts`) and spends none. The checks that read only the
 * server's observations, the shared transcript or what the overlay received are the Codex ones,
 * imported rather than copied.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { check, type Assertion } from '../../classify.ts';
import { REPO_ROOT, type CanaryRun, type HookRecord } from '../../runner.ts';
import type { VsCodeRunOptions } from './editor-runner.ts';
import { eventData, parseCopilotEvents, type CopilotRunOptions } from './runner.ts';
import { COPILOT_MCP_SERVER_NAME } from './workspace.ts';

export { outcomesReceived, samePath, serverRegistered } from '../codex/scenario.ts';

interface CopilotScenarioBase {
  /** File-name id, also the key in the results document. Always `copilot-…`. */
  readonly id: string;
  /** One line, in the present tense, for the report. */
  readonly title: string;
  /** The Appendix B, §10, §11.5 and §14 ids this covers, read for Copilot. */
  readonly covers: readonly string[];
  /** What was checked. Order is the order of the report. */
  check(run: CanaryRun): Assertion[];
  /** What was measured, for `docs/agent-facts.md`. Never a spec value, never a path. */
  facts?(run: CanaryRun): Record<string, unknown>;
}

/** A scenario that runs the GitHub Copilot CLI. */
export interface CopilotCliScenario extends CopilotScenarioBase {
  readonly surface: 'cli';
  readonly options: CopilotRunOptions;
}

/** A scenario that launches VS Code. */
export interface CopilotEditorScenario extends CopilotScenarioBase {
  readonly surface: 'editor';
  readonly options: VsCodeRunOptions;
}

export type CopilotScenario = CopilotCliScenario | CopilotEditorScenario;

/** The facts of the copilot row a scenario compares its measurement against. */
export interface CopilotRow {
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
 * The copilot row, read from the table the server bundles: a canary exists to notice when the
 * agent stops matching the table, so the expected values come from the table itself.
 */
export function copilotRow(): CopilotRow {
  const table = JSON.parse(
    readFileSync(join(REPO_ROOT, 'src', 'adapters', 'capabilities.json'), 'utf8'),
  ) as { readonly rows: readonly TableRow[] };
  const row = table.rows.find((candidate) => candidate.agent_id === 'copilot');
  if (row === undefined) throw new Error('src/adapters/capabilities.json has no copilot row');
  return {
    client_names: row.match.client_names,
    images_in_results: row.images_in_results,
    stop_hook: row.stop_hook,
    cancellation_notifications: row.cancellation_notifications,
    tool_timeout_ms_default: row.tool_timeout_ms_default,
    session_identity: row.session_identity,
  };
}

/** The status the CLI last reported for our server, or `undefined` when it named none. */
export function handoffServerStatus(run: CanaryRun): string | undefined {
  const loaded = parseCopilotEvents(
    run.transcript.map((event) => ({ line: JSON.stringify(event) })),
  ).servers;
  return loaded.find((server) => server.name === COPILOT_MCP_SERVER_NAME)?.status;
}

/**
 * The CLI reported our server connected: under `-p` it does not wait for its MCP servers
 * (T-071), so a model that "cannot find the tool" is a harness fact before it is a model one.
 */
export function serverLoaded(run: CanaryRun): Assertion {
  const status = handoffServerStatus(run);
  return check(
    'A-01',
    'the CLI reports the handoff server connected in session.mcp_servers_loaded',
    'protocol',
    status === 'connected',
    `status ${String(status)}`,
  );
}

/** An instant of a session event: its own `timestamp`, else when the harness received it. */
function instantOf(event: Readonly<Record<string, unknown>> | undefined): number | undefined {
  for (const key of ['timestamp', 'received_at']) {
    const value = event?.[key];
    if (typeof value === 'string') {
      const ms = Date.parse(value);
      if (Number.isFinite(ms)) return ms;
    }
  }
  return undefined;
}

/**
 * How long the CLI says a call of our `tool` lasted, in milliseconds: the agent's side of a
 * timeout, beside the server's. From the `tool.execution_start` of the call to the
 * `tool.execution_complete` with the same `toolCallId`.
 */
export function toolCallDurationMs(run: CanaryRun, tool: string): number | undefined {
  const start = run.transcript.find(
    (event) =>
      event.type === 'tool.execution_start' &&
      eventData(event)['mcpServerName'] === COPILOT_MCP_SERVER_NAME &&
      eventData(event)['mcpToolName'] === tool,
  );
  const id = eventData(start)['toolCallId'];
  const end = run.transcript.find(
    (event) => event.type === 'tool.execution_complete' && eventData(event)['toolCallId'] === id,
  );
  const startedAt = instantOf(start);
  const endedAt = instantOf(end);
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

/** A hook record of the Copilot recorder: the shared shape, plus what only it writes. */
export interface CopilotHookRecord extends HookRecord {
  readonly label?: string;
  readonly keys?: readonly string[];
  readonly ancestor_names?: readonly string[];
  readonly env_present?: readonly string[];
}

/** The records one declaration of the recording hook wrote. */
export function hookRecordsOf(run: CanaryRun, label: string): CopilotHookRecord[] {
  return (run.hookRecords as readonly CopilotHookRecord[]).filter(
    (record) => record.label === label,
  );
}

/** What the run cost, as `--usage-output-file` wrote it, or `null`. */
export function usageOf(run: CanaryRun): unknown {
  return run.result?.['usage'] ?? null;
}

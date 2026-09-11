/**
 * The Cursor timeout canary (T-069; Appendix B A-04 and A-09 read for Cursor, FM-04;
 * TECHNICAL-DESIGN §5.6, §5.7).
 *
 * One run of the probe's `sleep_ms` with nothing configured, because there is nothing to
 * configure: neither Cursor's editor nor its CLI reads a timeout from an MCP entry (read from
 * the 3.20.10 bundle and the CLI 2026.09.10-fd3934a). The CLI hands the call to the MCP SDK with
 * no timeout of its own, so the SDK's default is what cuts it, and the SDK tells the server with
 * a cancellation; the run measures both. The editor's own limit is longer (a 120 s idle timeout
 * that restarts on progress, from its bundle), so the CLI's is the one the row states and the
 * heartbeat has to beat.
 */
import { check, note } from '../../classify.ts';
import { firstObservation, type CanaryRun } from '../../runner.ts';
import { wellFormed } from '../../scenarios/scenario.ts';
import { HEARTBEAT_FLOOR_MS } from '../codex/timeouts.ts';
import {
  cursorRow,
  serverRegistered,
  toolCallDurationMs,
  type CursorCliScenario,
} from './scenario.ts';

/** The sleep the run asks for: long enough that finishing means nothing cut it. */
export const CURSOR_LONG_SLEEP_MS = 90_000;

/** How far past the expected value a cut may land and still be that cut. */
export const CURSOR_CUT_TOLERANCE_MS = 30_000;

function prompt(ms: number): string {
  return [
    `Call the tool sleep_ms of the MCP server handoff exactly once with ms set to ${String(ms)}.`,
    'It is expected to take a long time; wait for it, and do not call it again.',
    'Then reply with exactly DONE and nothing else.',
  ].join(' ');
}

function within(ms: number | undefined, target: number): boolean {
  return ms !== undefined && ms >= target - 2_000 && ms <= target + CURSOR_CUT_TOLERANCE_MS;
}

function waited(run: CanaryRun): number | undefined {
  const value = firstObservation(run, 'sleep_end')?.['waited_ms'];
  return typeof value === 'number' ? value : undefined;
}

function sleepResult(run: CanaryRun) {
  return run.toolResults.find((result) => {
    const use = run.toolUses.find((candidate) => candidate.id === result.tool_use_id);
    return use?.name === 'mcp__handoff__sleep_ms';
  });
}

export const cursorDefaultTimeoutScenario: CursorCliScenario = {
  id: 'cursor-default-timeout',
  title:
    'a call with nothing configured is cut at the default the table states, and the server is told',
  covers: ['FM-04', 'A-04', 'A-09'],
  surface: 'cli',
  options: { prompt: prompt(CURSOR_LONG_SLEEP_MS), timeoutMs: CURSOR_LONG_SLEEP_MS + 180_000 },

  check(run) {
    const end = firstObservation(run, 'sleep_end');
    const row = cursorRow();
    const stated = row.tool_timeout_ms_default;
    const told = end?.['outcome'] === 'aborted';
    const expectedTold = row.cancellation_notifications === true;
    const agentSide = toolCallDurationMs(run, 'sleep_ms');
    return [
      wellFormed(run),
      serverRegistered(run),
      check(
        'model',
        'the agent calls sleep_ms once, as the prompt asked',
        'model',
        firstObservation(run, 'sleep_start') !== undefined,
        `tool uses ${JSON.stringify(run.toolUses.map((use) => use.name))}`,
      ),
      check(
        'FM-04',
        `with nothing configured, a call is cut at tool_timeout_ms_default = ${String(stated)} ms`,
        'protocol',
        stated !== null &&
          end?.['outcome'] !== 'completed' &&
          within(waited(run) ?? agentSide, stated),
        `sleep_end ${String(end?.['outcome'])} after ${String(waited(run))} ms, the CLI says ` +
          `${String(agentSide)} ms; the agent saw ` +
          `"${(sleepResult(run)?.text ?? '').replace(/\s+/gu, ' ').slice(0, 120)}"`,
      ),
      check(
        'FM-04',
        `the ${String(HEARTBEAT_FLOOR_MS)} ms heartbeat lands before that default cut`,
        'protocol',
        stated !== null && HEARTBEAT_FLOOR_MS < stated,
        `heartbeat ${String(HEARTBEAT_FLOOR_MS)} ms, default cut ${String(stated)} ms`,
      ),
      note(
        'A-09',
        `the server is ${expectedTold ? '' : 'not '}told by an MCP cancellation, as ` +
          `cancellation_notifications = ${String(expectedTold)} says`,
        told === expectedTold,
        `sleep_end ${String(end?.['outcome'])}`,
      ),
    ];
  },

  facts(run) {
    const end = firstObservation(run, 'sleep_end');
    return {
      probe_sleep_ms: CURSOR_LONG_SLEEP_MS,
      observed_outcome: end?.['outcome'] ?? null,
      observed_waited_ms: waited(run) ?? null,
      observed_ms_per_cursor: toolCallDurationMs(run, 'sleep_ms') ?? null,
      server_told: end?.['outcome'] === 'aborted',
      agent_saw_error: sleepResult(run)?.isError ?? null,
      agent_error: (sleepResult(run)?.text ?? '').slice(0, 80),
    };
  },
};

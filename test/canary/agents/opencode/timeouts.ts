/**
 * The OpenCode timeout canaries (T-074; Appendix B A-04 and A-09 read for OpenCode, FM-04;
 * TECHNICAL-DESIGN §5.6, §5.7).
 *
 * Two runs of the probe's `sleep_ms`, as for Codex, and one difference that matters: OpenCode
 * applies its timeout through the MCP SDK's own request timeout, which sends the server a real
 * cancellation. So both cuts are timed from inside, by the probe's `sleep_end`, and OpenCode's
 * own `state.time` is recorded beside it.
 *
 * - **`opencode-per-server-timeout`** — `timeout: 20000` on our entry and a sleep of 120 s. The
 *   call must be cut at about twenty seconds, which is also what proves the unit: milliseconds.
 * - **`opencode-default-timeout`** — nothing configured and a sleep of 120 s. Unlike Claude Code
 *   and Codex, the default is not only bounded from below: OpenCode passes the entry's timeout
 *   to the SDK, which falls back to its own 60 s, so the call is cut at a number the table can
 *   state (`tool_timeout_ms_default`). What FM-04 rests on is that the 50 s heartbeat lands
 *   before it.
 */
import { check, note } from '../../classify.ts';
import { firstObservation, type CanaryRun } from '../../runner.ts';
import { wellFormed } from '../../scenarios/scenario.ts';
import {
  opencodeRow,
  serverRegistered,
  toolDurationMs,
  type OpenCodeScenario,
} from './scenario.ts';

/** The sleep both runs ask for: long enough that finishing means nothing cut it. */
export const OPENCODE_LONG_SLEEP_MS = 120_000;

/** The per-server `timeout` the first run writes, in milliseconds. */
export const OPENCODE_CONFIGURED_TIMEOUT_MS = 20_000;

/** How far past the expected value a cut may land and still be that cut. */
export const OPENCODE_CUT_TOLERANCE_MS = 15_000;

/** The heartbeat of a row whose timeout leaves no margin (§4.1 UNKNOWN_CLIENT_HEARTBEAT_MS). */
export const HEARTBEAT_FLOOR_MS = 50_000;

function prompt(ms: number): string {
  return [
    `Call the tool sleep_ms of the MCP server handoff exactly once with ms set to ${String(ms)}.`,
    'It is expected to take a long time; wait for it, and do not call it again.',
    'Then reply with exactly DONE and nothing else.',
  ].join(' ');
}

function calledSleep(run: CanaryRun) {
  return check(
    'model',
    'the agent calls sleep_ms once, as the prompt asked',
    'model',
    firstObservation(run, 'sleep_start') !== undefined,
    `tool uses ${JSON.stringify(run.toolUses.map((use) => use.name))}`,
  );
}

/** How long the probe's sleep ran before it ended, however it ended. */
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

function within(value: number | undefined, expected: number): boolean {
  return (
    value !== undefined && value >= expected - 2000 && value <= expected + OPENCODE_CUT_TOLERANCE_MS
  );
}

export const opencodePerServerTimeoutScenario: OpenCodeScenario = {
  id: 'opencode-per-server-timeout',
  title: 'the timeout field of the MCP entry bounds a tool call, in milliseconds',
  covers: ['A-04', 'A-09'],
  options: {
    prompt: prompt(OPENCODE_LONG_SLEEP_MS),
    entryTimeoutMs: OPENCODE_CONFIGURED_TIMEOUT_MS,
    timeoutMs: OPENCODE_LONG_SLEEP_MS + 180_000,
  },

  check(run) {
    const end = firstObservation(run, 'sleep_end');
    const result = sleepResult(run);
    const told = end?.['outcome'] === 'aborted';
    const expectedTold = opencodeRow().cancellation_notifications === true;
    const ended = typeof end?.['outcome'] === 'string' ? end['outcome'] : 'never recorded';

    return [
      wellFormed(run),
      serverRegistered(run),
      calledSleep(run),
      check(
        'A-04',
        'a tool call that outlives the timeout field is cut short',
        'protocol',
        result?.isError === true && end?.['outcome'] !== 'completed',
        `agent saw ${result === undefined ? 'no result' : result.isError ? 'an error' : 'a result'}, ` +
          `sleep_end ${ended}`,
      ),
      check(
        'A-04',
        'the cut lands at about the configured value, so the field is milliseconds',
        'protocol',
        within(waited(run) ?? toolDurationMs(run, 'sleep_ms'), OPENCODE_CONFIGURED_TIMEOUT_MS),
        `server waited ${String(waited(run))} ms, OpenCode says ` +
          `${String(toolDurationMs(run, 'sleep_ms'))} ms, against ` +
          `${String(OPENCODE_CONFIGURED_TIMEOUT_MS)} ms configured; OpenCode said ` +
          `"${(result?.text ?? '').replace(/\s+/gu, ' ').slice(0, 120)}"`,
      ),
      note(
        'A-09',
        `the server is ${expectedTold ? '' : 'not '}told by an MCP cancellation, as ` +
          `cancellation_notifications = ${String(expectedTold)} says`,
        told === expectedTold,
        `sleep_end ${ended}`,
      ),
    ];
  },

  facts(run) {
    const end = firstObservation(run, 'sleep_end');
    return {
      configured_timeout_ms: OPENCODE_CONFIGURED_TIMEOUT_MS,
      requested_sleep_ms: OPENCODE_LONG_SLEEP_MS,
      cut_after_ms: waited(run) ?? null,
      cut_after_ms_per_opencode: toolDurationMs(run, 'sleep_ms') ?? null,
      server_told: end?.['outcome'] === 'aborted',
      agent_saw_error: sleepResult(run)?.isError ?? null,
      agent_error: (sleepResult(run)?.text ?? '').slice(0, 80),
    };
  },
};

export const opencodeDefaultTimeoutScenario: OpenCodeScenario = {
  id: 'opencode-default-timeout',
  title: 'with no timeout configured, a call is cut at the default the table states',
  covers: ['FM-04', 'A-09'],
  options: { prompt: prompt(OPENCODE_LONG_SLEEP_MS), timeoutMs: OPENCODE_LONG_SLEEP_MS + 180_000 },

  check(run) {
    const end = firstObservation(run, 'sleep_end');
    const stated = opencodeRow().tool_timeout_ms_default;
    return [
      wellFormed(run),
      serverRegistered(run),
      calledSleep(run),
      check(
        'FM-04',
        `with nothing configured, a call is cut at tool_timeout_ms_default = ${String(stated)} ms`,
        'protocol',
        stated !== null && end?.['outcome'] === 'aborted' && within(waited(run), stated),
        `outcome ${String(end?.['outcome'])} after ${String(waited(run))} ms, ` +
          `OpenCode says ${String(toolDurationMs(run, 'sleep_ms'))} ms`,
      ),
      check(
        'FM-04',
        `the ${String(HEARTBEAT_FLOOR_MS)} ms heartbeat lands before that default cut`,
        'protocol',
        stated !== null && HEARTBEAT_FLOOR_MS < stated,
        `heartbeat ${String(HEARTBEAT_FLOOR_MS)} ms, default cut ${String(stated)} ms`,
      ),
    ];
  },

  facts(run) {
    const end = firstObservation(run, 'sleep_end');
    return {
      probe_sleep_ms: OPENCODE_LONG_SLEEP_MS,
      observed_outcome: end?.['outcome'] ?? null,
      observed_waited_ms: waited(run) ?? null,
      observed_ms_per_opencode: toolDurationMs(run, 'sleep_ms') ?? null,
      agent_error: (sleepResult(run)?.text ?? '').slice(0, 80),
    };
  },
};

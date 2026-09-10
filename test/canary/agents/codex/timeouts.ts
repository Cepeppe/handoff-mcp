/**
 * The Codex timeout canaries (T-066; Appendix B A-04 and A-09 read for Codex, FM-04;
 * TECHNICAL-DESIGN §5.6, §5.7).
 *
 * Two runs of the probe's `sleep_ms`, because a session has one timeout and the point is to
 * compare them:
 *
 * - **`codex-per-server-timeout`** — `tool_timeout_sec = 20` on our entry and a sleep of
 *   120 s. The call must be cut at about twenty seconds, which is also what proves the unit.
 *   Codex does not tell the server (no MCP cancellation arrives, measured on 0.153.4), so
 *   the cut is timed from outside: from the probe's `tool_call` to the instant the harness
 *   received the failed `mcp_tool_call` event.
 * - **`codex-default-timeout`** — nothing configured and a sleep of 120 s. The default is
 *   only bounded from below, like Claude Code's: what is established is that a call runs
 *   past the 50 s heartbeat the server falls back to when no timeout is known, which is the
 *   property the degraded path of FM-04 rests on.
 */
import { check, note } from '../../classify.ts';
import { firstObservation, type CanaryRun } from '../../runner.ts';
import { wellFormed } from '../../scenarios/scenario.ts';
import {
  codexRow,
  completedToolCall,
  receivedAt,
  serverRegistered,
  type CodexScenario,
} from './scenario.ts';

/** The sleep both runs ask for: long enough that finishing means nothing cut it. */
export const CODEX_LONG_SLEEP_MS = 120_000;

/** The per-server `tool_timeout_sec` the first run writes, in seconds. */
export const CODEX_CONFIGURED_TIMEOUT_SEC = 20;

/** How far past the configured value a cut may land and still be that cut. */
export const CODEX_CUT_TOLERANCE_MS = 30_000;

/** The heartbeat of a row with no known timeout (§4.1 UNKNOWN_CLIENT_HEARTBEAT_MS). */
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

/** From the probe's record of the call to the instant Codex printed its end, in milliseconds. */
function waitedFromOutside(run: CanaryRun): number | undefined {
  const call = firstObservation(run, 'tool_call');
  const ended = receivedAt(completedToolCall(run, 'sleep_ms'));
  return call === undefined || ended === undefined ? undefined : ended - Date.parse(call.at);
}

function sleepResult(run: CanaryRun) {
  return run.toolResults.find((result) => {
    const use = run.toolUses.find((candidate) => candidate.id === result.tool_use_id);
    return use?.name === 'mcp__handoff__sleep_ms';
  });
}

export const codexPerServerTimeoutScenario: CodexScenario = {
  id: 'codex-per-server-timeout',
  title: 'tool_timeout_sec of the MCP entry bounds a tool call, in seconds',
  covers: ['A-04', 'A-09'],
  options: {
    prompt: prompt(CODEX_LONG_SLEEP_MS),
    toolTimeoutSec: CODEX_CONFIGURED_TIMEOUT_SEC,
    timeoutMs: CODEX_LONG_SLEEP_MS + 180_000,
  },

  check(run) {
    const end = firstObservation(run, 'sleep_end');
    const result = sleepResult(run);
    const waited = waitedFromOutside(run);
    const configuredMs = CODEX_CONFIGURED_TIMEOUT_SEC * 1000;
    const told = end?.['outcome'] === 'aborted';
    const expectedTold = codexRow().cancellation_notifications === true;
    const ended = typeof end?.['outcome'] === 'string' ? end['outcome'] : 'never recorded';

    return [
      wellFormed(run),
      serverRegistered(run),
      calledSleep(run),
      check(
        'A-04',
        'a tool call that outlives tool_timeout_sec is cut short',
        'protocol',
        result?.isError === true && end?.['outcome'] !== 'completed',
        `agent saw ${result === undefined ? 'no result' : result.isError ? 'an error' : 'a result'}, ` +
          `sleep_end ${ended}`,
      ),
      check(
        'A-04',
        'the cut lands at about the configured value, so the field is seconds',
        'protocol',
        waited !== undefined &&
          waited >= configuredMs - 2000 &&
          waited <= configuredMs + CODEX_CUT_TOLERANCE_MS,
        `cut after ${String(waited)} ms against ${String(configuredMs)} ms configured; ` +
          `Codex said "${(result?.text ?? '').replace(/\s+/gu, ' ').slice(0, 120)}"`,
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
      configured_tool_timeout_sec: CODEX_CONFIGURED_TIMEOUT_SEC,
      requested_sleep_ms: CODEX_LONG_SLEEP_MS,
      cut_after_ms_from_outside: waitedFromOutside(run) ?? null,
      server_told: end?.['outcome'] === 'aborted',
      agent_saw_error: sleepResult(run)?.isError ?? null,
    };
  },
};

export const codexDefaultTimeoutScenario: CodexScenario = {
  id: 'codex-default-timeout',
  title: 'with no timeout configured, a call outlives the 50 s heartbeat (bounded probe)',
  covers: ['FM-04'],
  options: { prompt: prompt(CODEX_LONG_SLEEP_MS), timeoutMs: CODEX_LONG_SLEEP_MS + 180_000 },

  check(run) {
    const end = firstObservation(run, 'sleep_end');
    const waited = typeof end?.['waited_ms'] === 'number' ? end['waited_ms'] : undefined;
    return [
      wellFormed(run),
      serverRegistered(run),
      calledSleep(run),
      check(
        'FM-04',
        `with nothing configured, a ${String(CODEX_LONG_SLEEP_MS)} ms call is not cut short, ` +
          `so the ${String(HEARTBEAT_FLOOR_MS)} ms heartbeat always lands first`,
        'protocol',
        end?.['outcome'] === 'completed' && waited !== undefined,
        `outcome ${String(end?.['outcome'])} after ${String(waited)} ms with nothing configured`,
      ),
    ];
  },

  facts(run) {
    const end = firstObservation(run, 'sleep_end');
    return {
      probe_sleep_ms: CODEX_LONG_SLEEP_MS,
      observed_outcome: end?.['outcome'] ?? null,
      observed_waited_ms: end?.['waited_ms'] ?? null,
      default_timeout_ms_lower_bound: end?.['outcome'] === 'completed' ? CODEX_LONG_SLEEP_MS : null,
    };
  },
};

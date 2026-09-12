/**
 * The Kilo Code timeout canaries (T-081; Appendix B A-04 and A-09 read for Kilo Code, FM-04;
 * TECHNICAL-DESIGN §5.6, §5.7).
 *
 * Two runs of the probe's `sleep_ms`, as for OpenCode. Both cuts are timed from inside, by the
 * probe's `sleep_end`, and Kilo's own `state.time` is recorded beside it.
 *
 * - **`kilo-code-per-server-timeout`** — `timeout: 20000` on our entry and a sleep of 120 s. The
 *   call must be cut at about twenty seconds, which is also what proves the unit: milliseconds.
 * - **`kilo-code-default-timeout`** — nothing configured and a sleep of 120 s. What the call does
 *   is compared against `tool_timeout_ms_default` of the kilo-code row: a number is a cut the
 *   call must meet, and `null` a default only bounded from below, which the call must outlive.
 *   Kilo's configuration schema documents the entry's `timeout` as five seconds when unset, the
 *   sentence OpenCode's carries too, and beside it an `experimental.mcp_timeout` (T-080); what
 *   Kilo applies is what this run measures. Either way FM-04 rests on the 50 s heartbeat
 *   landing first.
 */
import { check, note } from '../../classify.ts';
import { firstObservation, type CanaryRun } from '../../runner.ts';
import { wellFormed } from '../../scenarios/scenario.ts';
import { kiloRow, serverRegistered, toolDurationMs, type KiloScenario } from './scenario.ts';

/** The sleep both runs ask for: long enough that finishing means nothing cut it. */
export const KILO_LONG_SLEEP_MS = 120_000;

/** The per-server `timeout` the first run writes, in milliseconds. */
export const KILO_CONFIGURED_TIMEOUT_MS = 20_000;

/** How far past the expected value a cut may land and still be that cut. */
export const KILO_CUT_TOLERANCE_MS = 15_000;

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
    value !== undefined && value >= expected - 2000 && value <= expected + KILO_CUT_TOLERANCE_MS
  );
}

export const kiloPerServerTimeoutScenario: KiloScenario = {
  id: 'kilo-code-per-server-timeout',
  title: 'the timeout field of the MCP entry bounds a tool call, in milliseconds',
  covers: ['A-04', 'A-09'],
  options: {
    prompt: prompt(KILO_LONG_SLEEP_MS),
    entryTimeoutMs: KILO_CONFIGURED_TIMEOUT_MS,
    timeoutMs: KILO_LONG_SLEEP_MS + 180_000,
  },

  check(run) {
    const end = firstObservation(run, 'sleep_end');
    const result = sleepResult(run);
    const told = end?.['outcome'] === 'aborted';
    const expectedTold = kiloRow().cancellation_notifications === true;
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
        within(waited(run) ?? toolDurationMs(run, 'sleep_ms'), KILO_CONFIGURED_TIMEOUT_MS),
        `server waited ${String(waited(run))} ms, Kilo says ` +
          `${String(toolDurationMs(run, 'sleep_ms'))} ms, against ` +
          `${String(KILO_CONFIGURED_TIMEOUT_MS)} ms configured; Kilo said ` +
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
      configured_timeout_ms: KILO_CONFIGURED_TIMEOUT_MS,
      requested_sleep_ms: KILO_LONG_SLEEP_MS,
      cut_after_ms: waited(run) ?? null,
      cut_after_ms_per_kilo: toolDurationMs(run, 'sleep_ms') ?? null,
      server_told: end?.['outcome'] === 'aborted',
      agent_saw_error: sleepResult(run)?.isError ?? null,
      agent_error: (sleepResult(run)?.text ?? '').slice(0, 80),
    };
  },
};

export const kiloDefaultTimeoutScenario: KiloScenario = {
  id: 'kilo-code-default-timeout',
  title: 'with no timeout configured, a call meets the default the table states',
  covers: ['FM-04', 'A-09'],
  options: { prompt: prompt(KILO_LONG_SLEEP_MS), timeoutMs: KILO_LONG_SLEEP_MS + 180_000 },

  check(run) {
    const end = firstObservation(run, 'sleep_end');
    const stated = kiloRow().tool_timeout_ms_default;
    const outcome =
      `outcome ${String(end?.['outcome'])} after ${String(waited(run))} ms, ` +
      `Kilo says ${String(toolDurationMs(run, 'sleep_ms'))} ms`;
    return [
      wellFormed(run),
      serverRegistered(run),
      calledSleep(run),
      stated === null
        ? check(
            'FM-04',
            'with nothing configured, a call outlives the probe, as a null default says',
            'protocol',
            end?.['outcome'] === 'completed' &&
              (waited(run) ?? 0) >= KILO_LONG_SLEEP_MS - KILO_CUT_TOLERANCE_MS,
            outcome,
          )
        : check(
            'FM-04',
            `with nothing configured, a call is cut at tool_timeout_ms_default = ${String(stated)} ms`,
            'protocol',
            end?.['outcome'] === 'aborted' && within(waited(run), stated),
            outcome,
          ),
      check(
        'FM-04',
        `the ${String(HEARTBEAT_FLOOR_MS)} ms heartbeat lands before any default cut`,
        'protocol',
        stated === null || HEARTBEAT_FLOOR_MS < stated,
        `heartbeat ${String(HEARTBEAT_FLOOR_MS)} ms, default ${String(stated)} ms`,
      ),
    ];
  },

  facts(run) {
    const end = firstObservation(run, 'sleep_end');
    return {
      probe_sleep_ms: KILO_LONG_SLEEP_MS,
      observed_outcome: end?.['outcome'] ?? null,
      observed_waited_ms: waited(run) ?? null,
      observed_ms_per_kilo: toolDurationMs(run, 'sleep_ms') ?? null,
      agent_error: (sleepResult(run)?.text ?? '').slice(0, 80),
    };
  },
};

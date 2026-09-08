/**
 * The timeout canaries (T-023; Appendix B A-03, A-04, A-09; TECHNICAL-DESIGN §5.6, §5.7,
 * §15 OI-02).
 *
 * Three runs, because a session has one timeout and the point is to compare them:
 *
 * - **`a03-timeout-honoured`** — `MCP_TOOL_TIMEOUT` in the project settings `env` block,
 *   and a `sleep_ms` far past it. The call must be cut short. What T-026 needs from this
 *   run is not the tick but the number: `waited_ms` is the timeout the agent actually
 *   applied, and whether the server was *told* (A-09) or merely abandoned.
 * - **`a03-timeout-default`** — the same tool with no timeout configured anywhere. The
 *   documented default is very long (A-03 says ≈ 28 h), which cannot be waited out, so this
 *   is the bounded probe the task asks for: a sleep the harness *can* afford proves the
 *   default is at least that long, and nothing more is claimed.
 * - **`a04-per-server-timeout`** — the per-server `timeout` field of the MCP entry instead
 *   of the variable. This is the run T-026's Option B stands or falls on, and it also
 *   measures the field's unit: cut at about the number written means milliseconds.
 *
 * All three read `sleep_ms`, the test tool the server registers only under
 * `HANDOFF_CANARY=1` (§11.5: "a test tool sleeping past the configured value is
 * cancelled").
 */
import { check, note, type Assertion } from '../classify.ts';
import { firstObservation, type CanaryRun } from '../runner.ts';
import { serverConnected, wellFormed, type Scenario } from './scenario.ts';

/** The sleep a bounded timeout must interrupt: long enough that finishing means failure. */
export const LONG_SLEEP_MS = 120_000;

/** The timeout written into the settings and into the MCP entry. */
export const CONFIGURED_TIMEOUT_MS = 20_000;

/**
 * The bounded probe of the default: a sleep the harness can afford to wait out. Finishing
 * it proves the default exceeds this and says nothing about how far.
 */
export const DEFAULT_PROBE_SLEEP_MS = 70_000;

/** How much longer than the configured timeout a cut may take before it is not that cut. */
export const CUT_TOLERANCE_MS = 30_000;

function prompt(ms: number): string {
  return [
    `Call the tool mcp__handoff__sleep_ms exactly once with ms set to ${String(ms)}.`,
    'It is expected to take a long time; wait for it, and do not call it again.',
    'Then reply with exactly DONE and nothing else.',
  ].join(' ');
}

function sleepEnd(run: CanaryRun): Record<string, unknown> | undefined {
  return firstObservation(run, 'sleep_end');
}

function calledSleep(run: CanaryRun): Assertion {
  return check(
    'model',
    'the agent calls sleep_ms once, as the prompt asked',
    'model',
    firstObservation(run, 'sleep_start') !== undefined,
    `tool uses ${JSON.stringify(run.toolUses.map((use) => use.name))}`,
  );
}

/** The tool result the agent saw, whatever the server thought: error text or nothing. */
function agentSawFailure(run: CanaryRun): boolean {
  return run.toolResults.some((result) => result.isError);
}

/**
 * One of the two bounded-timeout scenarios. They differ only in where the number is
 * written, which is exactly the difference A-03 and A-04 are about.
 */
function boundedTimeout(options: {
  readonly id: string;
  readonly assumption: 'A-03' | 'A-04';
  readonly title: string;
  readonly where: string;
  readonly runOptions: Record<string, unknown>;
}): Scenario {
  return {
    id: options.id,
    title: options.title,
    covers: [options.assumption, 'A-09'],
    options: {
      prompt: prompt(LONG_SLEEP_MS),
      maxTurns: 4,
      timeoutMs: LONG_SLEEP_MS + 180_000,
      ...options.runOptions,
    },

    check(run) {
      const end = sleepEnd(run);
      const waited = typeof end?.['waited_ms'] === 'number' ? end['waited_ms'] : undefined;
      const cutShort = waited !== undefined && waited < LONG_SLEEP_MS - 1000;

      return [
        wellFormed(run),
        serverConnected(run),
        calledSleep(run),
        check(
          options.assumption,
          `a tool call that outlives the timeout in ${options.where} is cut short`,
          'protocol',
          cutShort || (end === undefined && agentSawFailure(run)),
          `outcome ${String(end?.['outcome'])} after ${String(waited)} ms, ` +
            `configured ${String(CONFIGURED_TIMEOUT_MS)} ms`,
        ),
        check(
          options.assumption,
          'the cut happens at about the configured value, so the field is milliseconds',
          'protocol',
          waited !== undefined && waited <= CONFIGURED_TIMEOUT_MS + CUT_TOLERANCE_MS,
          `waited ${String(waited)} ms against ${String(CONFIGURED_TIMEOUT_MS)} ms configured`,
        ),
        note(
          'A-09',
          'the server is told, by an MCP cancellation, rather than merely abandoned',
          end?.['outcome'] === 'aborted',
          `sleep_end outcome ${String(end?.['outcome'])}`,
        ),
      ];
    },

    facts(run) {
      const end = sleepEnd(run);
      return {
        configured_timeout_ms: CONFIGURED_TIMEOUT_MS,
        requested_sleep_ms: LONG_SLEEP_MS,
        observed_outcome: end?.['outcome'] ?? null,
        observed_waited_ms: end?.['waited_ms'] ?? null,
        agent_saw_error: agentSawFailure(run),
      };
    },
  };
}

export const timeoutHonouredScenario = boundedTimeout({
  id: 'a03-timeout-honoured',
  assumption: 'A-03',
  title: 'MCP_TOOL_TIMEOUT from the settings env block bounds a tool call',
  where: 'the settings env block',
  runOptions: { mcpToolTimeoutMs: CONFIGURED_TIMEOUT_MS },
});

export const perServerTimeoutScenario = boundedTimeout({
  id: 'a04-per-server-timeout',
  assumption: 'A-04',
  title: 'the per-server timeout field of the MCP entry bounds a tool call',
  where: 'the per-server timeout field',
  runOptions: { perServerTimeoutMs: CONFIGURED_TIMEOUT_MS },
});

export const defaultTimeoutScenario: Scenario = {
  id: 'a03-timeout-default',
  title: 'with no timeout configured, a long tool call is not cut short (bounded probe)',
  covers: ['A-03'],
  options: {
    prompt: prompt(DEFAULT_PROBE_SLEEP_MS),
    maxTurns: 4,
    timeoutMs: DEFAULT_PROBE_SLEEP_MS + 180_000,
  },

  check(run) {
    const end = sleepEnd(run);
    const waited = typeof end?.['waited_ms'] === 'number' ? end['waited_ms'] : undefined;

    return [
      wellFormed(run),
      serverConnected(run),
      calledSleep(run),
      check(
        'A-03',
        `the default tool timeout is longer than ${String(DEFAULT_PROBE_SLEEP_MS)} ms`,
        'protocol',
        end?.['outcome'] === 'completed' && waited !== undefined,
        `outcome ${String(end?.['outcome'])} after ${String(waited)} ms with nothing configured`,
      ),
    ];
  },

  facts(run) {
    const end = sleepEnd(run);
    return {
      probe_sleep_ms: DEFAULT_PROBE_SLEEP_MS,
      observed_outcome: end?.['outcome'] ?? null,
      observed_waited_ms: end?.['waited_ms'] ?? null,
      default_timeout_ms_lower_bound:
        end?.['outcome'] === 'completed' ? DEFAULT_PROBE_SLEEP_MS : null,
    };
  },
};

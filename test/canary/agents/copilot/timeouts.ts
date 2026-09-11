/**
 * The Copilot timeout canaries (T-072; Appendix B A-04 and A-09 read for Copilot, FM-04;
 * TECHNICAL-DESIGN §5.6, §5.7).
 *
 * Two runs of the probe's `sleep_ms`. The first gives our entry of `mcp-config.json` a per-server
 * `timeout` of 20 000 ms — the field `copilot mcp add --timeout <ms>` writes — and sleeps past it:
 * a cut near 20 s is A-04 holding, and a cancellation the server receives is A-09. The second
 * configures nothing and sleeps past the default the copilot row states. Where the row states
 * no default, finishing uncut is what it predicts, and the run bounds the default from below.
 *
 * VS Code's side is not measured here: its chat cannot be driven from a script, and its MCP
 * client sends a tool call with no timeout of its own (read from the 1.137.0 bundle), so the
 * CLI's is the limit the row states and the heartbeat has to beat.
 */
import { check, note, type Assertion } from '../../classify.ts';
import { firstObservation, type CanaryRun } from '../../runner.ts';
import { wellFormed } from '../../scenarios/scenario.ts';
import { HEARTBEAT_FLOOR_MS } from '../codex/timeouts.ts';
import {
  copilotRow,
  serverLoaded,
  serverRegistered,
  toolCallDurationMs,
  usageOf,
  type CopilotCliScenario,
} from './scenario.ts';

/** The per-server timeout the first run writes, in milliseconds. */
export const COPILOT_PER_SERVER_TIMEOUT_MS = 20_000;

/** What the first run sleeps: long enough that finishing means the field was not honoured. */
export const COPILOT_PAST_FIELD_SLEEP_MS = 60_000;

/** What the second run sleeps: long enough that finishing means nothing cut it. */
export const COPILOT_LONG_SLEEP_MS = 90_000;

/** How far past the expected value a cut may land and still be that cut. */
export const COPILOT_CUT_TOLERANCE_MS = 30_000;

function prompt(ms: number): string {
  return [
    `Call the tool sleep_ms of the MCP server handoff exactly once with ms set to ${String(ms)}.`,
    'It is expected to take a long time; wait for it, and do not call it again.',
    'Then reply with exactly DONE and nothing else.',
  ].join(' ');
}

function within(ms: number | undefined, target: number): boolean {
  return ms !== undefined && ms >= target - 2_000 && ms <= target + COPILOT_CUT_TOLERANCE_MS;
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

function sleepCalled(run: CanaryRun): Assertion {
  return check(
    'model',
    'the agent calls sleep_ms once, as the prompt asked',
    'model',
    firstObservation(run, 'sleep_start') !== undefined,
    `tool uses ${JSON.stringify(run.toolUses.map((use) => use.name))}`,
  );
}

function sleepFacts(run: CanaryRun, sleptMs: number): Record<string, unknown> {
  const end = firstObservation(run, 'sleep_end');
  return {
    probe_sleep_ms: sleptMs,
    observed_outcome: end?.['outcome'] ?? null,
    observed_waited_ms: waited(run) ?? null,
    observed_ms_per_copilot: toolCallDurationMs(run, 'sleep_ms') ?? null,
    server_told: end?.['outcome'] === 'aborted',
    agent_saw_error: sleepResult(run)?.isError ?? null,
    agent_error: (sleepResult(run)?.text ?? '').slice(0, 80),
    usage: usageOf(run),
  };
}

export const copilotPerServerTimeoutScenario: CopilotCliScenario = {
  id: 'copilot-per-server-timeout',
  title: 'the per-server timeout of mcp-config.json cuts a call, and the server is told',
  covers: ['A-04', 'A-09'],
  surface: 'cli',
  options: {
    prompt: prompt(COPILOT_PAST_FIELD_SLEEP_MS),
    perServerTimeoutMs: COPILOT_PER_SERVER_TIMEOUT_MS,
    timeoutMs: COPILOT_PAST_FIELD_SLEEP_MS + 180_000,
  },

  check(run) {
    const end = firstObservation(run, 'sleep_end');
    const told = end?.['outcome'] === 'aborted';
    const expectedTold = copilotRow().cancellation_notifications === true;
    const agentSide = toolCallDurationMs(run, 'sleep_ms');
    return [
      wellFormed(run),
      serverLoaded(run),
      serverRegistered(run),
      sleepCalled(run),
      check(
        'A-04',
        `the call is cut at the per-server timeout of ${String(COPILOT_PER_SERVER_TIMEOUT_MS)} ms`,
        'protocol',
        end?.['outcome'] !== 'completed' &&
          within(waited(run) ?? agentSide, COPILOT_PER_SERVER_TIMEOUT_MS),
        `sleep_end ${String(end?.['outcome'])} after ${String(waited(run))} ms, the CLI says ` +
          `${String(agentSide)} ms; the agent saw ` +
          `"${(sleepResult(run)?.text ?? '').replace(/\s+/gu, ' ').slice(0, 120)}"`,
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

  facts: (run) => sleepFacts(run, COPILOT_PAST_FIELD_SLEEP_MS),
};

export const copilotDefaultTimeoutScenario: CopilotCliScenario = {
  id: 'copilot-default-timeout',
  title: 'a call with nothing configured ends where the default the table states says it does',
  covers: ['FM-04', 'A-09'],
  surface: 'cli',
  options: { prompt: prompt(COPILOT_LONG_SLEEP_MS), timeoutMs: COPILOT_LONG_SLEEP_MS + 180_000 },

  check(run) {
    const end = firstObservation(run, 'sleep_end');
    const row = copilotRow();
    const stated = row.tool_timeout_ms_default;
    const told = end?.['outcome'] === 'aborted';
    const expectedTold = row.cancellation_notifications === true;
    const agentSide = toolCallDurationMs(run, 'sleep_ms');
    return [
      wellFormed(run),
      serverLoaded(run),
      serverRegistered(run),
      sleepCalled(run),
      stated === null
        ? check(
            'FM-04',
            `with nothing configured a ${String(COPILOT_LONG_SLEEP_MS)} ms call finishes uncut, ` +
              'as a null tool_timeout_ms_default says',
            'protocol',
            end?.['outcome'] === 'completed',
            `sleep_end ${String(end?.['outcome'])} after ${String(waited(run))} ms`,
          )
        : check(
            'FM-04',
            `with nothing configured, a call is cut at tool_timeout_ms_default = ${String(stated)} ms`,
            'protocol',
            end?.['outcome'] !== 'completed' && within(waited(run) ?? agentSide, stated),
            `sleep_end ${String(end?.['outcome'])} after ${String(waited(run))} ms, the CLI says ` +
              `${String(agentSide)} ms; the agent saw ` +
              `"${(sleepResult(run)?.text ?? '').replace(/\s+/gu, ' ').slice(0, 120)}"`,
          ),
      check(
        'FM-04',
        `the ${String(HEARTBEAT_FLOOR_MS)} ms heartbeat lands before any default cut`,
        'protocol',
        stated === null || HEARTBEAT_FLOOR_MS < stated,
        `heartbeat ${String(HEARTBEAT_FLOOR_MS)} ms, default cut ${String(stated)} ms`,
      ),
      note(
        'A-09',
        `a cut call is ${expectedTold ? '' : 'not '}announced by an MCP cancellation, as ` +
          `cancellation_notifications = ${String(expectedTold)} says`,
        stated === null || told === expectedTold,
        `sleep_end ${String(end?.['outcome'])}`,
      ),
    ];
  },

  facts: (run) => sleepFacts(run, COPILOT_LONG_SLEEP_MS),
};

/**
 * What a canary scenario is (T-023, TECHNICAL-DESIGN §11.5).
 *
 * A scenario names the assumptions it re-verifies, says how to run the agent, turns one
 * `CanaryRun` into assertions, and — separately — reports the values it *measured*, which
 * are what `docs/agent-facts.md` and `src/adapters/capabilities.json` are written from. The
 * two are not the same thing: an assertion can pass while the number behind it moves, and
 * the number is the point of half of Appendix B.
 */
import type { Assertion } from '../classify.ts';
import type { CanaryRun, RunOptions } from '../runner.ts';

export interface Scenario {
  /** File-name id, also the key in the results document. */
  readonly id: string;
  /** One line, in the present tense, for the report. */
  readonly title: string;
  /** The Appendix B ids and §11.5 scenario ids this covers. */
  readonly covers: readonly string[];
  /** How the agent is launched. */
  readonly options: RunOptions;
  /** What was checked. Order is the order of the report. */
  check(run: CanaryRun): Assertion[];
  /** What was measured, for `docs/agent-facts.md`. Never a spec value. */
  facts?(run: CanaryRun): Record<string, unknown>;
}

/** The run is well formed at all: the shared first assertion of every scenario, of either agent. */
export function wellFormed(run: CanaryRun): Assertion {
  const reason = run.timedOut
    ? 'the run was killed at the harness timeout'
    : run.result === undefined
      ? 'the agent printed no result'
      : run.exitCode === 0
        ? ''
        : `the agent exited ${String(run.exitCode)}`;
  return {
    id: 'harness',
    what: 'the agent ran to a result',
    kind: 'protocol',
    ok: reason === '',
    ...(reason === '' ? {} : { detail: `${reason}; stderr: ${run.stderr.slice(0, 400)}` }),
  };
}

/** The server registered at all: the second shared assertion, and A-01's first half. */
export function serverConnected(run: CanaryRun): Assertion {
  const init = run.transcript.find(
    (message) => message.type === 'system' && message.subtype === 'init',
  );
  const entry = init?.mcp_servers?.find((server) => server.name === 'handoff');
  return {
    id: 'A-01',
    what: 'the agent reports the MCP server connected before the first turn',
    kind: 'protocol',
    ok: entry?.status === 'connected',
    detail: `mcp_servers: ${JSON.stringify(init?.mcp_servers ?? null)}`,
  };
}

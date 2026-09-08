/**
 * The observation canary: everything about a Claude Code session that can be measured
 * from one cheap run (T-023; Appendix B A-01, A-02, A-05, A-06, A-08, A-11, A-23, A-24).
 *
 * The agent is asked for one `handoff_runbooks` call, which never blocks and needs no
 * overlay, and the run is then read from three sides: the transcript for what the model
 * did, the probe's observation file for what the server saw, and the recording Stop hook's
 * file for what the hook was handed. Seven of the eight assumptions here are answered by
 * the last two, which is what makes them protocol assertions: no sampling of the model
 * changes whether `HANDOFF_AGENT` arrived.
 */
import { check, note, type Assertion } from '../classify.ts';
import { firstObservation, observationsOf, type CanaryRun } from '../runner.ts';
import { serverConnected, wellFormed, type Scenario } from './scenario.ts';

/** The five fields A-05 says a Stop hook payload carries. */
export const A05_REQUIRED_FIELDS = [
  'session_id',
  'transcript_path',
  'cwd',
  'hook_event_name',
  'stop_hook_active',
] as const;

/**
 * Prescriptive, and deliberately *not* forbidding other tools.
 *
 * Claude Code 2.1.263 does not put an MCP tool in the model's context directly: the tool
 * list of the session holds it, but the model reaches it through its own `ToolSearch`
 * first. A prompt that says "do not call any other tool" therefore forbids the one call
 * that makes the wanted call possible, and the scenario fails as a model failure for a
 * reason that is the harness's fault. Measured here on 2026-09-08; see
 * `docs/agent-facts.md`.
 */
const PROMPT = [
  'Call the tool mcp__handoff__handoff_runbooks exactly once, with where set to',
  '"Stripe dashboard" and goal set to "Add a webhook endpoint".',
  'Then reply with exactly DONE and nothing else.',
].join(' ');

function initialize(run: CanaryRun): Record<string, unknown> | undefined {
  return firstObservation(run, 'initialize');
}

function envPresent(run: CanaryRun): readonly string[] {
  const value = initialize(run)?.['env_present'];
  return Array.isArray(value) ? (value as readonly string[]) : [];
}

export const observeScenario: Scenario = {
  id: 'observe',
  title: 'one prescriptive tool call, with the recording Stop hook installed',
  covers: ['A-01', 'A-02', 'A-05', 'A-06', 'A-08', 'A-11', 'A-23', 'A-24'],
  options: { prompt: PROMPT, maxTurns: 6, stopHook: true },

  check(run) {
    const assertions: Assertion[] = [wellFormed(run), serverConnected(run)];

    const init = initialize(run);
    const calls = observationsOf(run, 'tool_call');
    const present = envPresent(run);
    const hooks = run.hookRecords;
    const first = hooks[0];
    const second = hooks[1];

    assertions.push(
      check(
        'A-01',
        'the server records initialize before the first tool call',
        'protocol',
        init !== undefined &&
          calls.length > 0 &&
          calls[0] !== undefined &&
          Date.parse(String(init['at'])) <= Date.parse(calls[0].at),
        `initialize at ${String(init?.['at'])}, first tool call at ${String(calls[0]?.at)}`,
      ),
      check(
        'A-02',
        'the env block of the MCP entry reaches the server process',
        'protocol',
        present.includes('HANDOFF_AGENT') && init?.['agent_id'] === 'claude-code',
        `env_present ${JSON.stringify(present)}, agent_id ${String(init?.['agent_id'])}`,
      ),
      check(
        'A-08',
        'the handshake carries a clientInfo name the table can match on',
        'protocol',
        typeof init?.['client_name'] === 'string' && init['client_name'] !== '',
        `clientInfo ${String(init?.['client_name'])} ${String(init?.['client_version'])}`,
      ),
      check(
        'A-24',
        'CLAUDE_PROJECT_DIR is set for the server process, not only for hooks',
        'protocol',
        present.includes('CLAUDE_PROJECT_DIR'),
        `project_dir_is_cwd ${String(init?.['project_dir_is_cwd'])}`,
      ),
      check(
        'A-23',
        'a variable whose name holds none of the stripped substrings is never dropped',
        'protocol',
        present.includes('HANDOFF_PROBE'),
        `HANDOFF_PROBE ${present.includes('HANDOFF_PROBE') ? 'arrived' : 'was dropped'}, ` +
          `HANDOFF_PROBE_TOKEN ${present.includes('HANDOFF_PROBE_TOKEN') ? 'arrived' : 'was dropped'}`,
      ),
      check(
        'A-06',
        'a Stop hook declared in the project settings runs under claude -p',
        'protocol',
        hooks.length > 0,
        `${String(hooks.length)} hook invocations`,
      ),
      check(
        'A-05',
        'the Stop hook payload carries the five documented fields',
        'protocol',
        first !== undefined && A05_REQUIRED_FIELDS.every((field) => field in first.input),
        `fields ${JSON.stringify(Object.keys(first?.input ?? {}))}`,
      ),
      check(
        'A-05',
        'a block decision continues the run and the next invocation sets stop_hook_active',
        'protocol',
        first?.blocked === true &&
          second !== undefined &&
          second.input['stop_hook_active'] === true,
        `blocked ${String(first?.blocked)}, second stop_hook_active ` +
          String(second?.input['stop_hook_active']),
      ),
      check(
        'A-11',
        'the ancestor chain of the hook contains the pid of the agent that loaded the server',
        'protocol',
        first !== undefined &&
          typeof init?.['ppid'] === 'number' &&
          first.ancestors.includes(init['ppid']),
        `hook ancestors ${JSON.stringify(first?.ancestors ?? [])}, server ppid ` +
          String(init?.['ppid']),
      ),
      check(
        'model',
        'the agent calls handoff_runbooks once, as the prompt asked',
        'model',
        calls.filter((call) => call['method'] === 'handoff_runbooks').length === 1,
        `tool calls ${JSON.stringify(calls.map((call) => call['method']))}`,
      ),
      note(
        'A-01',
        'the agent starts one server process per session',
        observationsOf(run, 'initialize').length === 1,
        `${String(observationsOf(run, 'initialize').length)} initialize handshakes observed`,
      ),
    );

    return assertions;
  },

  facts(run) {
    const init = initialize(run);
    const first = run.hookRecords[0];
    return {
      client_name: init?.['client_name'] ?? null,
      client_version: init?.['client_version'] ?? null,
      agent_id: init?.['agent_id'] ?? null,
      support: init?.['support'] ?? null,
      env_present: envPresent(run),
      project_dir_is_cwd: init?.['project_dir_is_cwd'] ?? null,
      server_processes_per_session: observationsOf(run, 'initialize').length,
      stop_hook_input_fields: Object.keys(first?.input ?? {}).sort(),
      stop_hook_invocations: run.hookRecords.length,
      hook_ancestor_depth: first?.ancestors.length ?? 0,
      tool_names_offered:
        run.transcript
          .find((message) => message.type === 'system' && message.subtype === 'init')
          ?.tools?.filter((name) => name.startsWith('mcp__handoff__')) ?? [],
      model_tool_uses: run.toolUses.map((use) => use.name),
    };
  },
};

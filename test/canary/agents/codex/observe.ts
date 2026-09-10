/**
 * The Codex observation canary (T-066; Appendix B A-01, A-02, A-08, A-23, A-24 read for
 * Codex; SRV-19).
 *
 * One call of `handoff_runbooks`, the one tool Codex runs without asking because it is
 * annotated read-only, and the run is then read from the probe's observation file: which
 * `clientInfo` Codex sends, whether the `env` block of the entry arrives whole, whether the
 * two Windows names the pipe is derived from reach a server Codex starts, and in which
 * folder it starts it. Every one of those is a protocol fact that no sampling of the model
 * changes.
 */
import { check, note, type Assertion } from '../../classify.ts';
import { firstObservation, observationsOf, type CanaryRun } from '../../runner.ts';
import { wellFormed } from '../../scenarios/scenario.ts';
import { codexProjectOf } from './runner.ts';
import { codexRow, samePath, serverRegistered, type CodexScenario } from './scenario.ts';

const PROMPT = [
  'Call the tool handoff_runbooks of the MCP server handoff exactly once, with where set to',
  '"Stripe dashboard" and goal set to "Add a webhook endpoint".',
  'Then reply with exactly DONE and nothing else.',
].join(' ');

function envPresent(run: CanaryRun): readonly string[] {
  const value = firstObservation(run, 'initialize')?.['env_present'];
  return Array.isArray(value) ? (value as readonly string[]) : [];
}

function cwdIsProject(run: CanaryRun): boolean {
  const cwd = firstObservation(run, 'initialize')?.['cwd'];
  return typeof cwd === 'string' && samePath(cwd, codexProjectOf(run));
}

export const codexObserveScenario: CodexScenario = {
  id: 'codex-observe',
  title: 'one read-only tool call, and what the server saw of the Codex session',
  covers: ['A-01', 'A-02', 'A-08', 'A-23', 'A-24', 'SRV-19'],
  options: { prompt: PROMPT },

  check(run) {
    const init = firstObservation(run, 'initialize');
    const present = envPresent(run);
    const calls = observationsOf(run, 'tool_call');
    const clientName = init?.['client_name'];
    const known = codexRow().client_names;
    const pipeNames = present.includes('USERDOMAIN') && present.includes('USERNAME');

    const assertions: Assertion[] = [
      wellFormed(run),
      serverRegistered(run),
      check(
        'A-02',
        'the env block of the MCP entry reaches the server process',
        'protocol',
        present.includes('HANDOFF_AGENT') && init?.['agent_id'] === 'codex',
        `env_present ${JSON.stringify(present)}, agent_id ${String(init?.['agent_id'])}`,
      ),
      check(
        'A-08',
        'the handshake carries a clientInfo name the codex row matches',
        'protocol',
        typeof clientName === 'string' && known.includes(clientName),
        `clientInfo ${String(clientName)} ${String(init?.['client_version'])}, ` +
          `table ${JSON.stringify(known)}`,
      ),
      check(
        'A-23',
        'a variable whose name contains TOKEN is not dropped from the env block',
        'protocol',
        present.includes('HANDOFF_PROBE_TOKEN'),
        `HANDOFF_PROBE ${present.includes('HANDOFF_PROBE') ? 'arrived' : 'was dropped'}, ` +
          `HANDOFF_PROBE_TOKEN ${present.includes('HANDOFF_PROBE_TOKEN') ? 'arrived' : 'was dropped'}`,
      ),
      check(
        'A-24',
        'Codex starts the server in the project folder it was given',
        'protocol',
        cwdIsProject(run),
        `server working directory ${cwdIsProject(run) ? 'is' : 'is not'} the -C folder`,
      ),
      process.platform === 'win32'
        ? check(
            'SRV-19',
            'USERDOMAIN and USERNAME reach the server, so it derives the pipe the app listens on',
            'protocol',
            pipeNames,
            `env_present ${JSON.stringify(present)}`,
          )
        : note('SRV-19', 'the pipe names are a Windows fact; this platform uses a socket', true),
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
    ];
    return assertions;
  },

  facts(run) {
    const init = firstObservation(run, 'initialize');
    return {
      client_name: init?.['client_name'] ?? null,
      client_version: init?.['client_version'] ?? null,
      agent_id: init?.['agent_id'] ?? null,
      support: init?.['support'] ?? null,
      env_present: envPresent(run),
      server_cwd_is_project: cwdIsProject(run),
      server_processes_per_session: observationsOf(run, 'initialize').length,
      model_tool_uses: run.toolUses.map((use) => use.name),
      usage: run.result?.['usage'] ?? null,
    };
  },
};

/**
 * The Copilot CLI observation canary (T-072; Appendix B A-01, A-02, A-05, A-06, A-07, A-08,
 * A-11, A-23, A-24 read for Copilot; SRV-19).
 *
 * One run, because every run spends the account's AI credits (T-071): one call of
 * `handoff_runbooks`, read from the probe's observation file — which `clientInfo` the CLI
 * sends, whether the `env` of the entry arrives whole, whether the two Windows names the pipe
 * is derived from reach the server, in which folder the CLI starts it — then one call of
 * `image_probe`, whose colour the model has to name (A-07), and, around the turn, the recording
 * hooks: the CLI's own `sessionStart`, `agentStop` and `sessionEnd`, and the Claude Code `Stop`
 * of the project, to see whether the CLI runs that one too. The hooks are reported and never
 * decide the verdict: what matters for the row is whether any of them could reach
 * `handoff-mcp hook stop` with a payload it reads (`docs/agent-facts.md`).
 */
import { check, note, type Assertion } from '../../classify.ts';
import { firstObservation, observationsOf, type CanaryRun } from '../../runner.ts';
import { wellFormed } from '../../scenarios/scenario.ts';
import { copilotProjectOf } from './runner.ts';
import {
  copilotRow,
  hookRecordsOf,
  samePath,
  serverLoaded,
  serverRegistered,
  usageOf,
  type CopilotCliScenario,
} from './scenario.ts';

const PROMPT = [
  'Call the tool handoff_runbooks of the MCP server handoff exactly once, with where set to',
  '"Stripe dashboard" and goal set to "Add a webhook endpoint".',
  'Then call the tool image_probe of the MCP server handoff exactly once:',
  'its result contains an image that is one solid colour.',
  'Reply with only the name of that colour in lower case,',
  'or with NO IMAGE if you cannot see an image.',
].join(' ');

/** The labels the recorder is declared under (`workspace.ts`). */
const HOOK_LABELS = [
  'copilot-session-start',
  'copilot-agent-stop',
  'copilot-session-end',
  'claude-stop',
  'claude-stop-user',
] as const;

function envPresent(run: CanaryRun): readonly string[] {
  const value = firstObservation(run, 'initialize')?.['env_present'];
  return Array.isArray(value) ? (value as readonly string[]) : [];
}

function cwdIsProject(run: CanaryRun): boolean {
  const cwd = firstObservation(run, 'initialize')?.['cwd'];
  return typeof cwd === 'string' && samePath(cwd, copilotProjectOf(run));
}

function painted(run: CanaryRun): string | undefined {
  const colour = firstObservation(run, 'image_probe')?.['colour'];
  return typeof colour === 'string' ? colour : undefined;
}

function reply(run: CanaryRun): string {
  return (run.result?.result ?? '').trim().toLowerCase();
}

function namedTheColour(run: CanaryRun): boolean {
  const colour = painted(run);
  return colour !== undefined && reply(run).includes(colour);
}

function calls(run: CanaryRun, method: string): number {
  return observationsOf(run, 'tool_call').filter((call) => call['method'] === method).length;
}

/** What each declaration of the recording hook was handed, by name only. */
function hookFacts(run: CanaryRun, label: string): Record<string, unknown> | null {
  const records = hookRecordsOf(run, label);
  const first = records[0];
  if (first === undefined) return null;
  return {
    invocations: records.length,
    keys: first.keys ?? [],
    values: first.input,
    chain_names: first.ancestor_names ?? [],
    env_present: first.env_present ?? [],
  };
}

export const copilotObserveScenario: CopilotCliScenario = {
  id: 'copilot-observe',
  title: 'one read-only call, one image, and the hooks around the turn, read for the CLI',
  covers: ['A-01', 'A-02', 'A-05', 'A-06', 'A-07', 'A-08', 'A-11', 'A-23', 'A-24', 'SRV-19'],
  surface: 'cli',
  options: { prompt: PROMPT, recordHooks: true },

  check(run) {
    const init = firstObservation(run, 'initialize');
    const present = envPresent(run);
    const clientName = init?.['client_name'];
    const row = copilotRow();
    const expectedImages = row.images_in_results === true;
    const agentStop = hookRecordsOf(run, 'copilot-agent-stop')[0];
    const claudeStop = hookRecordsOf(run, 'claude-stop')[0];
    const handed = agentStop ?? claudeStop;

    const assertions: Assertion[] = [
      wellFormed(run),
      serverLoaded(run),
      serverRegistered(run),
      check(
        'A-02',
        'the env of the MCP entry reaches the server process',
        'protocol',
        present.includes('HANDOFF_AGENT') && init?.['agent_id'] === 'copilot',
        `env_present ${JSON.stringify(present)}, agent_id ${String(init?.['agent_id'])}`,
      ),
      check(
        'A-08',
        'the handshake carries a clientInfo name the copilot row matches',
        'protocol',
        typeof clientName === 'string' && row.client_names.includes(clientName),
        `clientInfo ${String(clientName)} ${String(init?.['client_version'])}, ` +
          `table ${JSON.stringify(row.client_names)}`,
      ),
      check(
        'A-23',
        'a variable whose name contains TOKEN is not dropped from the environment',
        'protocol',
        present.includes('HANDOFF_PROBE_TOKEN'),
        `HANDOFF_PROBE_TOKEN ${present.includes('HANDOFF_PROBE_TOKEN') ? 'arrived' : 'was dropped'}`,
      ),
      check(
        'A-24',
        'the CLI starts the server in the folder it works in',
        'protocol',
        cwdIsProject(run),
        `server working directory ${cwdIsProject(run) ? 'is' : 'is not'} the run's folder`,
      ),
      process.platform === 'win32'
        ? check(
            'SRV-19',
            'USERDOMAIN and USERNAME reach the server, so it derives the pipe the app listens on',
            'protocol',
            present.includes('USERDOMAIN') && present.includes('USERNAME'),
            `env_present ${JSON.stringify(present)}`,
          )
        : note('SRV-19', 'the pipe names are a Windows fact; this platform uses a socket', true),
      check(
        'model',
        'the agent calls handoff_runbooks once and image_probe once, as the prompt asked',
        'model',
        calls(run, 'handoff_runbooks') === 1 && painted(run) !== undefined,
        `tool calls ${JSON.stringify(observationsOf(run, 'tool_call').map((call) => call['method']))}`,
      ),
      check(
        'A-07',
        `the model ${expectedImages ? 'names' : 'cannot name'} the colour, as images_in_results ` +
          `= ${String(expectedImages)} says`,
        'model',
        namedTheColour(run) === expectedImages,
        `painted ${String(painted(run))}, reply "${reply(run).slice(0, 40)}"`,
      ),
      note(
        'A-06',
        "the CLI's own agentStop hook, declared in its config.json, runs under -p",
        agentStop !== undefined,
        `${String(hookRecordsOf(run, 'copilot-agent-stop').length)} invocations`,
      ),
      note(
        'A-06',
        "a Claude Code Stop hook in the project's .claude/settings.json runs as the CLI's own",
        claudeStop !== undefined,
        `${String(hookRecordsOf(run, 'claude-stop').length)} invocations`,
      ),
      note(
        'A-06',
        "a Claude Code Stop hook in the user's ~/.claude/settings.json, where Baton's Claude Code " +
          "adapter writes it, runs as the CLI's own",
        hookRecordsOf(run, 'claude-stop-user').length > 0,
        `${String(hookRecordsOf(run, 'claude-stop-user').length)} invocations`,
      ),
      note(
        'A-05',
        'the stop payload says whether it is a re-entry the way handoff-mcp hook stop reads it, ' +
          `and stop_hook = ${String(row.stop_hook)}`,
        handed !== undefined,
        handed === undefined ? 'no stop hook ran' : `keys ${JSON.stringify(handed.keys ?? [])}`,
      ),
      note(
        'A-01',
        'the CLI starts one server process for the run',
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
      painted: painted(run) ?? null,
      reply: reply(run).slice(0, 40),
      image_reached_model: namedTheColour(run),
      hooks: Object.fromEntries(HOOK_LABELS.map((label) => [label, hookFacts(run, label)])),
      model_tool_uses: run.toolUses.map((use) => use.name),
      usage: usageOf(run),
    };
  },
};

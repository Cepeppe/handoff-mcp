/**
 * The degraded path, against the real GitHub Copilot CLI and an overlay that is listening (T-072;
 * FM-03, FM-04, SRV-20; TECHNICAL-DESIGN §4.7.4, §5.7; R-12 for the CLI's side).
 *
 * Copilot is `base` for the reason Cursor is: no end-of-turn hook of Copilot's reaches
 * `handoff-mcp hook stop` with an answer the agent honours on both surfaces
 * (`docs/agent-facts.md`), so the heartbeat and the text of the instruction are what keep a
 * long handoff alive. The flow and its assertions are the Codex ones of `../codex/degraded.ts`,
 * imported. Nothing configures a timeout, so the heartbeat is the row's.
 *
 * Two assertions are the CLI's own, read from the `hello` the overlay received: the session
 * keeps the `parent_pid` key — the CLI starts the server itself, so no editor is above it and
 * the hello names none — and its project folder is the folder the CLI works in.
 */
import { check, type Assertion } from '../../classify.ts';
import type { CanaryRun } from '../../runner.ts';
import { CANARY_SPEC } from '../../scenarios/e2e-08-text-mode.ts';
import { startScriptedApp, type AppScript } from '../codex/app.ts';
import { DEGRADED_PATH_SCRIPT, codexDegradedPathScenario } from '../codex/degraded.ts';
import { copilotProjectOf } from './runner.ts';
import {
  samePath,
  serverHello,
  serverLoaded,
  usageOf,
  type CopilotCliScenario,
} from './scenario.ts';

/** The overlay's script: the Codex one, under a name of its own. */
export const COPILOT_DEGRADED_PATH_SCRIPT: AppScript = {
  ...DEGRADED_PATH_SCRIPT,
  name: 'copilot-degraded-path',
};

const PROMPT = [
  'Call the tool handoff_to_user of the MCP server handoff with this exact argument:',
  JSON.stringify({ spec: CANARY_SPEC }),
  'The call blocks while a person does the steps.',
  'Every result it returns has a status and an instruction:',
  'do exactly what the instruction says, including calling handoff_to_user again when it',
  'tells you to, until a result has final set to true.',
  'Then reply with exactly DONE and nothing else.',
].join(' ');

function helloFacts(run: CanaryRun): {
  readonly sessionIdentity: unknown;
  readonly projectDir: string;
  readonly ancestors: number;
} {
  const hello = serverHello(run);
  const identity = (hello?.['identity'] ?? {}) as Record<string, unknown>;
  const row = (hello?.['capability_row'] ?? {}) as Record<string, unknown>;
  return {
    sessionIdentity: row['session_identity'],
    projectDir: typeof identity['project_dir'] === 'string' ? identity['project_dir'] : '',
    ancestors: Array.isArray(identity['ancestors']) ? identity['ancestors'].length : 0,
  };
}

export const copilotDegradedPathScenario: CopilotCliScenario = {
  id: 'copilot-degraded-path',
  title: 'heartbeat, resume, and a deferral remembered with no hook, against a listening overlay',
  covers: ['FM-03', 'FM-04', 'SRV-20', 'R-12'],
  surface: 'cli',
  options: {
    prompt: PROMPT,
    app: (home) => startScriptedApp(home, COPILOT_DEGRADED_PATH_SCRIPT),
  },

  check(run) {
    const hello = helloFacts(run);
    const registered = serverHello(run) !== undefined;
    const [first, ...rest] = codexDegradedPathScenario.check(run);
    const assertions: Assertion[] = [
      ...(first === undefined ? [] : [first]),
      serverLoaded(run),
      ...rest,
      check(
        'R-12',
        "the CLI's session keeps the parent_pid key: its hello names no editor",
        'protocol',
        registered && hello.sessionIdentity === undefined,
        `session_identity ${String(hello.sessionIdentity)}, ${String(hello.ancestors)} ancestors sent`,
      ),
      check(
        'SRV-18',
        "the project folder of the CLI's session is the folder the CLI works in",
        'protocol',
        registered && samePath(hello.projectDir, copilotProjectOf(run)),
        `project_dir ${samePath(hello.projectDir, copilotProjectOf(run)) ? 'is' : 'is not'} the run's folder`,
      ),
    ];
    return assertions;
  },

  facts(run) {
    const hello = helloFacts(run);
    return {
      ...(codexDegradedPathScenario.facts?.(run) ?? {}),
      hello_session_identity: hello.sessionIdentity ?? null,
      hello_ancestors_sent: hello.ancestors,
      usage: usageOf(run),
    };
  },
};

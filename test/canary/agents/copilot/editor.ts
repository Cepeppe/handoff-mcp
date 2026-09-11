/**
 * The session identity of the server VS Code starts: Copilot's editor surface (T-072;
 * TECHNICAL-DESIGN §5.6, §5.8, §7.5, §14 R-12; SRV-17, SRV-18, SRV-19).
 *
 * The same acceptance T-069 measured for Cursor, for the second editor that reuses its code: a
 * session VS Code starts registers with a chain that contains VS Code's process, keyed
 * `ancestor_chain:editor`, and with the workspace as its project although VS Code starts the
 * server in the user's home folder and puts the workspace in no variable — the server asks the
 * client's MCP roots for it (T-072). VS Code is launched on a throw-away project
 * (`editor-runner.ts`) and our server registers with a scripted overlay that only has to accept
 * it, so the run spends no credit.
 */
import { check, note, type Assertion } from '../../classify.ts';
import { firstObservation, observationsOf, type CanaryRun } from '../../runner.ts';
import { startScriptedApp, type AppScript } from '../codex/app.ts';
import { vscodeHomeOf, vscodeProjectOf } from './editor-runner.ts';
import { copilotRow, samePath, serverHello, type CopilotEditorScenario } from './scenario.ts';

/** The overlay's script: nothing to do but accept the registration. */
export const COPILOT_EDITOR_REGISTER_SCRIPT: AppScript = {
  name: 'copilot-editor-register',
  why: 'Only the registration matters here: the starter extension has VS Code start its servers without a chat.',
  actions: [],
};

interface HelloView {
  readonly sessionIdentity: unknown;
  readonly ancestors: readonly { readonly pid: number; readonly name: string }[];
  readonly projectDir: string;
  readonly cwd: string;
}

function helloView(run: CanaryRun): HelloView | undefined {
  const hello = serverHello(run);
  if (hello === undefined) return undefined;
  const identity = (hello['identity'] ?? {}) as Record<string, unknown>;
  const row = (hello['capability_row'] ?? {}) as Record<string, unknown>;
  const ancestors = Array.isArray(identity['ancestors'])
    ? (identity['ancestors'] as { pid: number; name: string }[])
    : [];
  return {
    sessionIdentity: row['session_identity'],
    ancestors,
    projectDir: typeof identity['project_dir'] === 'string' ? identity['project_dir'] : '',
    cwd: typeof identity['cwd'] === 'string' ? identity['cwd'] : '',
  };
}

function envPresent(run: CanaryRun): readonly string[] {
  const value = firstObservation(run, 'initialize')?.['env_present'];
  return Array.isArray(value) ? (value as readonly string[]) : [];
}

export const copilotEditorIdentityScenario: CopilotEditorScenario = {
  id: 'copilot-editor-identity',
  title:
    'the server VS Code starts registers keyed on the editor, with the workspace its client names',
  covers: ['R-12', 'SRV-17', 'SRV-18', 'SRV-19', 'A-08'],
  surface: 'editor',
  options: { app: (home) => startScriptedApp(home, COPILOT_EDITOR_REGISTER_SCRIPT) },

  check(run) {
    const view = helloView(run);
    const launched = run.launched?.pid;
    const clientName = firstObservation(run, 'initialize')?.['client_name'];
    const roots = firstObservation(run, 'roots');
    const present = envPresent(run);
    const assertions: Assertion[] = [
      check(
        'harness',
        'VS Code starts the server and the server registers',
        'protocol',
        view !== undefined,
        run.stderr === '' ? `registered after ${String(run.durationMs)} ms` : run.stderr,
      ),
      check(
        'A-08',
        'the handshake carries a clientInfo name the copilot row matches',
        'protocol',
        typeof clientName === 'string' && copilotRow().client_names.includes(clientName),
        `clientInfo ${String(clientName)}, table ${JSON.stringify(copilotRow().client_names)}`,
      ),
      check(
        'R-12',
        'the hello is keyed on the editor: session_identity is ancestor_chain:editor',
        'protocol',
        view?.sessionIdentity === 'ancestor_chain:editor',
        `session_identity ${String(view?.sessionIdentity)}`,
      ),
      check(
        'SRV-17',
        'the chain the server sends contains the VS Code that was launched',
        'protocol',
        launched !== undefined && (view?.ancestors ?? []).some((entry) => entry.pid === launched),
        `chain ${JSON.stringify((view?.ancestors ?? []).map((entry) => entry.name))}, editor ` +
          (launched === undefined ? 'not launched' : 'launched'),
      ),
      check(
        'SRV-18',
        "the project folder is the window's workspace, as the client's roots name it, not the home folder",
        'protocol',
        view !== undefined && samePath(view.projectDir, vscodeProjectOf(run)),
        `project_dir ${view !== undefined && samePath(view.projectDir, vscodeProjectOf(run)) ? 'is' : 'is not'} the workspace; ` +
          `cwd ${view !== undefined && samePath(view.cwd, vscodeHomeOf(run)) ? 'is' : 'is not'} the home folder; ` +
          `roots ${JSON.stringify(roots === undefined ? null : { count: roots['count'], used: roots['used'] })}`,
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
      note(
        'A-01',
        'VS Code starts one server process for the window',
        observationsOf(run, 'initialize').length === 1,
        `${String(observationsOf(run, 'initialize').length)} initialize handshakes observed`,
      ),
    ];
    return assertions;
  },

  facts(run) {
    const view = helloView(run);
    const init = firstObservation(run, 'initialize');
    const roots = firstObservation(run, 'roots');
    const launched = run.launched?.pid;
    return {
      client_name: init?.['client_name'] ?? null,
      client_version: init?.['client_version'] ?? null,
      agent_id: init?.['agent_id'] ?? null,
      session_identity: view?.sessionIdentity ?? null,
      chain_names: (view?.ancestors ?? []).map((entry) => entry.name),
      editor_in_chain:
        launched !== undefined && (view?.ancestors ?? []).some((entry) => entry.pid === launched),
      editor_position_in_chain:
        launched === undefined
          ? null
          : (view?.ancestors ?? []).findIndex((entry) => entry.pid === launched),
      roots_count: roots?.['count'] ?? null,
      project_is_workspace: view !== undefined && samePath(view.projectDir, vscodeProjectOf(run)),
      server_cwd_is_home: view !== undefined && samePath(view.cwd, vscodeHomeOf(run)),
      env_present: envPresent(run),
      server_processes: observationsOf(run, 'initialize').length,
      registered_after_ms: view === undefined ? null : run.durationMs,
    };
  },
};

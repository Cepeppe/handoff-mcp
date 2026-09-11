/**
 * The session identity of the server Cursor's editor starts (T-069; TECHNICAL-DESIGN §5.6,
 * §5.8, §7.5, §14 R-12; SRV-17, SRV-18, SRV-19).
 *
 * The acceptance of T-069, measured rather than assumed: a session the editor starts registers
 * with a chain that contains the editor's process, keyed `ancestor_chain:editor`, and with the
 * workspace as its project although the editor starts the server in the user's home folder.
 * The editor is launched on a throw-away project (`editor-runner.ts`) and our server registers
 * with a scripted overlay that only has to accept it, so the run spends no agent request.
 */
import { check, note, type Assertion } from '../../classify.ts';
import { firstObservation, observationsOf, type CanaryRun } from '../../runner.ts';
import { startScriptedApp, type AppScript } from '../codex/app.ts';
import { cursorEditorHomeOf, cursorEditorProjectOf } from './editor-runner.ts';
import { cursorRow, samePath, serverHello, type CursorEditorScenario } from './scenario.ts';

/** The overlay's script: nothing to do but accept the registration. */
export const CURSOR_EDITOR_REGISTER_SCRIPT: AppScript = {
  name: 'cursor-editor-register',
  why: "Only the registration matters here: Cursor's editor starts its servers as a window opens, before any chat.",
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

export const cursorEditorIdentityScenario: CursorEditorScenario = {
  id: 'cursor-editor-identity',
  title:
    "the server Cursor's editor starts registers keyed on the editor, with the workspace as its project",
  covers: ['R-12', 'SRV-17', 'SRV-18', 'SRV-19', 'A-08'],
  surface: 'editor',
  options: { app: (home) => startScriptedApp(home, CURSOR_EDITOR_REGISTER_SCRIPT) },

  check(run) {
    const view = helloView(run);
    const launched = run.launched?.pid;
    const clientName = firstObservation(run, 'initialize')?.['client_name'];
    const present = envPresent(run);
    const assertions: Assertion[] = [
      check(
        'harness',
        "Cursor's editor starts the server and the server registers",
        'protocol',
        view !== undefined,
        run.stderr === '' ? `registered after ${String(run.durationMs)} ms` : run.stderr,
      ),
      check(
        'A-08',
        'the handshake carries a clientInfo name the cursor row matches',
        'protocol',
        typeof clientName === 'string' && cursorRow().client_names.includes(clientName),
        `clientInfo ${String(clientName)}, table ${JSON.stringify(cursorRow().client_names)}`,
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
        'the chain the server sends contains the editor that was launched',
        'protocol',
        launched !== undefined && (view?.ancestors ?? []).some((entry) => entry.pid === launched),
        `chain ${JSON.stringify((view?.ancestors ?? []).map((entry) => entry.name))}, editor ` +
          (launched === undefined ? 'not launched' : 'launched'),
      ),
      check(
        'SRV-18',
        "the project folder is the editor's workspace, not the home folder it starts servers in",
        'protocol',
        view !== undefined && samePath(view.projectDir, cursorEditorProjectOf(run)),
        `project_dir ${view !== undefined && samePath(view.projectDir, cursorEditorProjectOf(run)) ? 'is' : 'is not'} the workspace; ` +
          `cwd ${view !== undefined && samePath(view.cwd, cursorEditorHomeOf(run)) ? 'is' : 'is not'} the home folder`,
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
        'the editor starts one server process for the window',
        observationsOf(run, 'initialize').length === 1,
        `${String(observationsOf(run, 'initialize').length)} initialize handshakes observed`,
      ),
    ];
    return assertions;
  },

  facts(run) {
    const view = helloView(run);
    const init = firstObservation(run, 'initialize');
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
      project_is_workspace:
        view !== undefined && samePath(view.projectDir, cursorEditorProjectOf(run)),
      server_cwd_is_home: view !== undefined && samePath(view.cwd, cursorEditorHomeOf(run)),
      env_present: envPresent(run),
      server_processes: observationsOf(run, 'initialize').length,
      registered_after_ms: view === undefined ? null : run.durationMs,
    };
  },
};

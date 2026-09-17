/**
 * The command line and the environment of one `kilo run` (T-081, TECHNICAL-DESIGN §11.5, and
 * implementation decision 13, which makes Kilo Code the fifth agent). The Kilo Code
 * twin of `../opencode/workspace.ts`, and pure for the same reason:
 * `test/unit/canary/kilo-code.test.ts` pins every shape here without a real agent, so a
 * malformed configuration cannot make every Kilo Code canary fail for a reason that has nothing
 * to do with Kilo.
 *
 * Kilo's CLI is a fork of OpenCode, and what keeps a run off the user's own configuration is
 * OpenCode's recipe under Kilo's names, measured against Kilo 7.6.2 on 2026-09-12 (T-080,
 * then again by these canaries):
 *
 * 1. **Our server is declared in `KILO_CONFIG_CONTENT`**, Kilo's inline configuration, so
 *    nothing is written into a file Kilo reads — and Kilo rewrites the files it reads (T-080).
 * 2. **`XDG_CONFIG_HOME` points at an empty folder of the run.** Kilo's global configuration is
 *    `$XDG_CONFIG_HOME/kilo/`, `~/.config/kilo/` otherwise, on Windows too; `kilo debug paths`
 *    showed that the variable moves that folder and nothing else, so the login, which lives in
 *    Kilo's data folder, is kept. Kilo writes a `.gitignore` and a `.bash-permission-migrated`
 *    marker into the folder it is given, which is the run's and goes with it.
 * 3. **`KILO_DISABLE_PROJECT_CONFIG=1`.** Kilo reads a project's `kilo.json` and
 *    `.kilo/kilo.json` with no trust step (T-080), and the run's folder is under the user's home.
 * 4. **`KILO_DISABLE_CLAUDE_CODE=1`**, so Claude Code's own files stay out; **`--pure`**, no
 *    external plugin, Kilo's two default plugins among them; **`KILO_DISABLE_SHARE=1`** and
 *    **`KILO_DISABLE_AUTOUPDATE=1`**, as for OpenCode. Every other `KILO_*` variable of the
 *    parent is dropped, because several of them point Kilo at more configuration
 *    (`KILO_CONFIG`, `KILO_CONFIG_DIR`, `KILO_PERMISSION`) or at a server of the editor's.
 *
 * `kilo run` has no ephemeral mode, so the runner deletes the run's session once it has read it
 * (`kilo session delete <id>`), by the id the run printed: `kilo session list` lists every Kilo
 * session on the machine, the owner's own included (T-080).
 *
 * No `permission` entry is written: `kilo run` called an MCP tool without asking (T-080).
 */
import { PROBE_ENV_VALUE } from '../../workspace.ts';

/** The name our server is declared under. Kilo names its tools `handoff_<tool>`, as OpenCode. */
export const KILO_MCP_SERVER_NAME = 'handoff';

/** The `HANDOFF_AGENT` the installer writes for Kilo Code (§5.6), and the table's key. */
export const KILO_AGENT_ID = 'kilo-code';

/**
 * The model every Kilo Code canary runs on unless `HANDOFF_CANARY_KILO_CODE_MODEL` says
 * otherwise: the free auto-router of the Kilo Gateway, the provider the owner runs Kilo with
 * (T-080). Free means a canary spends nothing. Nothing in the server or in the adapter names a
 * provider: only the harness pins one.
 */
export const KILO_DEFAULT_MODEL = 'kilo/kilo-auto/free';

/**
 * The model of the image scenario: a free model of the same Gateway that reads images. The
 * auto-router is listed with `attachment: false` (`kilo models kilo --verbose`), and on it the
 * model answered "no image" twice (measured on 2026-09-12); Kilo hands a tool's image to the
 * model the session runs, so the scenario names one whose `attachment` is `true`, whatever
 * `HANDOFF_CANARY_KILO_CODE_MODEL` picks for the other scenarios.
 */
export const KILO_IMAGE_MODEL = 'kilo/inclusionai/ling-3.0-flash-vl:free';

/** The session title, so that Kilo does not name a session after its prompt. */
export const KILO_SESSION_TITLE = 'handoff canary';

/** The switches every run sets, whatever the parent had. */
export const KILO_ISOLATION_ENV: Readonly<Record<string, string>> = {
  KILO_DISABLE_PROJECT_CONFIG: '1',
  KILO_DISABLE_CLAUDE_CODE: '1',
  KILO_DISABLE_SHARE: '1',
  KILO_DISABLE_AUTOUPDATE: '1',
};

/**
 * Variables of the parent that would tell the server something about the harness rather than
 * about Kilo. Kilo hands its whole environment to the servers it starts (T-080), and a harness
 * run from a shell inside an editor carries the editor's pointers: `VSCODE_PID` would make the
 * server walk its chain looking for an editor that is not there, `WORKSPACE_FOLDER_PATHS` would
 * give it a project folder that is not the run's, and `CLAUDECODE` is the marker of the Claude
 * Code session the harness is normally started from.
 */
export const KILO_DROPPED_PARENT_ENV: readonly string[] = [
  'CLAUDECODE',
  'VSCODE_PID',
  'WORKSPACE_FOLDER_PATHS',
];

export interface KiloWorkspaceOptions {
  /** Absolute path of the built bundle, `dist/handoff-mcp.cjs`. */
  readonly serverBundle: string;
  /** The temporary `HANDOFF_HOME` of this run. */
  readonly home: string;
  /** The temporary project folder Kilo is started in. */
  readonly project: string;
  /** The empty folder `XDG_CONFIG_HOME` points at, so the user's global configuration stays out. */
  readonly configHome: string;
  /** The per-server `timeout` of our entry, in milliseconds, written only when a scenario measures it. */
  readonly timeoutMs?: number;
}

/** One local MCP server as Kilo's configuration spells it: OpenCode's shape. */
export interface KiloMcpEntry {
  readonly type: 'local';
  readonly command: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly timeout?: number;
}

/** Kilo's configuration, as much of it as a run declares. */
export interface KiloConfig {
  readonly mcp: Readonly<Record<string, KiloMcpEntry>>;
}

/** The `environment` of our entry: the five names of the Claude canary, with Kilo Code's id. */
export function kiloServerEnv(options: KiloWorkspaceOptions): Record<string, string> {
  return {
    HANDOFF_AGENT: KILO_AGENT_ID,
    HANDOFF_HOME: options.home,
    HANDOFF_CANARY: '1',
    HANDOFF_PROBE: PROBE_ENV_VALUE,
    HANDOFF_PROBE_TOKEN: PROBE_ENV_VALUE,
  };
}

/**
 * The inline configuration that declares our server: `node <bundle> serve`, the environment,
 * and the per-server timeout when a scenario measures it. Kilo takes the command and its
 * arguments as one array, as OpenCode does.
 */
export function kiloConfig(options: KiloWorkspaceOptions): KiloConfig {
  return {
    mcp: {
      [KILO_MCP_SERVER_NAME]: {
        type: 'local',
        command: [process.execPath, options.serverBundle, 'serve'],
        environment: kiloServerEnv(options),
        ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
      },
    },
  };
}

/**
 * The `kilo run` command line, the prompt last. `--format json` prints one event per line on
 * stdout; `--pure` loads no external plugin; the title keeps the prompt out of the session list
 * for the moment the session exists.
 */
export function kiloArgs(options: { readonly prompt: string; readonly model: string }): string[] {
  return [
    'run',
    '--pure',
    '--format',
    'json',
    '--title',
    KILO_SESSION_TITLE,
    '-m',
    options.model,
    options.prompt,
  ];
}

/** The command line that removes a run's session from the user's history afterwards. */
export function kiloDeleteArgs(sessionId: string): string[] {
  return ['session', 'delete', sessionId];
}

/**
 * The environment of the `kilo` child: the parent's, without the names of
 * `KILO_DROPPED_PARENT_ENV` and without any `KILO_*` variable of the parent, then `PWD`, the
 * run's configuration folder, the inline configuration, the isolation switches and
 * `HANDOFF_HOME`.
 *
 * `PWD` is set to the run's folder for OpenCode's reason (T-074): an OpenCode fork takes its
 * working directory from `PWD` when the variable is set, and with `PWD` set to the run's folder
 * the server's working directory was that folder (T-080).
 */
export function kiloChildEnvironment(
  options: KiloWorkspaceOptions,
  parent: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const dropped = new Set(KILO_DROPPED_PARENT_ENV);
  const child: Record<string, string> = {};
  for (const [name, value] of Object.entries(parent)) {
    if (value === undefined) continue;
    if (dropped.has(name.toUpperCase())) continue;
    if (name.toUpperCase().startsWith('KILO_')) continue;
    child[name] = value;
  }
  child['PWD'] = options.project;
  child['XDG_CONFIG_HOME'] = options.configHome;
  child['KILO_CONFIG_CONTENT'] = JSON.stringify(kiloConfig(options));
  for (const [name, value] of Object.entries(KILO_ISOLATION_ENV)) child[name] = value;
  child['HANDOFF_HOME'] = options.home;
  return child;
}

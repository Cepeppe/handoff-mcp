/**
 * The command line and the environment of one `opencode run` (T-074, TECHNICAL-DESIGN §11.5,
 * ADPT-06 item 4). The OpenCode twin of `../../workspace.ts` and `../codex/workspace.ts`, and
 * pure for the same reason: `test/unit/canary/opencode.test.ts` pins every shape here without
 * a real agent, so a malformed configuration cannot make every OpenCode canary fail for a
 * reason that has nothing to do with OpenCode.
 *
 * OpenCode has neither `--strict-mcp-config` nor `--ignore-user-config`. What keeps a run off
 * the user's own configuration, measured against OpenCode 1.18.29 on 2026-09-11, is five
 * things that are never optional here:
 *
 * 1. **Our server is declared in `OPENCODE_CONFIG_CONTENT`**, OpenCode's inline configuration,
 *    so nothing is written into a file OpenCode reads.
 * 2. **`XDG_CONFIG_HOME` points at an empty folder of the run.** OpenCode's global
 *    configuration is `$XDG_CONFIG_HOME/opencode/`, `~/.config/opencode/` otherwise — on Windows
 *    too. Measured with `opencode debug config`: a server declared in a throw-away
 *    `<folder>/opencode/opencode.json` is listed with the variable pointing at that folder and
 *    gone with it pointing at an empty one. So the user's own servers, plugins, agents and
 *    permissions never load. The login lives in OpenCode's data folder, which the variable does
 *    not move, so the credentials are kept.
 * 3. **`OPENCODE_DISABLE_PROJECT_CONFIG=1`.** OpenCode looks for `opencode.json` in every folder
 *    from the working directory up to the root, and the run's folder is under the user's home.
 * 4. **`OPENCODE_DISABLE_CLAUDE_CODE=1`.** Otherwise OpenCode reads Claude Code's own files —
 *    its instructions and skills — from the user's home.
 * 5. **`--pure`**, no external plugins; **`OPENCODE_DISABLE_SHARE=1`**, a session is never
 *    shared; **`OPENCODE_DISABLE_AUTOUPDATE=1`**, the agent under test does not change under the
 *    test. Every other `OPENCODE_*` variable of the parent is dropped, because each of them can
 *    point OpenCode at more configuration (`OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR`,
 *    `OPENCODE_PERMISSION` among them).
 *
 * `opencode run` has no ephemeral mode, so the runner deletes the run's session once it has
 * read it (`opencode session delete <id>`, measured to work from the run's folder).
 *
 * Unlike Codex, no approval mode is needed: OpenCode 1.18.29 runs an MCP tool without asking,
 * under `opencode run` and by default.
 */
import { PROBE_ENV_VALUE } from '../../workspace.ts';

/** The name our server is declared under. OpenCode names its tools `handoff_<tool>`. */
export const OPENCODE_MCP_SERVER_NAME = 'handoff';

/** The `HANDOFF_AGENT` the installer writes for OpenCode (§5.6), and the table's key. */
export const OPENCODE_AGENT_ID = 'opencode';

/**
 * The model every OpenCode canary runs on unless `HANDOFF_CANARY_OPENCODE_MODEL` says otherwise:
 * a free model of OpenRouter, the provider OpenCode was measured with, that calls tools and
 * reads images. Free means a canary spends nothing; reading images is what the image scenario
 * needs, since OpenCode hands a tool's image to whichever model the user chose (a text-only
 * model answers that it sees none, and the text of the result still arrives — measured).
 */
export const OPENCODE_DEFAULT_MODEL = 'openrouter/thinkingmachines/inkling-small:free';

/** The session title, so that OpenCode does not name a session after its prompt. */
export const OPENCODE_SESSION_TITLE = 'handoff canary';

/** The switches every run sets, whatever the parent had. */
export const OPENCODE_ISOLATION_ENV: Readonly<Record<string, string>> = {
  OPENCODE_DISABLE_PROJECT_CONFIG: '1',
  OPENCODE_DISABLE_CLAUDE_CODE: '1',
  OPENCODE_DISABLE_SHARE: '1',
  OPENCODE_DISABLE_AUTOUPDATE: '1',
};

export interface OpenCodeWorkspaceOptions {
  /** Absolute path of the built bundle, `dist/handoff-mcp.cjs`. */
  readonly serverBundle: string;
  /** The temporary `HANDOFF_HOME` of this run. */
  readonly home: string;
  /** The temporary project folder OpenCode is started in. */
  readonly project: string;
  /** The empty folder `XDG_CONFIG_HOME` points at, so the user's global configuration stays out. */
  readonly configHome: string;
  /** The per-server `timeout` of our entry, in milliseconds, written only when a scenario measures it. */
  readonly timeoutMs?: number;
}

/** One local MCP server as OpenCode's configuration spells it. */
export interface OpenCodeMcpEntry {
  readonly type: 'local';
  readonly command: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly timeout?: number;
}

/** OpenCode's configuration, as much of it as a run declares. */
export interface OpenCodeConfig {
  readonly mcp: Readonly<Record<string, OpenCodeMcpEntry>>;
}

/** The `environment` of our entry: the five names of the Claude canary, with OpenCode's id. */
export function opencodeServerEnv(options: OpenCodeWorkspaceOptions): Record<string, string> {
  return {
    HANDOFF_AGENT: OPENCODE_AGENT_ID,
    HANDOFF_HOME: options.home,
    HANDOFF_CANARY: '1',
    HANDOFF_PROBE: PROBE_ENV_VALUE,
    HANDOFF_PROBE_TOKEN: PROBE_ENV_VALUE,
  };
}

/**
 * The inline configuration that declares our server: `node <bundle> serve`, the environment,
 * and the per-server timeout when a scenario measures it. OpenCode takes the command and its
 * arguments as one array.
 */
export function opencodeConfig(options: OpenCodeWorkspaceOptions): OpenCodeConfig {
  return {
    mcp: {
      [OPENCODE_MCP_SERVER_NAME]: {
        type: 'local',
        command: [process.execPath, options.serverBundle, 'serve'],
        environment: opencodeServerEnv(options),
        ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
      },
    },
  };
}

/**
 * The `opencode run` command line, the prompt last. `--format json` prints one event per line
 * on stdout; `--pure` loads no external plugin; the title keeps the prompt out of the session
 * list for the moment the session exists.
 */
export function opencodeArgs(options: {
  readonly prompt: string;
  readonly model: string;
}): string[] {
  return [
    'run',
    '--pure',
    '--format',
    'json',
    '--title',
    OPENCODE_SESSION_TITLE,
    '-m',
    options.model,
    options.prompt,
  ];
}

/** The command line that removes a run's session from the user's history afterwards. */
export function opencodeDeleteArgs(sessionId: string): string[] {
  return ['session', 'delete', sessionId];
}

/**
 * The environment of the `opencode` child: the parent's, without `CLAUDECODE` and without any
 * `OPENCODE_*` variable of the parent, then the run's configuration folder, the inline
 * configuration, the isolation switches and `HANDOFF_HOME`.
 *
 * `CLAUDECODE` matters more here than for Codex: OpenCode hands its **whole** environment to
 * the servers it starts (measured: the variable reached the server when the harness left it
 * set), which is also how `USERDOMAIN` and `USERNAME` reach it on Windows.
 *
 * `PWD` is set to the run's folder as well. OpenCode takes its working directory from `PWD`
 * when the variable is set, not from its own process — measured: started with its working
 * directory in the run's folder and a `PWD` inherited from the shell that started the harness,
 * it started our server in the checkout, and A-24 failed for a reason that was the harness's.
 */
export function opencodeChildEnvironment(
  options: OpenCodeWorkspaceOptions,
  parent: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const child: Record<string, string> = {};
  for (const [name, value] of Object.entries(parent)) {
    if (value === undefined) continue;
    if (name === 'CLAUDECODE') continue;
    if (name.toUpperCase().startsWith('OPENCODE_')) continue;
    child[name] = value;
  }
  child['PWD'] = options.project;
  child['XDG_CONFIG_HOME'] = options.configHome;
  child['OPENCODE_CONFIG_CONTENT'] = JSON.stringify(opencodeConfig(options));
  for (const [name, value] of Object.entries(OPENCODE_ISOLATION_ENV)) child[name] = value;
  child['HANDOFF_HOME'] = options.home;
  return child;
}

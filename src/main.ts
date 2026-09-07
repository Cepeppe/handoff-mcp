/**
 * CLI entry point (TECHNICAL-DESIGN §5.12).
 *
 * Routes the five subcommands of the CLI table: `serve` (the default), `hook stop`,
 * `validate <spec.json>`, `runbooks search --where … --goal …` and `doctor`. Only
 * `--version` and `--help` do real work at this stage; every subcommand answers with the
 * task that implements it.
 *
 * Output discipline (§5.12): everything human-readable goes to **stderr**, because stdout
 * is reserved for the MCP stdio transport. The one documented exception is `hook stop`,
 * which prints its decision as JSON on stdout (§5.11); it is implemented in T-021.
 *
 * Exit codes: 0 success · 1 the subcommand exists but is not implemented yet · 2 usage
 * error (unknown subcommand, unknown option, missing argument).
 */

/**
 * Replaced by `build/bundle.mjs` with the version from `package.json`. It stays undefined
 * when the module is imported from source (tests, `tsx`), hence the fallback below.
 */
declare const __HANDOFF_MCP_VERSION__: string | undefined;

/**
 * Set to `true` only in the bundle, so that importing this module from a test does not
 * start the CLI. See `build/bundle.mjs`.
 */
declare const __HANDOFF_MCP_CLI_ENTRY__: boolean | undefined;

export const VERSION: string =
  typeof __HANDOFF_MCP_VERSION__ === 'string' ? __HANDOFF_MCP_VERSION__ : '0.0.0-dev';

/** Subcommands of the CLI table, in the order §5.12 lists them. */
export type Command = 'serve' | 'hook-stop' | 'validate' | 'runbooks-search' | 'doctor';

/** The task that turns each placeholder into behaviour. */
const IMPLEMENTED_BY: Record<Command, string> = {
  serve: 'T-017',
  'hook-stop': 'T-021',
  validate: 'T-013',
  'runbooks-search': 'T-016',
  doctor: 'T-021',
};

export type ParsedArgs =
  | { kind: 'command'; command: Command }
  | { kind: 'version' }
  | { kind: 'help' }
  | { kind: 'usage-error'; message: string };

export const HELP_TEXT = `handoff-mcp — hand a unit of work from a coding agent to the human at the machine.

Usage:
  handoff-mcp [serve]                     Serve MCP over stdio (default)
  handoff-mcp hook stop                   Stop / SubagentStop hook decision for the agent
  handoff-mcp validate <spec.json>        Validate a handoff spec offline
  handoff-mcp runbooks search --where <text> --goal <text>
                                          Search the saved runbooks offline
  handoff-mcp doctor                      Report agent id, capabilities, token and socket

Options:
  -h, --help                              Print this help and exit
  -V, --version                           Print the version and exit

Environment:
  HANDOFF_AGENT                           Override the resolved agent id
  HANDOFF_TOOL_TIMEOUT_MS                 Tool timeout in milliseconds (written by the installer)
  HANDOFF_HOME                            Override ~/.handoff (tests only)
  HANDOFF_MCP_LOG                         error (default) | debug

Human-readable output goes to stderr; stdout carries the MCP stdio transport.`;

/**
 * Pure argument parsing, so the routing can be tested without running anything.
 * Options of unimplemented subcommands are accepted but not interpreted yet: the tasks
 * named in `IMPLEMENTED_BY` own their option grammar.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const first = argv[0];

  if (first === undefined) return { kind: 'command', command: 'serve' };
  if (first === '-h' || first === '--help') return { kind: 'help' };
  if (first === '-V' || first === '--version') return { kind: 'version' };

  switch (first) {
    case 'serve':
      return { kind: 'command', command: 'serve' };

    case 'hook': {
      const event = argv[1];
      if (event === 'stop') return { kind: 'command', command: 'hook-stop' };
      if (event === undefined) return { kind: 'usage-error', message: 'hook needs an event: stop' };
      return { kind: 'usage-error', message: `unknown hook event: ${event}` };
    }

    case 'validate': {
      if (argv[1] === undefined) {
        return { kind: 'usage-error', message: 'validate needs a spec file' };
      }
      return { kind: 'command', command: 'validate' };
    }

    case 'runbooks': {
      const action = argv[1];
      if (action === 'search') return { kind: 'command', command: 'runbooks-search' };
      if (action === undefined) {
        return { kind: 'usage-error', message: 'runbooks needs an action: search' };
      }
      return { kind: 'usage-error', message: `unknown runbooks action: ${action}` };
    }

    case 'doctor':
      return { kind: 'command', command: 'doctor' };

    default:
      return { kind: 'usage-error', message: `unknown command: ${first}` };
  }
}

/**
 * Everything the CLI writes, injectable so tests observe it instead of the console.
 * Only stderr is here: stdout belongs to the MCP transport, and the one command that
 * writes to it (`hook stop`, §5.11) gets its own channel in T-021.
 */
export interface CliStreams {
  err: (line: string) => void;
}

const consoleStreams: CliStreams = {
  err: (line) => process.stderr.write(`${line}\n`),
};

/** Routes one invocation and returns the process exit code. */
export function run(argv: readonly string[], streams: CliStreams = consoleStreams): number {
  const parsed = parseArgs(argv);

  switch (parsed.kind) {
    case 'help':
      streams.err(HELP_TEXT);
      return 0;

    case 'version':
      streams.err(VERSION);
      return 0;

    case 'usage-error':
      streams.err(`handoff-mcp: ${parsed.message}`);
      streams.err(HELP_TEXT);
      return 2;

    case 'command':
      streams.err(
        `handoff-mcp: ${parsed.command} is not implemented (${IMPLEMENTED_BY[parsed.command]})`,
      );
      return 1;
  }
}

if (typeof __HANDOFF_MCP_CLI_ENTRY__ !== 'undefined' && __HANDOFF_MCP_CLI_ENTRY__) {
  process.exitCode = run(process.argv.slice(2));
}

/**
 * CLI entry point (TECHNICAL-DESIGN §5.12).
 *
 * Routes the five subcommands of the CLI table: `serve` (the default), `hook stop`,
 * `validate <spec.json>`, `runbooks search --where … --goal …` and `doctor`.
 *
 * Output discipline (§5.12): the **result** of a subcommand goes to stdout — the JSON
 * decision of `hook stop` (§5.11), the report of `doctor`, the JSON error or the summary
 * line of `validate`, the JSON result of `runbooks search` — and everything else, help,
 * usage errors, the warning about a skipped runbook and logging, goes to stderr. stdout is
 * reserved for the MCP stdio transport only while `serve` is serving.
 *
 * Exit codes, the same three for every subcommand: **0** success · **1** the command ran
 * and answered no (an invalid spec, a runbook folder that cannot be read, a `doctor` that
 * found something to repair) · **2** usage error (unknown subcommand, unknown option,
 * missing argument, a file that cannot be read). `hook stop` is the one subcommand with no
 * failing exit at all: §5.11 gives it a decision or silence, and both are 0.
 *
 * `-h` / `--help` prints the general help; after a subcommand it prints that subcommand's
 * own help, so `handoff-mcp doctor --help` explains `doctor` and nothing else.
 * `HANDOFF_MCP_LOG=debug` adds a diagnostic record on stderr for the command that ran, for
 * every environment variable that was ignored, and for the exit code.
 *
 * `serve` is the one subcommand that does not answer and return: it serves until the agent
 * closes stdin, so `run` gives back a promise for it. `hook stop` and `doctor` also answer
 * asynchronously, because both talk to the app before they can say anything.
 */
import { readFileSync } from 'node:fs';

import { capabilityRowForHello, resolveCapabilityRow, toolTimeoutMs } from './adapters';
import { ChannelClient } from './channel';
import { readConfig } from './config';
import { runDoctor } from './doctor';
import { errorJson, handoffError, validateSpec, type HandoffSpec } from './format';
import { runHookStop } from './hook';
import { createLogger, type Logger } from './log';
import { serve } from './mcp';
import { resolveProcessIdentity } from './platform';
import { defaultRunbookRoots, RunbookStore, searchRunbooks } from './runbooks';

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

/** Subcommands that take neither an argument nor an option. */
type BareCommand = 'serve' | 'hook-stop' | 'doctor';

/** The options `runbooks search` reads, with the bounds of the tool input (§4.7.3). */
export interface RunbooksSearchArgs {
  readonly where: string;
  readonly goal: string;
  readonly lang?: string;
}

export type ParsedArgs =
  | { kind: 'command'; command: BareCommand }
  | { kind: 'command'; command: 'validate'; file: string }
  | ({ kind: 'command'; command: 'runbooks-search' } & RunbooksSearchArgs)
  | { kind: 'version' }
  | { kind: 'help'; command?: Command }
  | { kind: 'usage-error'; message: string };

export const HELP_TEXT = `handoff-mcp — hand a unit of work from a coding agent to the human at the machine.

Usage:
  handoff-mcp [serve]                     Serve MCP over stdio (default)
  handoff-mcp hook stop                   Stop / SubagentStop hook decision for the agent
  handoff-mcp validate <spec.json>        Validate a handoff spec offline
  handoff-mcp runbooks search --where <text> --goal <text> [--lang <tag>]
                                          Search the saved runbooks offline
  handoff-mcp doctor                      Report agent id, capabilities, token and socket

Options:
  -h, --help                              Print this help and exit
  -V, --version                           Print the version and exit

Run handoff-mcp <command> --help for one subcommand's own help.

Environment:
  HANDOFF_AGENT                           Override the resolved agent id
  HANDOFF_TOOL_TIMEOUT_MS                 Tool timeout in milliseconds (written by the installer)
  HANDOFF_HOME                            Override ~/.handoff (tests only)
  HANDOFF_MCP_LOG                         error (default) | debug

A subcommand prints its result on stdout: validate prints a summary line, or the same JSON
error the tool returns and exits 1; runbooks search prints {"runbooks": [...]}, the same
result the handoff_runbooks tool returns. Help, usage errors, warnings about unreadable
runbook files and logging go to stderr; while serve is serving, stdout carries the MCP
stdio transport and nothing else.

Exit codes: 0 success, 1 the command answered no, 2 usage error. hook stop always exits 0.`;

/**
 * One block per subcommand, printed by `handoff-mcp <command> --help`. Each one says what
 * the command does, what it takes, what it prints and what its exit codes mean, because
 * the general help has room for none of that.
 */
export const SUBCOMMAND_HELP: Record<Command, string> = {
  serve: `handoff-mcp serve — serve MCP over stdio (the default when no subcommand is given).

Usage:
  handoff-mcp [serve]

Registers handoff_to_user, handoff_verify and handoff_runbooks, and connects to the overlay
application in the background. With no application listening the server still works: an open
answers status text_mode with the spec rendered as text, and the handoff happens in the chat.

stdout carries the MCP stdio transport and nothing else. Serves until the agent closes
stdin, then says goodbye to the application and exits 0.`,

  'hook-stop': `handoff-mcp hook stop — the Stop / SubagentStop hook decision.

Usage:
  handoff-mcp hook stop            (the agent writes the hook JSON on stdin)

Reads the hook payload on stdin, asks the overlay application whether anything is still
waiting for the user, and prints {"decision":"block","reason":"…"} when it is. It never
blocks on uncertainty: a missing application, a refused token, a malformed input or a slow
answer all print nothing. Budgets: 500 ms to connect, 1800 ms in total, 1950 ms hard exit.

Always exits 0, with output only when the application asked for a block.`,

  validate: `handoff-mcp validate — validate a handoff spec offline.

Usage:
  handoff-mcp validate <spec.json>

Runs the same pipeline the handoff_to_user tool runs — the published schema, then the
semantic rules — and answers with the same JSON error an agent would get, so a spec can be
checked without an agent and without the overlay. Errors never quote the spec: they name
paths, fields, limits and expected shapes only.

Exit codes: 0 valid, with a one-line summary; 1 invalid, with the JSON error; 2 the file
cannot be read.`,

  'runbooks-search': `handoff-mcp runbooks search — search the saved runbooks offline.

Usage:
  handoff-mcp runbooks search --where <text> --goal <text> [--lang <tag>]

Options:
  --where <text>    Where the work happens, at most 300 characters
  --goal <text>     What the handoff is for, at most 300 characters
  --lang <tag>      BCP-47 tag selecting the stop-word list; all of them when absent

Applies the matching rule of the handoff_runbooks tool to ~/.handoff/runbooks/ and prints
the same {"runbooks": [...]} result. Files that could not be parsed are named on stderr and
skipped.

Exit codes: 0 with a possibly empty list; 1 when the folder exists but cannot be read.`,

  doctor: `handoff-mcp doctor — report what this server resolved, and what it can reach.

Usage:
  handoff-mcp doctor

Prints the versions, the agent id and the capability row resolved for it, the status and
permissions of the channel token file, the endpoint and whether the overlay application
answers on it, and the runbook folder. The token itself is never printed. Reaching the
application is a real connection: a hello followed by a goodbye.

An application that is not running is reported, not a fault: every call degrades to text
mode. Exit codes: 0 nothing to repair; 1 something needs repairing, named in a problem line.`,
};

/** The bounds `handoff_runbooks` puts on its inputs (§4.7.3), applied to the options too. */
const WHERE_GOAL_MAX_LENGTH = 300;

/** The BCP-47 shape the spec schema and the tool input both accept. */
const LANG_PATTERN = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/u;

/**
 * `--where <text>` and `--where=<text>` are the same option; the second form is what a
 * shell user reaches for when the text starts with a dash.
 */
function optionName(argument: string): { name: string; inline: string | undefined } {
  const equals = argument.indexOf('=');
  if (equals === -1) return { name: argument, inline: undefined };
  return { name: argument.slice(0, equals), inline: argument.slice(equals + 1) };
}

/** The two spellings of "explain this and stop". */
function isHelpFlag(argument: string | undefined): boolean {
  return argument === '-h' || argument === '--help';
}

/**
 * A subcommand that takes nothing: its own help, or an error naming the surplus argument.
 * Refusing the surplus is the point — `handoff-mcp doctor --verbose` silently ignoring the
 * option would be a worse answer than saying that there is no such option.
 */
function bare(rest: readonly string[], command: BareCommand, spelling: string): ParsedArgs {
  const extra = rest[0];
  if (extra === undefined) return { kind: 'command', command };
  if (isHelpFlag(extra)) return { kind: 'help', command };
  return { kind: 'usage-error', message: `${spelling} takes no argument: ${extra}` };
}

/** `runbooks search --where … --goal … [--lang …]`. */
function parseRunbooksSearch(argv: readonly string[]): ParsedArgs {
  const values: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? '';
    const { name, inline } = optionName(argument);
    // Only in an option position: a `--goal -h` has already consumed the flag as its value.
    if (isHelpFlag(name)) return { kind: 'help', command: 'runbooks-search' };
    if (name !== '--where' && name !== '--goal' && name !== '--lang') {
      return { kind: 'usage-error', message: `unknown option: ${name}` };
    }
    const value = inline ?? argv[++index];
    if (value === undefined) return { kind: 'usage-error', message: `${name} needs a value` };
    values[name] = value;
  }

  for (const name of ['--where', '--goal'] as const) {
    const value = values[name];
    if (value === undefined) {
      return { kind: 'usage-error', message: `runbooks search needs ${name}` };
    }
    if (value.trim() === '') return { kind: 'usage-error', message: `${name} is empty` };
    if (value.length > WHERE_GOAL_MAX_LENGTH) {
      return {
        kind: 'usage-error',
        message: `${name} is longer than ${String(WHERE_GOAL_MAX_LENGTH)} characters`,
      };
    }
  }

  const lang = values['--lang'];
  if (lang !== undefined && !LANG_PATTERN.test(lang)) {
    return { kind: 'usage-error', message: '--lang is not a BCP-47 language tag' };
  }

  return {
    kind: 'command',
    command: 'runbooks-search',
    where: values['--where'] ?? '',
    goal: values['--goal'] ?? '',
    ...(lang === undefined ? {} : { lang }),
  };
}

/**
 * Pure argument parsing, so the routing can be tested without running anything. Every
 * subcommand accepts `-h` / `--help` in place of its own arguments and refuses anything
 * else it does not know, so an option that was silently ignored can never look like an
 * option that worked.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const first = argv[0];

  if (first === undefined) return { kind: 'command', command: 'serve' };
  if (isHelpFlag(first)) return { kind: 'help' };
  if (first === '-V' || first === '--version') return { kind: 'version' };

  switch (first) {
    case 'serve':
      return bare(argv.slice(1), 'serve', 'serve');

    case 'hook': {
      const event = argv[1];
      if (isHelpFlag(event)) return { kind: 'help', command: 'hook-stop' };
      if (event === 'stop') return bare(argv.slice(2), 'hook-stop', 'hook stop');
      if (event === undefined) return { kind: 'usage-error', message: 'hook needs an event: stop' };
      return { kind: 'usage-error', message: `unknown hook event: ${event}` };
    }

    case 'validate': {
      const file = argv[1];
      if (isHelpFlag(file)) return { kind: 'help', command: 'validate' };
      if (file === undefined) {
        return { kind: 'usage-error', message: 'validate needs a spec file' };
      }
      const extra = argv[2];
      if (extra !== undefined) {
        return { kind: 'usage-error', message: `validate takes one spec file: ${extra}` };
      }
      return { kind: 'command', command: 'validate', file };
    }

    case 'runbooks': {
      const action = argv[1];
      if (isHelpFlag(action)) return { kind: 'help', command: 'runbooks-search' };
      if (action === 'search') return parseRunbooksSearch(argv.slice(2));
      if (action === undefined) {
        return { kind: 'usage-error', message: 'runbooks needs an action: search' };
      }
      return { kind: 'usage-error', message: `unknown runbooks action: ${action}` };
    }

    case 'doctor':
      return bare(argv.slice(1), 'doctor', 'doctor');

    default:
      return { kind: 'usage-error', message: `unknown command: ${first}` };
  }
}

/**
 * Everything the CLI reads and writes, injectable so tests observe it instead of the
 * console and the file system. `out` carries the result of a subcommand, `err` everything
 * else; `readFile` throws the way `readFileSync` does when the file cannot be read.
 */
export interface CliStreams {
  out: (line: string) => void;
  err: (line: string) => void;
  readFile: (path: string) => string;
}

const consoleStreams: CliStreams = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  readFile: (path) => readFileSync(path, 'utf8'),
};

/** `2 steps`, `1 value`: counts only, never what the spec says. */
function count(n: number, noun: string): string {
  return `${String(n)} ${noun}${n === 1 ? '' : 's'}`;
}

/** The one line a valid spec prints. It reports sizes, never content (R-19). */
function summarise(file: string, spec: HandoffSpec): string {
  const secrets = spec.secrets === undefined ? 0 : Object.keys(spec.secrets).length;
  return [
    `${file}: valid handoff spec (spec_version ${String(spec.spec_version)}`,
    count(spec.steps.length, 'step'),
    count(Object.keys(spec.values).length, 'value'),
    count(secrets, 'secret'),
    `verify ${spec.verify === undefined ? 'absent' : 'present'})`,
  ].join(', ');
}

/** The position a JSON parser reported, without the fragment of the file around it. */
function parsePosition(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  return /\bat position \d+(?: \(line \d+ column \d+\))?/.exec(message)?.[0] ?? '';
}

/**
 * `handoff-mcp validate <spec.json>`: the same pipeline, the same JSON error, offline
 * (§5.4). Exit 0 with a one-line summary, 1 with the error the tool would have returned,
 * 2 when the file itself cannot be read.
 */
function runValidate(file: string, streams: CliStreams): number {
  let text: string;
  try {
    text = streams.readFile(file);
  } catch (cause) {
    streams.err(`handoff-mcp: cannot read ${file}: ${cause instanceof Error ? cause.message : ''}`);
    return 2;
  }

  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (cause) {
    const position = parsePosition(cause);
    streams.out(
      errorJson(
        handoffError('SPEC_INVALID', [
          {
            path: '',
            problem: 'The file is not valid JSON.',
            fix: `Fix the JSON syntax${position === '' ? '' : ` ${position}`} and validate again.`,
          },
        ]),
      ),
    );
    return 1;
  }

  const result = validateSpec(document);
  if (!result.ok) {
    streams.out(errorJson(result.error));
    return 1;
  }
  streams.out(summarise(file, result.spec));
  return 0;
}

/**
 * `handoff-mcp runbooks search --where … --goal … [--lang …]`: the matching rule of §4.5.3
 * over `~/.handoff/runbooks/`, offline, for users of the server alone (§5.12).
 *
 * It prints exactly what the `handoff_runbooks` tool returns, `{ "runbooks": [ … ] }`, so
 * what a person sees here is what an agent will see. A folder that is not there is an empty
 * list and exit 0; a folder that cannot be read is `RUNBOOKS_UNREADABLE` and exit 1, which
 * is the answer the tool gives (§5.10). Files that had to be skipped are named on stderr.
 */
function runRunbooksSearch(query: RunbooksSearchArgs, streams: CliStreams): number {
  const store = new RunbookStore(defaultRunbookRoots(), { warn: streams.err });
  const read = store.readForTool();
  if (!read.ok) {
    streams.out(errorJson(read.error));
    return 1;
  }
  streams.out(JSON.stringify({ runbooks: searchRunbooks(read.runbooks, query) }, null, 2));
  return 0;
}

/**
 * `handoff-mcp serve`: the three MCP tools over stdio (§5.3).
 *
 * The order is the one §5.3 writes down. The process identity is resolved first, because
 * `hello` carries it and it costs one `ps` on macOS and nothing anywhere else. The transport
 * then starts serving, and the channel starts connecting from `onInitialized` — after the
 * MCP handshake, because `hello` also carries the `client` the handshake names and the
 * capability row §5.6 resolves from it. That is still session start and not the first tool
 * call (SRV-20): `initialize` is the first thing an MCP client does, and until the socket
 * answers, every call degrades to text mode on its own (FM-02, §5.9).
 *
 * Connecting is not awaited. The app may be absent for the whole session and the retry never
 * gives up, so a `serve` that waited for a socket would be a `serve` that never served.
 *
 * When `serve` returns, the agent has closed stdin. `close()` is the `session.bye` of §5.3,
 * best effort, and the process then exits 0.
 *
 * The runbook store gets the CLI's own stderr as its warning sink, so a file it has to skip
 * is named for the person reading the session rather than swallowed (§5.10).
 */
async function runServe(streams: CliStreams): Promise<number> {
  const config = readConfig();
  const logger = createLogger(config.logLevel, streams.err);
  const identity = await resolveProcessIdentity();
  const row = resolveCapabilityRow({ agent: config.agent });

  const channel = new ChannelClient({
    identity: {
      pid: identity.pid,
      ppid: identity.ppid,
      ancestors: identity.ancestors,
      cwd: process.cwd(),
      project_dir: config.projectDir,
    },
    agentId: row.agent_id,
    client: { name: row.agent_id, version: VERSION },
    capabilityRow: capabilityRowForHello(row, toolTimeoutMs(row, config)),
    serverVersion: VERSION,
    logger,
  });

  try {
    return await serve({
      config,
      version: VERSION,
      channel,
      runbooks: new RunbookStore(defaultRunbookRoots(), { warn: streams.err }),
      logger,
      onInitialized: (resolved, client) => {
        channel.describeSession({
          agentId: resolved.agent_id,
          client,
          capabilityRow: capabilityRowForHello(resolved, toolTimeoutMs(resolved, config)),
        });
        channel.start();
      },
    });
  } finally {
    await channel.close();
  }
}

/**
 * The logger every subcommand shares: the level from `HANDOFF_MCP_LOG`, the sink the CLI's
 * own stderr. It is built per invocation rather than once at module load, so a test that
 * changes the environment between two `run` calls gets the level it asked for.
 */
function cliLogger(streams: CliStreams): Logger {
  return createLogger(readConfig().logLevel, streams.err);
}

/** Runs the command itself. `run` wraps this with the diagnostics of `HANDOFF_MCP_LOG`. */
function dispatch(
  parsed: Extract<ParsedArgs, { kind: 'command' }>,
  streams: CliStreams,
  logger: Logger,
): number | Promise<number> {
  switch (parsed.command) {
    case 'serve':
      return runServe(streams);
    case 'validate':
      return runValidate(parsed.file, streams);
    case 'runbooks-search':
      return runRunbooksSearch(parsed, streams);
    case 'hook-stop':
      return runHookStop({ out: streams.out, logger });
    case 'doctor':
      return runDoctor({ out: streams.out, warn: streams.err, logger, version: VERSION });
  }
}

/** Routes one invocation and returns the process exit code, or a promise for it. */
export function run(
  argv: readonly string[],
  streams: CliStreams = consoleStreams,
): number | Promise<number> {
  const parsed = parseArgs(argv);

  switch (parsed.kind) {
    case 'help':
      streams.err(parsed.command === undefined ? HELP_TEXT : SUBCOMMAND_HELP[parsed.command]);
      return 0;

    case 'version':
      streams.err(VERSION);
      return 0;

    case 'usage-error':
      streams.err(`handoff-mcp: ${parsed.message}`);
      streams.err(HELP_TEXT);
      return 2;

    case 'command': {
      const logger = cliLogger(streams);
      logger.debug('cli_command', { kind: parsed.command, level: logger.level });
      for (const name of readConfig().ignored) logger.debug('cli_env_ignored', { env_var: name });

      const outcome = dispatch(parsed, streams, logger);
      if (typeof outcome === 'number') {
        logger.debug('cli_exit', { code: outcome });
        return outcome;
      }
      return outcome.then((code) => {
        logger.debug('cli_exit', { code });
        return code;
      });
    }
  }
}

if (typeof __HANDOFF_MCP_CLI_ENTRY__ !== 'undefined' && __HANDOFF_MCP_CLI_ENTRY__) {
  const outcome = run(process.argv.slice(2));
  if (typeof outcome === 'number') process.exitCode = outcome;
  else {
    void outcome.then((code) => {
      process.exitCode = code;
    });
  }
}

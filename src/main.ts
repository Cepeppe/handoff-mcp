/**
 * CLI entry point (TECHNICAL-DESIGN §5.12).
 *
 * Routes the five subcommands of the CLI table: `serve` (the default), `hook stop`,
 * `validate <spec.json>`, `runbooks search --where … --goal …` and `doctor`. All but
 * `hook stop` and `doctor` do real work; those two answer with the task that implements
 * them.
 *
 * Output discipline (§5.12): the **result** of a subcommand goes to stdout — the JSON
 * decision of `hook stop` (§5.11, T-021), the JSON error or the summary line of `validate`,
 * the JSON result of `runbooks search` — and everything else, help, usage errors, the
 * warning about a skipped runbook and logging, goes to stderr. stdout is reserved for the
 * MCP stdio transport only while `serve` is serving.
 *
 * Exit codes: 0 success · 1 the command ran and answered no (an invalid spec, a runbook
 * folder that cannot be read), or the subcommand exists but is not implemented yet ·
 * 2 usage error (unknown subcommand, unknown option, missing argument, a file that cannot
 * be read).
 *
 * `serve` is the one subcommand that does not answer and return: it serves until the agent
 * closes stdin, so `run` gives back a promise for it and a number for everything else.
 */
import { readFileSync } from 'node:fs';

import { capabilityRowForHello, resolveCapabilityRow, toolTimeoutMs } from './adapters';
import { ChannelClient } from './channel';
import { readConfig } from './config';
import { errorJson, handoffError, validateSpec, type HandoffSpec } from './format';
import { createLogger } from './log';
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

/** Subcommands that still answer with the task that will implement them. */
type Placeholder = Exclude<Command, 'serve' | 'validate' | 'runbooks-search'>;

/** The task that turns each placeholder into behaviour. */
const IMPLEMENTED_BY: Record<Placeholder, string> = {
  'hook-stop': 'T-021',
  doctor: 'T-021',
};

/** The options `runbooks search` reads, with the bounds of the tool input (§4.7.3). */
export interface RunbooksSearchArgs {
  readonly where: string;
  readonly goal: string;
  readonly lang?: string;
}

export type ParsedArgs =
  | { kind: 'command'; command: 'serve' }
  | { kind: 'command'; command: 'validate'; file: string }
  | ({ kind: 'command'; command: 'runbooks-search' } & RunbooksSearchArgs)
  | { kind: 'command'; command: Placeholder }
  | { kind: 'version' }
  | { kind: 'help' }
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

Environment:
  HANDOFF_AGENT                           Override the resolved agent id
  HANDOFF_TOOL_TIMEOUT_MS                 Tool timeout in milliseconds (written by the installer)
  HANDOFF_HOME                            Override ~/.handoff (tests only)
  HANDOFF_MCP_LOG                         error (default) | debug

A subcommand prints its result on stdout: validate prints a summary line, or the same JSON
error the tool returns and exits 1; runbooks search prints {"runbooks": [...]}, the same
result the handoff_runbooks tool returns. Help, usage errors, warnings about unreadable
runbook files and logging go to stderr; while serve is serving, stdout carries the MCP
stdio transport and nothing else.`;

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

/** `runbooks search --where … --goal … [--lang …]`. */
function parseRunbooksSearch(argv: readonly string[]): ParsedArgs {
  const values: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? '';
    const { name, inline } = optionName(argument);
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
      const file = argv[1];
      if (file === undefined) {
        return { kind: 'usage-error', message: 'validate needs a spec file' };
      }
      return { kind: 'command', command: 'validate', file };
    }

    case 'runbooks': {
      const action = argv[1];
      if (action === 'search') return parseRunbooksSearch(argv.slice(2));
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

/** Routes one invocation and returns the process exit code, or a promise for it. */
export function run(
  argv: readonly string[],
  streams: CliStreams = consoleStreams,
): number | Promise<number> {
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

    case 'command': {
      if (parsed.command === 'serve') return runServe(streams);
      if (parsed.command === 'validate') return runValidate(parsed.file, streams);
      if (parsed.command === 'runbooks-search') return runRunbooksSearch(parsed, streams);
      streams.err(
        `handoff-mcp: ${parsed.command} is not implemented (${IMPLEMENTED_BY[parsed.command]})`,
      );
      return 1;
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

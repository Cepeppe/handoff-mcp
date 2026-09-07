/**
 * CLI entry point (TECHNICAL-DESIGN §5.12).
 *
 * Routes the five subcommands of the CLI table: `serve` (the default), `hook stop`,
 * `validate <spec.json>`, `runbooks search --where … --goal …` and `doctor`. `--version`,
 * `--help` and `validate` do real work; every other subcommand answers with the task that
 * implements it.
 *
 * Output discipline (§5.12): the **result** of a subcommand goes to stdout — the JSON
 * decision of `hook stop` (§5.11, T-021), the JSON error or the summary line of `validate`
 * — and everything else, help, usage errors and logging, goes to stderr. stdout is
 * reserved for the MCP stdio transport only while `serve` is serving.
 *
 * Exit codes: 0 success · 1 the command ran and answered no (an invalid spec), or the
 * subcommand exists but is not implemented yet · 2 usage error (unknown subcommand,
 * unknown option, missing argument, a file that cannot be read).
 */
import { readFileSync } from 'node:fs';

import { errorJson, handoffError, validateSpec, type HandoffSpec } from './format';

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
type Placeholder = Exclude<Command, 'validate'>;

/** The task that turns each placeholder into behaviour. */
const IMPLEMENTED_BY: Record<Placeholder, string> = {
  serve: 'T-017',
  'hook-stop': 'T-021',
  'runbooks-search': 'T-016',
  doctor: 'T-021',
};

export type ParsedArgs =
  | { kind: 'command'; command: 'validate'; file: string }
  | { kind: 'command'; command: Placeholder }
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

A subcommand prints its result on stdout: validate prints a summary line, or the same JSON
error the tool returns and exits 1. Help, usage errors and logging go to stderr; while serve
is serving, stdout carries the MCP stdio transport and nothing else.`;

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

    case 'command': {
      if (parsed.command === 'validate') return runValidate(parsed.file, streams);
      streams.err(
        `handoff-mcp: ${parsed.command} is not implemented (${IMPLEMENTED_BY[parsed.command]})`,
      );
      return 1;
    }
  }
}

if (typeof __HANDOFF_MCP_CLI_ENTRY__ !== 'undefined' && __HANDOFF_MCP_CLI_ENTRY__) {
  process.exitCode = run(process.argv.slice(2));
}

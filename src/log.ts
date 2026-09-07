/**
 * Logging (TECHNICAL-DESIGN §5.12, R-19).
 *
 * Three rules, and the whole module exists to make them impossible to break by accident:
 *
 * 1. **stderr only, never a file.** stdout belongs to the MCP stdio transport while
 *    `serve` is serving, and to the result of a subcommand otherwise (`src/main.ts`).
 * 2. **Two levels**, `error` (the default) and `debug`, selected by `HANDOFF_MCP_LOG`.
 * 3. **Ids, codes, sizes and timings only.** No spec value, no step text, no goal, no
 *    answer, no token ever becomes a log field. This is enforced twice: `LogFields`
 *    accepts only the field names of the allow-list below, so a `spec` or `values` field
 *    is a type error, and `createLogger` drops at run time any field that slipped past
 *    the type (a value cast to `LogFields`, a plain object parsed from JSON). Dropping
 *    silently is deliberate: a redactor that fails open is not a redactor.
 *
 * The line is `handoff-mcp <level> <event> k=v k=v`, one record per line, so a session
 * transcript can be grepped by event name without a parser.
 */

/** The two levels of §5.12. `debug` is for diagnostics and includes everything. */
export type LogLevel = 'error' | 'debug';

export const LOG_LEVELS: readonly LogLevel[] = ['error', 'debug'];

/** The default when `HANDOFF_MCP_LOG` is unset or holds something else. */
export const DEFAULT_LOG_LEVEL: LogLevel = 'error';

const VERBOSITY: Record<LogLevel, number> = { error: 0, debug: 1 };

/**
 * Field names allowed by their suffix: an identifier, an instant, a duration, a size or a
 * count. The shape of the name is what makes the value safe — `steps_count` is a size,
 * `steps` would have been the steps themselves.
 */
const FIELD_SUFFIXES = ['_id', '_ms', '_at', '_bytes', '_count', '_ref', '_version'] as const;

/**
 * Field names allowed as they are: codes, states and the small closed vocabularies the
 * server already reports to the app. Every one of them is a value the design lets the
 * outcome or the log carry (§4.3, §7.11); none of them can hold user or agent text.
 */
const FIELD_NAMES = [
  'agent_id',
  'attempt',
  'bytes',
  'code',
  'count',
  'env_var',
  'event',
  'kind',
  'level',
  'method',
  'ok',
  'pid',
  'ppid',
  'problems',
  'reason',
  'role',
  'round',
  'state',
  'status',
  'support',
] as const;

/** What a field may hold. Objects and arrays are refused: they hide their content. */
export type LogValue = string | number | boolean;

/** Every field name the type accepts: the vocabulary, plus the suffix patterns. */
type LogFieldKey = (typeof FIELD_NAMES)[number] | `${string}${(typeof FIELD_SUFFIXES)[number]}`;

/**
 * The structured part of a record. The key type is the allow-list, so
 * `log.debug('x', { spec })` does not compile, and `test/unit/log.test.ts` pins that with
 * `@ts-expect-error` so that widening this type fails `pnpm typecheck`. A field written
 * explicitly as `undefined` is accepted and skipped, so a caller can pass an optional
 * value without building the object twice.
 */
export type LogFields = { [K in LogFieldKey]?: LogValue | undefined };

/**
 * The run-time half of the guard, exported so the test can assert both directions against
 * the same lists the logger uses. A name qualifies by being in the vocabulary or by
 * carrying one of the suffixes with at least one character before it.
 */
export function isAllowedLogField(name: string): boolean {
  if ((FIELD_NAMES as readonly string[]).includes(name)) return true;
  return FIELD_SUFFIXES.some((suffix) => name.length > suffix.length && name.endsWith(suffix));
}

/** `k=v`, quoted only when the value would not survive a whitespace split. */
function formatValue(value: LogValue): string {
  if (typeof value !== 'string') return String(value);
  return /^[\w.:+/@-]+$/u.test(value) ? value : JSON.stringify(value);
}

/**
 * One record. Fields keep the insertion order of the object and disallowed ones vanish;
 * the event name is emitted even when every field was dropped, so the record still shows.
 */
function formatRecord(level: LogLevel, event: string, fields: LogFields | undefined): string {
  const parts = [`handoff-mcp ${level} ${event}`];
  const entries: [string, unknown][] = Object.entries(fields ?? {});
  for (const [name, value] of entries) {
    if (!isAllowedLogField(name)) continue;
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      continue;
    }
    parts.push(`${name}=${formatValue(value)}`);
  }
  return parts.join(' ');
}

export interface Logger {
  /** The level this logger was built with, so a caller can skip expensive fields. */
  readonly level: LogLevel;
  /** Always emitted. */
  error: (event: string, fields?: LogFields) => void;
  /** Emitted only when the level is `debug`. */
  debug: (event: string, fields?: LogFields) => void;
}

/** Where a record goes. Injected so a test reads the lines instead of the process stderr. */
export type LogSink = (line: string) => void;

const stderrSink: LogSink = (line) => process.stderr.write(`${line}\n`);

/**
 * Builds a logger. `sink` defaults to stderr and is the only place this module writes:
 * nothing here opens a file, and nothing returns a formatted record to a caller who could
 * put it in an outcome.
 */
export function createLogger(
  level: LogLevel = DEFAULT_LOG_LEVEL,
  sink: LogSink = stderrSink,
): Logger {
  const emit = (recordLevel: LogLevel, event: string, fields: LogFields | undefined): void => {
    if (VERBOSITY[recordLevel] > VERBOSITY[level]) return;
    sink(formatRecord(recordLevel, event, fields));
  };
  return {
    level,
    error: (event, fields) => {
      emit('error', event, fields);
    },
    debug: (event, fields) => {
      emit('debug', event, fields);
    },
  };
}

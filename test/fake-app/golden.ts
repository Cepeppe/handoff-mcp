/**
 * The golden sequences, and what "matches modulo ids and timestamps" means (§11.3).
 *
 * `fixtures/channel/*.jsonl` is the one description of the wire both doubles obey, so this
 * module never copies a payload out of it: a scenario points at a file, the actions are
 * derived from it (`scenario.ts`), and what the peer sends back is compared against the
 * same file. The comparison has to be looser than string equality in three ways, and no
 * looser:
 *
 * - **Identifiers are chosen at run time.** `hf_`, `call_`, `ses_` and `rb_` values are
 *   replaced by `<hf#1>`, `<call#1>` and so on, numbered by the order in which they first
 *   appear **in that sequence**. Two different ids therefore stay different, and an id
 *   reused where the golden reuses one stays equal — which is the property the flows are
 *   about (an event citing the call that opened it, DD-13 giving the handoff the id of the
 *   request it answers).
 * - **Instants are chosen at run time** and become `<at>`.
 * - **JSON-RPC ids** are per connection and per peer, so a top-level `id` becomes
 *   `<id#n>` by the same first-appearance rule.
 *
 * Everything else is compared exactly, including field order — the canonical form sorts
 * keys, so two objects that differ only in key order are equal and two that differ in one
 * character are not. A scenario may additionally `ignore` paths that belong to the peer
 * rather than to the protocol (`params.identity` is this process's pid and cwd); that list
 * is written in the scenario file, so nothing is silently excused.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { GOLDEN_DIR } from './validate';

/** `→` is server (or hook) to app, `←` is app to server, exactly as §6.3 prints them. */
export type Direction = '→' | '←';

export type JsonObject = Record<string, unknown>;

export interface GoldenLine {
  readonly dir: Direction;
  readonly msg: JsonObject;
  /** 1-based, so a failure names the line of the file a reader is looking at. */
  readonly n: number;
}

export function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One golden file, as the `{dir, msg}` lines it holds. */
export function readGolden(file: string): GoldenLine[] {
  return readFileSync(join(GOLDEN_DIR, file), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line, index) => {
      const parsed: unknown = JSON.parse(line);
      if (!isObject(parsed) || !isObject(parsed['msg'])) {
        throw new Error(`${file}:${String(index + 1)} is not a {dir, msg} line`);
      }
      const dir = parsed['dir'];
      if (dir !== '→' && dir !== '←') {
        throw new Error(`${file}:${String(index + 1)} has an unknown direction`);
      }
      return { dir, msg: parsed['msg'], n: index + 1 };
    });
}

/** The id shapes of §4.1, each with the placeholder it collapses to. */
const ID_SHAPES: readonly { readonly re: RegExp; readonly label: string }[] = [
  { re: /^hf_[0-9a-hjkmnp-tv-z]{10}$/u, label: 'hf' },
  { re: /^call_[0-9a-hjkmnp-tv-z]{8}$/u, label: 'call' },
  { re: /^ses_[0-9a-hjkmnp-tv-z]{8}$/u, label: 'ses' },
  { re: /^rb_[0-9a-hjkmnp-tv-z]{10}$/u, label: 'rb' },
];

/** RFC 3339 as the schemas require it: a date, a time, and either `Z` or an offset. */
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;

/**
 * The numbering shared by one sequence. One canon per sequence, never one per message:
 * the whole point is that the same id keeps the same number from the `handoff.open` that
 * assigned it to the `handoff.verify` that closes it.
 */
export class Canon {
  private readonly seen = new Map<string, string>();
  private readonly counts = new Map<string, number>();

  /** The placeholder for `value`, or `undefined` when it is not an identifier. */
  id(value: string): string | undefined {
    const shape = ID_SHAPES.find((candidate) => candidate.re.test(value));
    if (shape === undefined) return undefined;
    return this.number(shape.label, value);
  }

  /** The placeholder for a JSON-RPC id, which may be an integer or a string. */
  rpcId(value: string | number): string {
    return this.number('id', `${typeof value}:${String(value)}`);
  }

  private number(label: string, key: string): string {
    const full = `${label}/${key}`;
    const known = this.seen.get(full);
    if (known !== undefined) return known;
    const next = (this.counts.get(label) ?? 0) + 1;
    this.counts.set(label, next);
    const placeholder = `<${label}#${String(next)}>`;
    this.seen.set(full, placeholder);
    return placeholder;
  }
}

/** How a path is written in a scenario's `ignore` list: `params.identity`, `result.notes[]`. */
function childPath(path: string, key: string): string {
  return path === '' ? key : `${path}.${key}`;
}

function replace(value: unknown, canon: Canon, path: string, ignore: readonly string[]): unknown {
  if (ignore.includes(path)) return '<ignored>';
  if (Array.isArray(value)) {
    return value.map((item) => replace(item, canon, `${path}[]`, ignore));
  }
  if (isObject(value)) {
    const out: JsonObject = {};
    for (const [key, child] of Object.entries(value)) {
      const rpcId = key === 'id' && path === '';
      if (rpcId && (typeof child === 'number' || typeof child === 'string')) {
        out[key] = canon.rpcId(child);
      } else {
        out[key] = replace(child, canon, childPath(path, key), ignore);
      }
    }
    return out;
  }
  if (typeof value === 'string') {
    if (INSTANT.test(value)) return '<at>';
    return canon.id(value) ?? value;
  }
  return value;
}

/** Keys sorted at every depth, so two messages differing only in field order are equal. */
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!isObject(value)) return value;
  const out: JsonObject = {};
  for (const key of Object.keys(value).sort()) out[key] = stable(value[key]);
  return out;
}

/**
 * One message as the text the comparison is made on. `canon` carries the numbering across
 * the sequence, so it must be the same object for every message of one side.
 */
export function canonical(message: unknown, canon: Canon, ignore: readonly string[] = []): string {
  return JSON.stringify(stable(replace(message, canon, '', ignore)), null, 2);
}

/** A whole sequence, one canonical message per entry, numbered from a fresh canon. */
export function canonicalSequence(
  messages: readonly unknown[],
  ignore: readonly string[] = [],
): string[] {
  const canon = new Canon();
  return messages.map((message) => canonical(message, canon, ignore));
}

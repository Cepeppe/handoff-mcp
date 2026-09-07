/**
 * The runbook reader (TECHNICAL-DESIGN §5.10, §12.3, RUN-03a, RUN-10, FM-19).
 *
 * Lists `*.json` under each root, parses, validates, and hands back what survived. The
 * rules that matter are all about *not* failing:
 *
 * - **One bad file never breaks a tool call.** A file that is not JSON, that a newer app
 *   wrote, or that the schema refuses is skipped with one warning on stderr naming it.
 * - **A missing folder is an empty result**, not an error: a user who has never completed
 *   a handoff has no `~/.handoff/runbooks/`.
 * - **An unreadable folder is answered twice**, which is why there are two read functions:
 *   `handoff_runbooks` was asked to look and must say `RUNBOOKS_UNREADABLE`, while the
 *   safety net of RUN-07 skips it silently, because a permissions problem on a folder of
 *   recipes must never stop a handoff from opening.
 *
 * The store takes a **list** of roots and is configured with exactly one, `~/.handoff/
 * runbooks/` (§12.3): adding a per-project folder later is then configuration, not a
 * refactor.
 *
 * Files are cached by path and mtime. The cache holds skips as well as runbooks, so a bad
 * file warns once and stays quiet until it is edited; the entry disappears with the file.
 *
 * The warning goes to stderr directly rather than through `src/log.ts`. A structured record
 * cannot carry a path — the logger's allow-list refuses any field that is not an id, an
 * instant, a size or a code, and widening it enough to hold a file name would be widening
 * it enough to hold a spec value (R-19). What §5.10 asks for here is a sentence for the
 * person at the terminal, and that is what this writes.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { homeDir, type EnvRecord } from '../config';
import { catalogueError, type HandoffError } from '../format/errors';

import { SUPPORTED_RUNBOOK_VERSION, validateRunbookSchema } from './schema';
import type { Runbook, StoredRunbook } from './types';

/** The folder under `~/.handoff/` that holds the runbook files (RUN-03a). */
export const RUNBOOKS_FOLDER_NAME = 'runbooks';

/** Only files ending in this are considered; anything else in the folder is ignored. */
const RUNBOOK_FILE_SUFFIX = '.json';

/** Where a warning about a skipped file goes. Injected so a test reads it. */
export type WarnSink = (line: string) => void;

const stderrWarn: WarnSink = (line) => process.stderr.write(`${line}\n`);

export interface RunbookStoreOptions {
  readonly warn?: WarnSink;
}

/** What the tool gets: the runbooks, or the error that says the folder cannot be read. */
export type RunbookRead =
  | { readonly ok: true; readonly runbooks: readonly StoredRunbook[] }
  | { readonly ok: false; readonly error: HandoffError };

/** The roots the server is configured with: exactly one, `~/.handoff/runbooks/` (§12.3). */
export function defaultRunbookRoots(env?: EnvRecord): readonly string[] {
  return [join(homeDir(env), RUNBOOKS_FOLDER_NAME)];
}

/** The `code` of a Node system error, when it has one. */
function errorCode(cause: unknown): string | undefined {
  if (typeof cause !== 'object' || cause === null) return undefined;
  const code = (cause as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/** The message of a thrown value, without anything it might have quoted from the file. */
function reasonOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** What a cached entry holds: the runbook, or the fact that this mtime was already refused. */
interface CacheEntry {
  readonly mtimeMs: number;
  readonly runbook: Runbook | null;
}

export class RunbookStore {
  private readonly roots: readonly string[];
  private readonly warn: WarnSink;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(roots: readonly string[], options: RunbookStoreOptions = {}) {
    this.roots = [...roots];
    this.warn = options.warn ?? stderrWarn;
  }

  /**
   * The read behind `handoff_runbooks` (§5.10): an unreadable root is `RUNBOOKS_UNREADABLE`.
   *
   * The error is raised even when other roots produced runbooks: the agent asked whether a
   * runbook exists, and "here are the ones I could see" would be a wrong answer to that.
   */
  readForTool(): RunbookRead {
    const { runbooks, unreadable } = this.read();
    if (unreadable) return { ok: false, error: catalogueError('RUNBOOKS_UNREADABLE') };
    return { ok: true, runbooks };
  }

  /**
   * The read behind the safety net of RUN-07: whatever could be read, and no error.
   *
   * A folder that cannot be listed is treated exactly like a folder that is not there, so
   * a runbook problem can never stop a handoff from opening.
   */
  readForSafetyNet(): readonly StoredRunbook[] {
    return this.read().runbooks;
  }

  /** Walks every root once, using and refreshing the cache. */
  private read(): { runbooks: StoredRunbook[]; unreadable: boolean } {
    const runbooks: StoredRunbook[] = [];
    const live = new Set<string>();
    let unreadable = false;

    for (const root of this.roots) {
      let names: string[];
      try {
        names = readdirSync(root);
      } catch (cause) {
        // A folder that is not there is an empty result; anything else is a folder we were
        // meant to be able to read and could not.
        if (errorCode(cause) !== 'ENOENT') unreadable = true;
        continue;
      }
      for (const name of names.filter((entry) => entry.endsWith(RUNBOOK_FILE_SUFFIX)).sort()) {
        const path = join(root, name);
        live.add(path);
        const runbook = this.load(path);
        if (runbook !== null) runbooks.push({ path, runbook });
      }
    }

    for (const path of this.cache.keys()) {
      if (!live.has(path)) this.cache.delete(path);
    }
    return { runbooks, unreadable };
  }

  /** One file, from the cache when its mtime has not moved. `null` means skipped. */
  private load(path: string): Runbook | null {
    let mtimeMs: number;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch (cause) {
      this.skip(path, reasonOf(cause));
      return null;
    }

    const cached = this.cache.get(path);
    if (cached !== undefined && cached.mtimeMs === mtimeMs) return cached.runbook;

    const runbook = this.parse(path);
    this.cache.set(path, { mtimeMs, runbook });
    return runbook;
  }

  /** Parses and validates one file, warning once about whatever is wrong with it. */
  private parse(path: string): Runbook | null {
    let document: unknown;
    try {
      document = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    } catch (cause) {
      this.skip(path, reasonOf(cause));
      return null;
    }

    const version =
      typeof document === 'object' && document !== null
        ? (document as { runbook_version?: unknown }).runbook_version
        : undefined;
    if (typeof version === 'number' && version > SUPPORTED_RUNBOOK_VERSION) {
      this.skip(
        path,
        `runbook_version ${String(version)} is newer than this server understands ` +
          `(${String(SUPPORTED_RUNBOOK_VERSION)}); update handoff-mcp`,
      );
      return null;
    }

    if (!validateRunbookSchema(document)) {
      const first = validateRunbookSchema.errors?.[0];
      const at = first === undefined || first.instancePath === '' ? '/' : first.instancePath;
      this.skip(path, `does not match the runbook schema: ${at} ${first?.message ?? ''}`.trim());
      return null;
    }
    // The schema has just checked every field the type promises.
    return document as Runbook;
  }

  /** The one warning a skipped file produces, naming it (§5.10). */
  private skip(path: string, reason: string): void {
    this.warn(`handoff-mcp: skipping runbook ${path}: ${reason}`);
  }
}

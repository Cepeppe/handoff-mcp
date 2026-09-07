/**
 * The runbook reader (TECHNICAL-DESIGN §5.10, FM-19).
 *
 * Real files in a real temporary folder, because the behaviours worth asserting are all
 * about the file system: an mtime that moved, a folder that is not there, and a folder that
 * cannot be listed. A root is made unlistable here by pointing it at a plain file, which
 * fails with ENOTDIR on Windows, macOS and Linux alike and needs no permission games that
 * only work on one of them.
 *
 * The mtimes are set by hand. Two writes can land in the same millisecond on Windows, so a
 * test that trusted the clock would pass or fail depending on how fast the machine is.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  defaultRunbookRoots,
  RUNBOOKS_FOLDER_NAME,
  RunbookStore,
  SUPPORTED_RUNBOOK_VERSION,
} from '../../../src/runbooks';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const VALID = join(ROOT, 'fixtures', 'runbooks', 'valid');

/** The id of `minimal-confirmed-by-user.json`, the file most cases start from. */
const MINIMAL_ID = 'rb_9q4v7hn2xz';

let home: string;
let folder: string;
let warnings: string[];

function fixture(name: string): string {
  return readFileSync(join(VALID, name), 'utf8');
}

function store(...roots: string[]): RunbookStore {
  return new RunbookStore(roots.length === 0 ? [folder] : roots, {
    warn: (line) => warnings.push(line),
  });
}

/** A runbook file built from a published fixture, with any field replaced. */
function write(
  name: string,
  overrides: Record<string, unknown> = {},
  from = 'minimal-confirmed-by-user.json',
): string {
  const base = JSON.parse(fixture(from)) as Record<string, unknown>;
  const path = join(folder, name);
  writeFileSync(path, JSON.stringify({ ...base, ...overrides }, null, 2), 'utf8');
  return path;
}

function setMtime(path: string, iso: string): void {
  const when = new Date(iso);
  utimesSync(path, when, when);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'handoff-runbooks-'));
  folder = join(home, RUNBOOKS_FOLDER_NAME);
  mkdirSync(folder);
  warnings = [];
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('defaultRunbookRoots', () => {
  it('is exactly one root, the runbooks folder of the shared home (§12.3)', () => {
    expect(defaultRunbookRoots({ HANDOFF_HOME: home })).toEqual([folder]);
  });
});

describe('RunbookStore', () => {
  it('reads the valid files of the folder and ignores everything else', () => {
    write('a.json');
    write('b.json', { id: 'rb_9q4v7hn2xy' });
    writeFileSync(join(folder, 'notes.txt'), 'not a runbook', 'utf8');

    const read = store().readForTool();
    expect(read.ok).toBe(true);
    expect(read.ok && read.runbooks.map((one) => one.path)).toEqual([
      join(folder, 'a.json'),
      join(folder, 'b.json'),
    ]);
    expect(warnings).toEqual([]);
  });

  it('skips a file that is not JSON, with one warning naming it', () => {
    const path = join(folder, 'broken.json');
    writeFileSync(path, '{ "runbook_version": 1, ', 'utf8');
    write('good.json');

    const read = store().readForTool();
    expect(read.ok && read.runbooks).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('skipping runbook');
    expect(warnings[0]).toContain(path);
  });

  it('skips a file the schema refuses, naming the field but not its content', () => {
    const path = write('bad-trust.json', { trust: 'trusted' });

    expect(store().readForTool()).toEqual({ ok: true, runbooks: [] });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(path);
    expect(warnings[0]).toContain('/trust');
    expect(warnings[0]).not.toContain('trusted');
  });

  it('skips a file written by a newer app, and says which side is behind', () => {
    write('future.json', { runbook_version: SUPPORTED_RUNBOOK_VERSION + 1 });

    expect(store().readForTool()).toEqual({ ok: true, runbooks: [] });
    expect(warnings[0]).toContain('newer than this server understands');
  });

  it('warns once about a bad file and stays quiet until it changes', () => {
    writeFileSync(join(folder, 'broken.json'), 'not json', 'utf8');
    const reader = store();

    reader.readForTool();
    reader.readForTool();
    expect(warnings).toHaveLength(1);
  });

  it('serves an unchanged file from the cache and re-reads it when the mtime moves at all', () => {
    const path = write('a.json');
    setMtime(path, '2026-09-07T10:00:00.000Z');
    const reader = store();
    expect(reader.readForTool()).toMatchObject({ ok: true, runbooks: [{ path }] });

    // Same mtime, different bytes: the cache answers and the garbage is never parsed.
    writeFileSync(path, 'garbage that would not parse', 'utf8');
    setMtime(path, '2026-09-07T10:00:00.000Z');
    const cached = reader.readForTool();
    expect(cached.ok && cached.runbooks).toHaveLength(1);
    expect(warnings).toEqual([]);

    // An mtime that went backwards invalidates too: the key is equality, not "newer than".
    setMtime(path, '2026-09-06T10:00:00.000Z');
    const reread = reader.readForTool();
    expect(reread.ok && reread.runbooks).toHaveLength(0);
    expect(warnings).toHaveLength(1);
  });

  it('picks up an edited file and forgets a deleted one', () => {
    const path = write('a.json');
    setMtime(path, '2026-09-07T10:00:00.000Z');
    const reader = store();
    const first = reader.readForTool();
    expect(first.ok && first.runbooks[0]?.runbook.id).toBe(MINIMAL_ID);

    write('a.json', { id: 'rb_9q4v7hn2xy' });
    setMtime(path, '2026-09-07T11:00:00.000Z');
    const second = reader.readForTool();
    expect(second.ok && second.runbooks[0]?.runbook.id).toBe('rb_9q4v7hn2xy');

    rmSync(path);
    expect(reader.readForTool()).toEqual({ ok: true, runbooks: [] });
  });

  it('is an empty result when the folder does not exist', () => {
    rmSync(folder, { recursive: true });
    expect(store().readForTool()).toEqual({ ok: true, runbooks: [] });
    expect(store().readForSafetyNet()).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('answers RUNBOOKS_UNREADABLE for the tool when a root cannot be listed', () => {
    const notAFolder = join(home, 'runbooks-file');
    writeFileSync(notAFolder, 'this is a file, not a directory', 'utf8');

    const read = store(notAFolder).readForTool();
    expect(read.ok).toBe(false);
    expect(!read.ok && read.error.code).toBe('RUNBOOKS_UNREADABLE');
    expect(!read.ok && read.error.problems[0]?.fix).toBe(
      'Check permissions on ~/.handoff/runbooks.',
    );
  });

  it('skips an unlistable root silently for the safety net', () => {
    const notAFolder = join(home, 'runbooks-file');
    writeFileSync(notAFolder, 'this is a file, not a directory', 'utf8');
    write('a.json');

    expect(store(notAFolder, folder).readForSafetyNet()).toHaveLength(1);
    expect(warnings).toEqual([]);
  });

  it('takes a list of roots and reads all of them (§12.3)', () => {
    const second = join(home, 'more');
    mkdirSync(second);
    write('a.json');
    writeFileSync(join(second, 'b.json'), fixture('stripe-webhook.json'), 'utf8');

    const read = store(folder, second).readForTool();
    expect(read.ok && read.runbooks.map((one) => one.runbook.id)).toEqual([
      MINIMAL_ID,
      'rb_2b9x4d7fkq',
    ]);
  });
});

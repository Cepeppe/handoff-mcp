/**
 * `doctor` against a real endpoint (TECHNICAL-DESIGN §5.12, §5.8, §5.3, §6.2).
 *
 * The whole point of the subcommand is that it reports what a session would actually find,
 * so nothing here is a double except the app itself: a temporary `HANDOFF_HOME` with its own
 * token file, a real named pipe on Windows and a real Unix socket elsewhere, and
 * `test/fake-app` on the other end validating every line against the channel schema.
 *
 * The snapshot is the report of a healthy installation. What it hides is only what belongs
 * to the machine and not to the answer — the endpoint name, the POSIX mode, the session the
 * app happened to assign — so a change of layout or of wording fails here and nowhere else.
 */
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import type { EnvRecord } from '../../src/config';
import { collectDoctorReport, runDoctor, type DoctorReport } from '../../src/doctor';
import { createLogger } from '../../src/log';
import { FIXTURE_TOKEN, FakeApp, type FakeAppOptions } from '../fake-app';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const VERSION = '0.1.0-test';

const running: FakeApp[] = [];
const temporary: string[] = [];

afterEach(async () => {
  for (const app of running.splice(0)) await app.stop();
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A folder this test owns, so it survives the app that listened in it. */
function makeHome(): string {
  const base = process.platform === 'win32' ? tmpdir() : '/tmp';
  const home = mkdtempSync(join(base, 'handoff-doctor-'));
  temporary.push(home);
  return home;
}

function writeToken(home: string, token = FIXTURE_TOKEN): void {
  writeFileSync(join(home, 'channel.token'), `${token}\n`, { encoding: 'utf8', mode: 0o600 });
}

/**
 * A controlled environment rather than `process.env`: the report prints the log level and
 * the variables it had to ignore, and a shell that happened to export one of them would
 * change the snapshot on one machine and not on another.
 */
function envFor(home: string, extra: EnvRecord = {}): EnvRecord {
  return {
    HANDOFF_HOME: home,
    HANDOFF_AGENT: 'claude-code',
    // The Windows pipe name is derived from these two by both peers (§5.8, DD-26).
    USERDOMAIN: process.env['USERDOMAIN'],
    USERNAME: process.env['USERNAME'],
    ...extra,
  };
}

async function startFake(home: string, options: FakeAppOptions = {}): Promise<FakeApp> {
  const app = await FakeApp.start({ ...options, home });
  running.push(app);
  return app;
}

interface Run {
  readonly code: number;
  readonly out: string[];
  readonly warnings: string[];
}

async function doctor(env: EnvRecord): Promise<Run> {
  const out: string[] = [];
  const warnings: string[] = [];
  const code = await runDoctor({
    out: (line) => out.push(line),
    warn: (line) => warnings.push(line),
    logger: createLogger('error', (line) => warnings.push(line)),
    env,
    version: VERSION,
    node: '<node>',
    platform: '<platform>',
  });
  return { code, out, warnings };
}

function collect(env: EnvRecord): Promise<DoctorReport> {
  return collectDoctorReport({
    env,
    version: VERSION,
    logger: createLogger('error', () => {
      /* the report is what this test reads */
    }),
  });
}

/** Replaces what belongs to this machine, and nothing that belongs to the answer. */
const VOLATILE = new Set(['endpoint', 'mode', 'session_ref']);

function stable(lines: readonly string[], home: string): string {
  return lines
    .map((line) => {
      const match = /^ {2}(\S+)\s{2,}/u.exec(line);
      const label = match?.[1];
      if (label !== undefined && VOLATILE.has(label)) return `  ${label.padEnd(27)}<${label}>`;
      return line.replaceAll(home, '<home>').replaceAll('\\', '/');
    })
    .join('\n');
}

describe('a healthy installation', () => {
  it('reports every section, and exits 0', async () => {
    const home = makeHome();
    const app = await startFake(home);
    const run = await doctor(envFor(home));

    expect(run.code).toBe(0);
    expect(app.violations).toEqual([]);
    expect(stable(run.out, home)).toMatchSnapshot();
  });

  it('says goodbye rather than leaving the session open (§5.3)', async () => {
    const home = makeHome();
    const app = await startFake(home);
    await doctor(envFor(home));

    await app.waitFor(() => app.expectations().includes('session.bye'), 5_000, 'the goodbye');
    expect(app.expectations()).toEqual(['hello', 'session.bye']);
    expect(app.sessions).toHaveLength(1);
  });

  it('never prints the token, and reads the real file to say the status', async () => {
    const home = makeHome();
    await startFake(home);
    const run = await doctor(envFor(home));

    expect(run.out.join('\n')).not.toContain(FIXTURE_TOKEN);
    expect(run.out.join('\n')).toContain('status                     ok');
  });
});

describe('the app is not there', () => {
  it('is reported and is not a fault: text mode is a supported way to work', async () => {
    const home = makeHome();
    writeToken(home);
    const run = await doctor(envFor(home));

    expect(run.code).toBe(0);
    expect(run.out.join('\n')).toContain('not reachable');
    expect(run.out.at(-1)).toBe('doctor: nothing to repair');
  });
});

describe('the token file', () => {
  it.each<['missing' | 'malformed', string | undefined]>([
    ['missing', undefined],
    ['malformed', 'not-a-token'],
  ])('is %s: the probe is skipped and the exit code is 1', async (status, contents) => {
    const home = makeHome();
    if (contents !== undefined) writeToken(home, contents);
    const run = await doctor(envFor(home));

    expect(run.code).toBe(1);
    expect(run.out.join('\n')).toContain(`status                     ${status}`);
    expect(run.out.join('\n')).toContain(`not probed (the token file is ${status})`);
    expect(run.out.at(-1)).toContain('the channel token file is');
  });
});

describe('the app refuses the connection', () => {
  it.each<['auth_failed' | 'protocol_unsupported', string]>([
    ['auth_failed', 'CHANNEL_AUTH_FAILED'],
    ['protocol_unsupported', 'PROTOCOL_MISMATCH'],
  ])('%s is reported as %s and exits 1 (FM-10, FM-11)', async (refuse, failure) => {
    const home = makeHome();
    await startFake(home, { refuse });
    const run = await doctor(envFor(home));

    expect(run.code).toBe(1);
    expect(run.out.join('\n')).toContain(`refused (${failure})`);
    expect(run.out.at(-1)).toMatch(
      failure === 'CHANNEL_AUTH_FAILED' ? /refused the token/u : /update the app/u,
    );
  });
});

describe('the runbook folder (§5.10, §12.3)', () => {
  it('counts what it could read', async () => {
    const home = makeHome();
    writeToken(home);
    const folder = join(home, 'runbooks');
    mkdirSync(folder);
    cpSync(join(REPO, 'fixtures/runbooks/valid'), folder, { recursive: true });

    const report = await collect(envFor(home));
    expect(report.runbooks).toMatchObject({ status: 'ok', count: 3 });
    expect(report.problems).toEqual([]);
  });

  it('is missing before the first handoff was ever saved, which is not a fault', async () => {
    const home = makeHome();
    writeToken(home);

    const report = await collect(envFor(home));
    expect(report.runbooks).toMatchObject({ status: 'missing', count: 0 });
    expect(report.problems).toEqual([]);
  });

  it('is a problem when it exists and cannot be read', async () => {
    const home = makeHome();
    writeToken(home);
    writeFileSync(join(home, 'runbooks'), 'a file where the folder should be', 'utf8');

    const run = await doctor(envFor(home));
    expect(run.code).toBe(1);
    expect(run.out.join('\n')).toContain('status                     unreadable');
    expect(run.out.at(-1)).toContain('runbook folder');
  });
});

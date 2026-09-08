/**
 * The hook against a real endpoint (TECHNICAL-DESIGN §9 F-10, §5.11, §6.2, SRV-10..13).
 *
 * The five rows of the F-10 decision table, driven end to end: the real `hook stop` code of
 * `src/hook/stop.ts` over a real named pipe on Windows and a real Unix socket elsewhere, to
 * `test/fake-app`, which validates every line against `protocol/channel/channel.v1.schema.json`
 * and answers from a scenario. Two of the five rows — a session the app could not bind and a
 * session with nothing queued — are the same thing on the wire, because the decision is the
 * app's (§7.5) and the hook is a transport; they are written separately anyway, so that a
 * later change that made them differ would have a test to fail.
 *
 * `f10-hook-block.jsonl` is replayed as well, with the hook as the peer, so that what this
 * subcommand actually writes is compared to the golden the app's own double replays.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { EnvRecord } from '../../src/config';
import { runHookStop, type HookStopOptions } from '../../src/hook';
import { createLogger } from '../../src/log';
import {
  FIXTURE_TOKEN,
  FakeApp,
  loadScenario,
  parseScenario,
  readGolden,
  type Scenario,
} from '../fake-app';

/** The payload A-05 documents, as the agent writes it on the hook's stdin. */
const HOOK_JSON = {
  session_id: '0b1e7c94-6f3a-4d21-9f0c-2ab5e8d17c43',
  transcript_path: '/Users/g/.claude/projects/shop/0b1e7c94.jsonl',
  cwd: '/Users/g/dev/shop',
  hook_event_name: 'Stop',
  stop_hook_active: false,
};

const running: FakeApp[] = [];
const temporary: string[] = [];

afterEach(async () => {
  for (const app of running.splice(0)) await app.stop();
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function startFake(scenario?: Scenario): Promise<FakeApp> {
  const app = await FakeApp.start(scenario === undefined ? {} : { scenario });
  running.push(app);
  return app;
}

/** A hand-written scenario, checked by the same parser the eleven files go through. */
function scripted(name: string, why: string, actions: readonly unknown[]): Scenario {
  return parseScenario({ scenario: name, why, actions }, name);
}

/**
 * A `HANDOFF_HOME` with a usable token and nothing listening on the endpoint it names: the
 * "app unreachable" row, which needs the token to be fine so that the hook actually gets as
 * far as the socket.
 */
function homeWithToken(): EnvRecord {
  const home = mkdtempSync(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'handoff-hook-'));
  temporary.push(home);
  writeFileSync(join(home, 'channel.token'), `${FIXTURE_TOKEN}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  return { ...process.env, HANDOFF_HOME: home };
}

interface Run {
  readonly code: number;
  readonly out: string[];
  readonly logs: string[];
  readonly elapsedMs: number;
}

/** Runs the subcommand with the real budgets, against whatever `env` points at. */
async function hook(
  env: EnvRecord,
  json: unknown = HOOK_JSON,
  overrides: Partial<HookStopOptions> = {},
): Promise<Run> {
  const out: string[] = [];
  const logs: string[] = [];
  const started = Date.now();
  const code = await runHookStop({
    out: (line) => out.push(line),
    logger: createLogger('debug', (line) => logs.push(line)),
    env,
    readInput: () => Promise.resolve(JSON.stringify(json)),
    hardExit: () => {
      throw new Error('the hard exit fired: something outlived the budget');
    },
    ...overrides,
  });
  return { code, out, logs, elapsedMs: Date.now() - started };
}

describe('F-10, row by row', () => {
  it('row 1 — stop_hook_active: neutral, and the app never hears from it (SRV-12)', async () => {
    const app = await startFake();
    const run = await hook(app.env, { ...HOOK_JSON, stop_hook_active: true });

    expect(run.code).toBe(0);
    expect(run.out).toEqual([]);
    expect(app.recorded).toEqual([]);
  });

  it('row 2 — the app could not bind the session: neutral', async () => {
    const app = await startFake(
      scripted('hook-unbound', 'The app cannot bind the session, so it asks for no block.', [
        { answerHookStop: { block: false } },
      ]),
    );
    const run = await hook(app.env);

    expect(run.out).toEqual([]);
    expect(app.expectations()).toEqual(['hello', 'hook.stop']);
    expect(app.violations).toEqual([]);
  });

  it('row 3 — the session is bound and nothing is queued: neutral', async () => {
    // No scenario at all: the fake's documented default for `hook.stop` is `{block: false}`.
    const app = await startFake();
    const run = await hook(app.env);

    expect(run.out).toEqual([]);
    expect(app.gaps).toEqual([]);
  });

  it('row 4 — something is queued: the block JSON, on stdout, exit 0', async () => {
    const reason =
      'Handoff hf_7k3m9p2q4r (Register the Stripe webhook) is awaiting your verification report: perform its verify and call handoff_verify.';
    const app = await startFake(
      scripted('hook-block', 'One item is waiting, so the app asks the agent to keep going.', [
        { answerHookStop: { block: true, reason } },
      ]),
    );
    const run = await hook(app.env);

    expect(run.code).toBe(0);
    expect(run.out).toEqual([JSON.stringify({ decision: 'block', reason })]);
    expect(app.violations).toEqual([]);
  });

  it('row 5a — no app at all: neutral, well inside the budget', async () => {
    const run = await hook(homeWithToken());

    expect(run.code).toBe(0);
    expect(run.out).toEqual([]);
    expect(run.elapsedMs).toBeLessThan(600);
  });

  it('row 5b — an app that takes three seconds to answer hello: neutral within two', async () => {
    const app = await startFake(
      scripted('hook-slow-app', 'The app accepts the socket and answers hello far too late.', [
        { delayHello: { ms: 3_000 } },
      ]),
    );
    const run = await hook(app.env);

    expect(run.code).toBe(0);
    expect(run.out).toEqual([]);
    expect(run.elapsedMs).toBeLessThan(2_000);
    expect(run.logs.join('\n')).toContain('hook_neutral');
  });
});

describe('what the connection looks like from the app (§6.2)', () => {
  it('registers no session: role hook, session_ref null, one answer and the door', async () => {
    const app = await startFake(
      scripted('hook-one-answer', 'One hook.stop is answered and the connection is closed.', [
        { answerHookStop: { block: false } },
      ]),
    );
    await hook(app.env);

    expect(app.sessions).toEqual([]);
    const hello = app.recorded[0]?.message;
    expect(hello).toMatchObject({ method: 'hello', params: { role: 'hook' } });
    expect(app.sent[0]).toMatchObject({ result: { session_ref: null } });
    expect(app.recorded.every((entry) => entry.connection === 0)).toBe(true);
  });

  it('forwards the two SubagentStop fields and never the transcript path (ADPT-08)', async () => {
    const app = await startFake();
    await hook(app.env, {
      ...HOOK_JSON,
      hook_event_name: 'SubagentStop',
      agent_id: 'agent_7',
      agent_type: 'general-purpose',
    });

    const hello = app.recorded[0]?.message as { params: Record<string, unknown> } | undefined;
    expect(hello?.params['hook']).toEqual({
      session_id: HOOK_JSON.session_id,
      hook_event_name: 'SubagentStop',
      stop_hook_active: false,
      agent_id: 'agent_7',
      agent_type: 'general-purpose',
    });
    expect(JSON.stringify(app.recorded)).not.toContain('transcript');
  });

  it('is refused, and stays neutral, when the token does not match (FM-10)', async () => {
    const app = await startFake();
    const other = 'a'.repeat(64);
    const run = await hook({ ...app.env, HANDOFF_HOME: app.home }, HOOK_JSON, {
      token: () => ({ ok: true, token: other }),
    });

    expect(run.out).toEqual([]);
    expect(run.logs.join('\n')).toContain('hook_hello_refused');
  });
});

describe('the golden sequence of F-10, with the real hook as the peer', () => {
  it('sends what f10-hook-block.jsonl says, and is answered as the fixture answers', async () => {
    const scenario = loadScenario('f10-hook-block');
    // The pid, the ppid and the working directory belong to whichever process is driving;
    // everything else in the sequence is the protocol and is compared exactly.
    const app = await startFake({ ...scenario, ignore: ['params.identity'] });

    const golden = readGolden('f10-hook-block.jsonl')[0]?.msg as
      { params: { hook: Record<string, unknown> } } | undefined;
    const input = golden?.params.hook ?? {};
    const run = await hook(app.env, { ...input, cwd: '/Users/g/dev/shop' });

    expect(app.violations).toEqual([]);
    expect(app.gaps).toEqual([]);
    expect(app.remaining()).toEqual([]);
    expect(app.expectations()).toEqual(scenario.expect);

    const sent = app.goldenComparison();
    expect(sent.actual).toEqual(sent.expected);
    const answered = app.goldenAnswers();
    expect(answered.actual).toEqual(answered.expected);

    // The golden's answer is a block, so the hook must have printed it.
    expect(run.out).toHaveLength(1);
    expect(JSON.parse(run.out[0] ?? '')).toMatchObject({ decision: 'block' });
  });
});

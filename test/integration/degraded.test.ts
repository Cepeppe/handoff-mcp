/**
 * The degraded half of the pipeline, end to end (T-020; §5.2 step 4, §5.9, §5.3, §4.7.5).
 *
 * `flows.test.ts` drives the eight flows that have a golden. Everything here is what happens
 * when the flow does not go that way: no app at all (F-09), a runbook that makes the open
 * unnecessary (F-03), a connection that dies mid-call (FM-13), a token the app refuses
 * (FM-10), a protocol version it does not speak (FM-11), an agent that cancels (FM-07), and
 * each of the five application errors of §6.3 arriving as the catalogue error of §4.7.5 the
 * agent is supposed to read.
 *
 * These have no golden because no golden could have one: `fixtures/channel/` holds the eleven
 * sequences a working system produces, and a refusal or a dropped socket is not a sequence,
 * it is the absence of one. So the scenarios here are hand-written with `parseScenario`,
 * which is the second form `test/fake-app/README.md` documents.
 */
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { ERROR_TEXTS } from '../../src/mcp';
import { parseScenario, type Scenario } from '../fake-app';

import {
  callTool,
  errorOf,
  outcomeOf,
  registered,
  session,
  STRIPE_SPEC,
  type Session,
} from './session';

const REPO = fileURLToPath(new URL('../../', import.meta.url));

/** The id the hand-written scenarios assign, so a test can resume it by name. */
const HANDOFF_ID = 'hf_7k3m9p2q4r';

const live: Session[] = [];
const temporary: string[] = [];

afterEach(async () => {
  for (const active of live.splice(0)) await active.close();
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function open(options: Parameters<typeof session>[0]): Promise<Session> {
  const active = await session(options);
  live.push(active);
  return active;
}

/** A complete outcome as the app sends it: every field present, as §4.3 requires (TOOL-13). */
function appOutcome(status: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    outcome_version: 1,
    handoff_id: HANDOFF_ID,
    status,
    final: false,
    instruction: 'the server replaces this with the published one',
    round: 1,
    current_step: null,
    user_text: null,
    screenshot: null,
    context: null,
    skipped_steps: [],
    notes: [],
    secret_treated: [],
    verify: null,
    deferral_count: 0,
    resumed_from: null,
    app_reachable: true,
    already_delivered: false,
    runbooks: [],
    spec_text: null,
    ...extra,
  };
}

/** A hand-written scenario, checked by the same parser the eleven files go through. */
function scripted(name: string, why: string, actions: readonly unknown[]): Scenario {
  return parseScenario({ scenario: name, why, actions }, name);
}

/** A runbook folder holding the published fixtures the safety net should match. */
function runbookFolder(...names: readonly string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'handoff-mcp-t020-'));
  temporary.push(dir);
  for (const name of names) cpSync(join(REPO, 'fixtures/runbooks/valid', name), join(dir, name));
  return dir;
}

describe('F-09 text mode: no app at all (SRV-14..16, FM-01)', () => {
  it('renders the spec as text and says the app is not reachable', async () => {
    const active = await open({ withoutApp: true });
    const outcome = outcomeOf(await callTool(active, 'handoff_to_user', { spec: STRIPE_SPEC }));

    expect(outcome.status).toBe('text_mode');
    expect(outcome.handoff_id).toBeNull();
    expect(outcome.app_reachable).toBe(false);
    expect(outcome.final).toBe(false);
    expect(outcome.spec_text).toContain('# Handoff (text mode):');
    // No handoff exists anywhere, so the instruction has nothing to substitute into.
    expect(outcome.instruction).not.toContain('<id>');
  });

  it('refuses continue, resume and verify, because their state is in the app', async () => {
    const active = await open({ withoutApp: true });

    const continued = errorOf(
      await callTool(active, 'handoff_to_user', {
        handoff_id: HANDOFF_ID,
        reply: 'the answer',
      }),
    );
    expect(continued.code).toBe('APP_DISCONNECTED');

    const resumed = errorOf(await callTool(active, 'handoff_to_user', { resume: HANDOFF_ID }));
    expect(resumed.code).toBe('APP_DISCONNECTED');

    const verified = errorOf(
      await callTool(active, 'handoff_verify', {
        handoff_id: HANDOFF_ID,
        verify: { ok: true, detail: 'it works' },
      }),
    );
    expect(verified.code).toBe('APP_DISCONNECTED');
  });
});

describe('F-03 runbook safety net (RUN-06, RUN-07, RUN-07a)', () => {
  it('answers with the match and opens nothing, even though the app is right there', async () => {
    const active = await open({
      scenario: scripted('f03-never-used', 'The safety net answers before the channel is used.', [
        { onOpen: { handoff_id: HANDOFF_ID } },
      ]),
      runbookRoot: runbookFolder('stripe-webhook.json'),
    });
    await registered(active);
    active.app?.mark();

    const outcome = outcomeOf(await callTool(active, 'handoff_to_user', { spec: STRIPE_SPEC }));
    expect(outcome.status).toBe('runbook_match');
    expect(outcome.handoff_id).toBeNull();
    expect(outcome.app_reachable).toBe(true);
    expect(outcome.runbooks.length).toBeGreaterThan(0);
    // The point of the flow: nothing crossed the channel and the scenario never ran.
    expect(active.app?.expectations()).toEqual([]);
    expect(active.app?.remaining()).toHaveLength(1);
  });

  it('opens for real when the agent sets ignore_runbook', async () => {
    const active = await open({
      scenario: scripted('f03-bypassed', 'The same spec with the safety net switched off.', [
        { onOpen: { handoff_id: HANDOFF_ID } },
        { emitEvent: { outcome: appOutcome('confirmed_by_user', { final: true }) } },
      ]),
      runbookRoot: runbookFolder('stripe-webhook.json'),
    });
    await registered(active);
    active.app?.mark();

    const outcome = outcomeOf(
      await callTool(active, 'handoff_to_user', { spec: STRIPE_SPEC, ignore_runbook: true }),
    );
    expect(outcome.status).toBe('confirmed_by_user');
    expect(active.app?.expectations()).toEqual(['handoff.open']);
  });
});

/**
 * `already_delivered` is the server's word, not the app's (§5.7, TOOL-07). The app answers
 * a resume with the state and the outcome it kept; whether the agent has *already seen* that
 * outcome is a fact about the agent's history, which only the side facing the agent knows.
 * So the app is scripted here to leave the flag false on a handoff that is final, and the
 * flag must still come back true.
 */
describe('a resume of a concluded handoff (TOOL-07)', () => {
  it('sets already_delivered on a final snapshot even when the app left it false', async () => {
    const active = await open({
      scenario: scripted('resume-final', 'A resume that lands on a handoff already finished.', [
        {
          onResume: {
            state: 'verified',
            outcome: appOutcome('verified', { final: true, already_delivered: false }),
          },
        },
      ]),
    });
    await registered(active);

    const outcome = outcomeOf(await callTool(active, 'handoff_to_user', { resume: HANDOFF_ID }));
    expect(outcome.status).toBe('verified');
    expect(outcome.final).toBe(true);
    expect(outcome.already_delivered).toBe(true);
  });

  it('leaves it false for a queued event, which the agent has never seen (DD-12)', async () => {
    const active = await open({
      scenario: scripted('resume-queued', 'A resume that collects an event queued meanwhile.', [
        { onResume: { state: 'active', outcome: appOutcome('question') } },
      ]),
      // Short enough that a call left behind would announce itself before the test ends.
      heartbeatAfterMs: 60,
    });
    await registered(active);

    const outcome = outcomeOf(await callTool(active, 'handoff_to_user', { resume: HANDOFF_ID }));
    expect(outcome.status).toBe('question');
    expect(outcome.already_delivered).toBe(false);

    // A resume answered by its snapshot never attached: the call must not stay in the table
    // with a live heartbeat, or the app would be told a call detached that never waited.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(active.app?.expectations()).not.toContain('handoff.detach_call');
  });
});

describe('reconnection and re-attach (§5.3, FM-13)', () => {
  it('keeps the waiting call, resumes it with the same call id and delivers the outcome', async () => {
    const active = await open({
      scenario: scripted(
        'reattach',
        'The socket dies under a blocking call; the server reconnects and resumes it.',
        [
          { onOpen: { handoff_id: HANDOFF_ID } },
          { dropConnection: {}, afterMs: 20 },
          {
            onResume: {
              state: 'awaiting_verification',
              outcome: appOutcome('awaiting_verification'),
            },
          },
        ],
      ),
    });
    await registered(active);
    active.app?.mark();

    const outcome = outcomeOf(await callTool(active, 'handoff_to_user', { spec: STRIPE_SPEC }));
    expect(outcome.status).toBe('awaiting_verification');
    expect(outcome.handoff_id).toBe(HANDOFF_ID);
    // Re-attached and not re-opened: no second `handoff.open`, and the resume carries the
    // call id the open minted, because it is the same call still waiting (§5.7).
    const methods = active.app?.expectations() ?? [];
    expect(methods.filter((method) => method === 'handoff.open')).toHaveLength(1);
    expect(methods).toContain('handoff.resume');
    expect(callIds(active, 'handoff.open')).toEqual(callIds(active, 'handoff.resume'));
    // A re-attach is not a delivery the agent already had (TOOL-07).
    expect(outcome.already_delivered).toBe(false);
  });
});

describe('a channel that refuses (FM-10, FM-11)', () => {
  it('degrades to text mode and adds the repair for a token the app rejects', async () => {
    const active = await open({ peerToken: 'a'.repeat(64) });
    const app = active.app;
    await app?.waitFor(
      () => active.channel.failure !== undefined,
      5_000,
      'the app to refuse the token',
    );
    expect(active.channel.failure).toBe('CHANNEL_AUTH_FAILED');

    const result = await callTool(active, 'handoff_to_user', { spec: STRIPE_SPEC });
    expect(outcomeOf(result).status).toBe('text_mode');
    // The status stays text mode — the handoff happens in chat either way — and the reason
    // and its repair travel in a second text block (FM-10).
    expect(result.content).toHaveLength(2);
    expect((result.content[1] as { text: string }).text).toBe(
      `${ERROR_TEXTS.CHANNEL_AUTH_FAILED.message} ${ERROR_TEXTS.CHANNEL_AUTH_FAILED.fix ?? ''}`,
    );

    const resumed = errorOf(await callTool(active, 'handoff_to_user', { resume: HANDOFF_ID }));
    expect(resumed.code).toBe('CHANNEL_AUTH_FAILED');
  });

  it('names the version mismatch and tells the agent the app must be updated', async () => {
    const active = await open({ refuse: 'protocol_unsupported' });
    await active.app?.waitFor(
      () => active.channel.failure !== undefined,
      5_000,
      'the app to refuse the protocol version',
    );
    expect(active.channel.failure).toBe('PROTOCOL_MISMATCH');

    const result = await callTool(active, 'handoff_to_user', { spec: STRIPE_SPEC });
    expect(outcomeOf(result).status).toBe('text_mode');
    expect((result.content[1] as { text: string }).text).toContain('Update the app');

    const verified = errorOf(
      await callTool(active, 'handoff_verify', {
        handoff_id: HANDOFF_ID,
        verify: { ok: null, detail: 'no way to check' },
      }),
    );
    expect(verified.code).toBe('PROTOCOL_MISMATCH');
  });
});

describe('cancellation (A-09, FM-07)', () => {
  it('tells the app the call detached and forgets it', async () => {
    const active = await open({
      scenario: scripted('cancelled', 'The agent cancels while the user is still working.', [
        { onOpen: { handoff_id: HANDOFF_ID } },
        { awaitMessage: { expect: 'handoff.detach_call' } },
        { emitEvent: { outcome: appOutcome('abandoned', { final: true }) } },
      ]),
    });
    await registered(active);
    const app = active.app;

    const controller = new AbortController();
    const pending = callTool(
      active,
      'handoff_to_user',
      { spec: STRIPE_SPEC },
      { signal: controller.signal },
    );
    await app?.waitFor(() => app.expectations().includes('handoff.open'), 5_000, 'the open');
    controller.abort();
    await expect(pending).rejects.toThrow();

    await app?.waitFor(
      () => app.expectations().includes('handoff.detach_call'),
      5_000,
      'the detach notification',
    );
    const detach = active.app?.recorded.find(
      (entry) => (entry.message as { method?: string }).method === 'handoff.detach_call',
    )?.message as { params: Record<string, unknown> };
    expect(detach.params['reason']).toBe('cancelled');
    expect(detach.params['handoff_id']).toBe(HANDOFF_ID);

    // The event that follows names a call nobody is waiting on any more. Nothing must happen:
    // the entry is gone, and the fake's own line is still a valid one (§5.7, "forget it").
    await app?.waitFor(() => app.remaining().length === 0, 5_000, 'the event after the detach');
    expect(active.logText()).toContain('event_for_unknown_call');
    expect(active.app?.violations).toEqual([]);
  });
});

describe('the five application errors of §6.3 become the catalogue of §4.7.5', () => {
  it.each([
    ['not_waiting', 'HANDOFF_NOT_WAITING'],
    ['final', 'HANDOFF_FINAL'],
  ])('answers %s with %s', async (name, code) => {
    const active = await open({
      scenario: scripted(`continue-${name}`, `The app refuses a continue with ${name}.`, [
        { onContinue: { error: { name } } },
      ]),
    });
    await registered(active);

    const error = errorOf(
      await callTool(active, 'handoff_to_user', {
        handoff_id: HANDOFF_ID,
        reply: 'here is the answer',
      }),
    );
    expect(error.code).toBe(code);
    expect(error.problems[0]?.path).toBe('handoff_id');
  });

  it('turns unknown_value_key into the SPEC_INVALID of S3, one problem per key', async () => {
    const active = await open({
      scenario: scripted(
        'continue-unknown-value-key',
        'A continue naming a value the handoff never declared, checked where the keys are.',
        [
          {
            onContinue: { error: { name: 'unknown_value_key', keys: ['endpoint_url', 'events'] } },
          },
        ],
      ),
    });
    await registered(active);

    const error = errorOf(
      await callTool(active, 'handoff_to_user', {
        handoff_id: HANDOFF_ID,
        reply: 'use these steps instead',
        replacement_steps: [{ text: 'Paste the endpoint URL.', values: ['endpoint_url'] }],
      }),
    );
    expect(error.code).toBe('SPEC_INVALID');
    expect(error.problems).toHaveLength(2);
    expect(error.problems[0]?.problem).toContain('endpoint_url');
    expect(error.problems[1]?.problem).toContain('events');
  });

  it('answers not_found on a resume with HANDOFF_NOT_FOUND', async () => {
    const active = await open({
      scenario: scripted('resume-not-found', 'A resume of a handoff the app does not know.', [
        { onResume: { state: 'active', error: { name: 'not_found' } } },
      ]),
    });
    await registered(active);

    const error = errorOf(await callTool(active, 'handoff_to_user', { resume: HANDOFF_ID }));
    expect(error.code).toBe('HANDOFF_NOT_FOUND');
    expect(error.problems[0]?.path).toBe('resume');
  });

  it('answers no_verify_in_spec with NO_VERIFY_IN_SPEC', async () => {
    const active = await open({
      scenario: scripted('verify-refused', 'A verification of a spec that asked for none.', [
        { onVerify: { error: { name: 'no_verify_in_spec' } } },
      ]),
    });
    await registered(active);

    const error = errorOf(
      await callTool(active, 'handoff_verify', {
        handoff_id: HANDOFF_ID,
        verify: { ok: true, detail: 'the endpoint answers' },
      }),
    );
    expect(error.code).toBe('NO_VERIFY_IN_SPEC');
  });
});

describe('replacement_steps are validated before they reach the channel (§5.2 step 3)', () => {
  it('reports the rules that need no value keys and sends nothing', async () => {
    const active = await open({
      scenario: scripted('never-continued', 'The steps never get past the server.', [
        { onContinue: {} },
      ]),
    });
    await registered(active);
    active.app?.mark();

    const error = errorOf(
      await callTool(active, 'handoff_to_user', {
        handoff_id: HANDOFF_ID,
        reply: 'try these instead',
        // S4: a placeholder that only a runbook may carry; S5: a scheme S5 forbids.
        replacement_steps: [{ text: 'Open {{endpoint_url}}.', url: 'ftp://example.test/x' }],
      }),
    );
    expect(error.code).toBe('SPEC_INVALID');
    expect(error.problems.map((problem) => problem.path)).toEqual([
      'replacement_steps[0].url',
      'replacement_steps[0].text',
    ]);
    expect(active.app?.expectations()).toEqual([]);
  });
});

describe('the image block of §4.7.4', () => {
  it('travels beside the outcome and is attached when the client can show one', async () => {
    const active = await open({
      scenario: scripted('screenshot-image', 'The user sends the pixels, not the text.', [
        { onOpen: { handoff_id: HANDOFF_ID } },
        {
          emitEvent: {
            outcome: appOutcome('screenshot', { screenshot: shot('image') }),
            image: PNG,
          },
        },
      ]),
    });
    await registered(active);

    const result = await callTool(active, 'handoff_to_user', { spec: STRIPE_SPEC });
    expect(outcomeOf(result).status).toBe('screenshot');
    expect(result.content).toHaveLength(2);
    expect(result.content[1]).toEqual({ type: 'image', data: PNG, mimeType: 'image/png' });
    expect(active.app?.violations).toEqual([]);
  });

  it('is left out for a client the capability table says cannot show images', async () => {
    const active = await open({
      agent: 'an-agent-the-table-does-not-know',
      scenario: scripted('screenshot-no-image', 'The same event, an agent without images.', [
        { onOpen: { handoff_id: HANDOFF_ID } },
        {
          emitEvent: {
            outcome: appOutcome('screenshot', { screenshot: shot('image') }),
            image: PNG,
          },
        },
      ]),
    });
    await registered(active);

    const result = await callTool(active, 'handoff_to_user', { spec: STRIPE_SPEC });
    expect(outcomeOf(result).status).toBe('screenshot');
    expect(result.content).toHaveLength(1);
  });
});

describe('at most one waiting call per handoff in this server (§5.7, TOOL-08)', () => {
  it('hands the older call transferred_to_other_session when a second one attaches', async () => {
    const active = await open({
      scenario: scripted('two-resumes', 'Two resumes of the same handoff, one after another.', [
        { onResume: { state: 'active' } },
        { onResume: { state: 'active' } },
        { emitEvent: { outcome: appOutcome('parked') } },
      ]),
    });
    await registered(active);

    const first = callTool(active, 'handoff_to_user', { resume: HANDOFF_ID });
    const app = active.app;
    await app?.waitFor(
      () => app.expectations().filter((method) => method === 'handoff.resume').length === 1,
      5_000,
      'the first resume',
    );
    const second = callTool(active, 'handoff_to_user', { resume: HANDOFF_ID });

    expect(outcomeOf(await first).status).toBe('transferred_to_other_session');
    expect(outcomeOf(await second).status).toBe('parked');
  });
});

/** A one-pixel PNG, base64: enough to prove the bytes cross and are attached unchanged. */
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** The `screenshot` object of §4.3, in either of its two modes. */
function shot(mode: 'image' | 'text'): Record<string, unknown> {
  return {
    mode,
    text: mode === 'text' ? 'Select events to listen to' : null,
    image_attached: mode === 'image',
    width: 2880,
    height: 1800,
    redactions: 0,
    ocr_engine: mode === 'text' ? 'tesseract' : null,
  };
}

/** The `call_id` of every message of one method the fake received. */
function callIds(active: Session, method: string): string[] {
  return (active.app?.recorded ?? [])
    .filter((entry) => (entry.message as { method?: string }).method === method)
    .map((entry) => {
      const params = (entry.message as { params?: Record<string, unknown> }).params ?? {};
      return String(params['call_id']);
    });
}

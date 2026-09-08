/**
 * The flows of §9 driven end to end (T-020 acceptance, §11.3).
 *
 * The agent is a real SDK `Client`, the server is the real one, the channel is the real
 * client over a real named pipe or Unix socket, and the app is `test/fake-app` replaying the
 * golden sequence of the flow. Each test then asks the fake for **both halves** of the
 * comparison — what it received against the golden's `→` lines, what it answered against the
 * `←` lines, modulo ids and timestamps — so a flow passes only when the traffic the product
 * generated is the traffic the fixture describes, message for message.
 *
 * That is the point of driving the goldens rather than asserting on the tool results alone.
 * A pipeline that opened a handoff with the right outcome and the wrong `call_id`, or that
 * minted a second call where the protocol says a continue re-attaches the first, would pass
 * every assertion about what the agent saw and fail here.
 *
 * No test waits for real time: the heartbeat is injected in milliseconds (§5.6 makes the
 * shortest real one fifty seconds) and every emission of a scenario fires as soon as it
 * reaches the head of the queue. The whole file is under two seconds.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { loadScenario } from '../fake-app';

import {
  callTool,
  goldenHandoffId,
  outcomeOf,
  registered,
  session,
  STRIPE_SPEC,
  type Session,
} from './session';

const live: Session[] = [];

afterEach(async () => {
  for (const active of live.splice(0)) await active.close();
});

/** A session on the scenario derived from a flow's golden, registered and marked. */
async function flow(name: string): Promise<Session> {
  const active = await session({ scenario: loadScenario(name) });
  live.push(active);
  await registered(active);
  // Every golden but `f01`, `f10` and the two refusals "begins after a successful
  // registration": the comparison starts where the fixture does.
  active.app?.mark();
  return active;
}

/** Both halves of the golden comparison, plus the invariants a clean run leaves behind. */
function assertGolden(active: Session): void {
  const app = active.app;
  if (app === undefined) throw new Error('no app');
  const received = app.goldenComparison();
  expect(received.actual).toEqual(received.expected);
  const answered = app.goldenAnswers();
  expect(answered.actual).toEqual(answered.expected);
  expect(app.violations).toEqual([]);
  expect(app.gaps).toEqual([]);
  expect(app.remaining()).toEqual([]);
}

describe('F-01 session start and registration (SRV-20, FM-02)', () => {
  it('registers over the real endpoint as soon as the channel is started', async () => {
    const active = await session({ scenario: loadScenario('f01-register') });
    live.push(active);
    await registered(active);

    expect(active.app?.sessions).toHaveLength(1);
    expect(active.channel.isConnected()).toBe(true);
    // The row the app is shown is the resolved one, not the table's: the app owns no agent
    // facts (ADPT-03), so the timeout it displays is the one this session actually has.
    const hello = active.app?.recorded[0]?.message as { params: Record<string, unknown> };
    const row = hello.params['capability_row'] as Record<string, unknown>;
    expect(row).toMatchObject({
      agent_id: 'claude-code',
      support: 'full',
      images_in_results: true,
      stop_hook: true,
      tool_timeout_ms: 1_800_000,
    });
  });

  it('degrades to text mode while the app has not answered yet', async () => {
    // No `registered()`: the call goes out while the socket is still being negotiated, which
    // is the whole of FM-02 on this side.
    const active = await session({ scenario: loadScenario('f01-register') });
    live.push(active);
    const first = outcomeOf(await callTool(active, 'handoff_to_user', { spec: STRIPE_SPEC }));
    expect(['text_mode', 'awaiting_verification']).toContain(first.status);
  });
});

describe('F-02 agent-opened handoff, happy path to verified', () => {
  it('opens, blocks, receives awaiting_verification and reports the verification', async () => {
    const active = await flow('f02-happy-path');
    const handoffId = goldenHandoffId('f02-happy-path.jsonl');

    const opened = outcomeOf(await callTool(active, 'handoff_to_user', { spec: STRIPE_SPEC }));
    expect(opened.status).toBe('awaiting_verification');
    expect(opened.handoff_id).toBe(handoffId);
    expect(opened.final).toBe(false);
    expect(opened.instruction).toContain(handoffId);
    // The app's fields survive the crossing: the note and the skipped step are the golden's.
    expect(opened.skipped_steps).toEqual([3]);
    expect(opened.notes).toHaveLength(1);

    const verified = outcomeOf(
      await callTool(active, 'handoff_verify', {
        handoff_id: handoffId,
        verify: {
          ok: true,
          detail: 'A test event reached /webhooks/stripe and the signature validated.',
        },
      }),
    );
    expect(verified.status).toBe('verified');
    expect(verified.final).toBe(true);
    expect(verified.verify).toMatchObject({ ok: true, late: false });

    assertGolden(active);
  });
});

describe('F-04 ask and screenshot round trip (TOOL-04, RESP-04)', () => {
  it('returns each event and re-attaches the same call on every reply', async () => {
    const active = await flow('f04-ask-reply');
    const handoffId = goldenHandoffId('f04-ask-reply.jsonl');

    const question = outcomeOf(await callTool(active, 'handoff_to_user', { spec: STRIPE_SPEC }));
    expect(question.status).toBe('question');
    expect(question.context?.step.index).toBe(2);

    const screenshot = outcomeOf(
      await callTool(active, 'handoff_to_user', {
        handoff_id: handoffId,
        reply: 'No, only the two events listed in the step.',
      }),
    );
    expect(screenshot.status).toBe('screenshot');
    // The user sent the extracted text, so no image block travels even though the row allows
    // one (§4.7.4, PREV-04).
    expect(screenshot.screenshot?.mode).toBe('text');

    // The last reply is answered `{ ok: true }` and the golden ends there: nothing more is
    // emitted, so the call is still blocking when the session closes. That is F-04: the call
    // is attached again and waiting (§9 F-04, last line).
    const pending = callTool(active, 'handoff_to_user', {
      handoff_id: handoffId,
      reply: 'Clear the search box: the two events appear under Checkout once the filter is empty.',
    });
    const app = active.app;
    await app?.waitFor(() => app.expectations().length >= 3, 5_000, 'the second continue');
    assertGolden(active);
    await active.close();
    await expect(pending).rejects.toThrow();
  });
});

describe('F-05 defer, resume, second deferral (RESP-05..07, TOOL-14)', () => {
  it('returns deferred, then parked on the resumed call', async () => {
    const active = await flow('f05-defer-park');
    const handoffId = goldenHandoffId('f05-defer-park.jsonl');

    const deferred = outcomeOf(await callTool(active, 'handoff_to_user', { spec: STRIPE_SPEC }));
    expect(deferred.status).toBe('deferred');
    expect(deferred.deferral_count).toBe(1);
    expect(deferred.instruction).toContain('resume');

    const parked = outcomeOf(await callTool(active, 'handoff_to_user', { resume: handoffId }));
    expect(parked.status).toBe('parked');
    expect(parked.deferral_count).toBe(2);
    expect(parked.final).toBe(false);

    assertGolden(active);
  });
});

describe('F-06 heartbeat and resume (TOOL-05..07)', () => {
  it('detaches at the deadline, answers in_progress and attaches the resume', async () => {
    const active = await session({
      scenario: loadScenario('f06-heartbeat-resume'),
      heartbeatAfterMs: 120,
    });
    live.push(active);
    await registered(active);
    active.app?.mark();
    const handoffId = goldenHandoffId('f06-heartbeat-resume.jsonl');

    const beat = outcomeOf(await callTool(active, 'handoff_to_user', { spec: STRIPE_SPEC }));
    expect(beat.status).toBe('in_progress');
    expect(beat.final).toBe(false);
    expect(beat.handoff_id).toBe(handoffId);
    expect(beat.instruction).toContain(`"resume": "${handoffId}"`);

    const resumed = outcomeOf(await callTool(active, 'handoff_to_user', { resume: handoffId }));
    expect(resumed.status).toBe('awaiting_verification');
    expect(resumed.already_delivered).toBe(false);

    assertGolden(active);
  });
});

describe('F-07 user-opened request (OPEN-05, DD-13)', () => {
  it('carries request_id to the app, which gives the handoff that id', async () => {
    const active = await flow('f07-user-request');
    const requestId = goldenHandoffId('f07-user-request.jsonl');

    const done = outcomeOf(
      await callTool(active, 'handoff_to_user', { spec: STRIPE_SPEC, request_id: requestId }),
    );
    expect(done.status).toBe('confirmed_by_user');
    expect(done.handoff_id).toBe(requestId);
    expect(done.final).toBe(true);

    assertGolden(active);
  });
});

describe('F-08 failed verification and correction round (VER-08..10)', () => {
  it('reports failed, then continues with replacement_steps into round 2', async () => {
    const active = await flow('f08-failed-correction');
    const handoffId = goldenHandoffId('f08-failed-correction.jsonl');

    const awaiting = outcomeOf(await callTool(active, 'handoff_to_user', { spec: STRIPE_SPEC }));
    expect(awaiting.status).toBe('awaiting_verification');

    const failed = outcomeOf(
      await callTool(active, 'handoff_verify', {
        handoff_id: handoffId,
        verify: {
          ok: false,
          detail: 'The test event returned 400: the signature does not match the stored secret.',
        },
      }),
    );
    expect(failed.status).toBe('failed');
    expect(failed.final).toBe(true);
    expect(failed.instruction).toContain('replacement_steps');

    const corrected = outcomeOf(
      await callTool(active, 'handoff_to_user', {
        handoff_id: handoffId,
        reply: 'The stored secret belongs to the old endpoint. Roll it and paste the new one.',
        replacement_steps: [
          { text: 'Open the endpoint and click Roll secret.' },
          { text: 'Copy the new signing secret into .env.' },
        ],
      }),
    );
    expect(corrected.status).toBe('awaiting_verification');
    expect(corrected.round).toBe(2);

    const verified = outcomeOf(
      await callTool(active, 'handoff_verify', {
        handoff_id: handoffId,
        verify: {
          ok: true,
          detail: 'A test event reached /webhooks/stripe and the signature validated.',
        },
      }),
    );
    expect(verified.status).toBe('verified');

    assertGolden(active);
  });
});

describe('F-11 detach, transfer and a late verification (TOOL-08, DD-16, FM-25)', () => {
  it('cancels, transfers, returns the final outcome once more and accepts the late report', async () => {
    const active = await flow('f11-transfer');
    const handoffId = goldenHandoffId('f11-transfer.jsonl');

    // The user presses Ctrl+C during the call: the SDK sends notifications/cancelled and the
    // server tells the app the call detached (§5.7, FM-07).
    const controller = new AbortController();
    const cancelled = callTool(
      active,
      'handoff_to_user',
      { spec: STRIPE_SPEC },
      { signal: controller.signal },
    );
    const app = active.app;
    await app?.waitFor(() => app.expectations().includes('handoff.open'), 5_000, 'the open');
    controller.abort();
    await expect(cancelled).rejects.toThrow();
    await app?.waitFor(
      () => app.expectations().includes('handoff.detach_call'),
      5_000,
      'the detach notification',
    );

    const transferred = outcomeOf(await callTool(active, 'handoff_to_user', { resume: handoffId }));
    expect(transferred.status).toBe('transferred_to_other_session');
    expect(transferred.final).toBe(false);

    // A second resume finds the handoff final: the outcome comes back once more, and it is
    // this server that marks it as already delivered (TOOL-07).
    const again = outcomeOf(await callTool(active, 'handoff_to_user', { resume: handoffId }));
    expect(again.status).toBe('not_verified');
    expect(again.final).toBe(true);
    expect(again.already_delivered).toBe(true);
    expect(again.resumed_from).toEqual({ agent: 'Claude Code', project: '/Users/g/dev/shop' });

    const late = outcomeOf(
      await callTool(active, 'handoff_verify', {
        handoff_id: handoffId,
        verify: {
          ok: true,
          detail: 'A test event reached /webhooks/stripe and the signature validated.',
        },
      }),
    );
    expect(late.status).toBe('verified');

    // The golden's last line is the goodbye of §5.3, which closing the channel sends.
    await active.sayGoodbye();
    await app?.waitFor(
      () => app.expectations().includes('session.bye'),
      5_000,
      'the goodbye of §5.3',
    );
    assertGolden(active);
  });
});

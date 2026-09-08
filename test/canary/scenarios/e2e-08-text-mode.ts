/**
 * E2E-8, the one end-to-end scenario the server can run alone (T-023, TECHNICAL-DESIGN
 * §11.5, §5.9, SRV-14..16, ARCH-04; `TASKS.md` §0.4 item 3).
 *
 * No overlay is listening — the harness never starts one and `HANDOFF_HOME` points at an
 * empty temporary folder — so `handoff_to_user` must answer `text_mode` with the spec
 * rendered as text and an instruction telling the agent to run the handoff in the chat.
 * "No database row" (the second half of the §11.5 row) is the app's assertion and belongs
 * to `handoff-app`'s own canary; here there is no app to have a row.
 *
 * The spec is given in the prompt in full, because a canary must not depend on the model
 * inventing a valid one: what is being tested is the server's answer, not the model's
 * drafting.
 */
import { check, type Assertion } from '../classify.ts';
import { observationsOf, type CanaryRun } from '../runner.ts';
import { serverConnected, wellFormed, type Scenario } from './scenario.ts';

/** The heading `src/textmode/render.ts` puts at the top of every rendered spec (§5.9). */
export const TEXT_MODE_HEADING = '# Handoff (text mode):';

/** The spec the agent is told to send, verbatim. Small, valid, and free of secrets. */
export const CANARY_SPEC = {
  spec_version: 1,
  goal: 'Enable the maintenance banner in the admin console',
  where: 'Admin console → Settings → Announcements',
  why_human: 'Only an account administrator can publish an announcement.',
  values: { banner_text: 'Scheduled maintenance on Sunday at 02:00 UTC' },
  steps: [
    { text: 'Open Settings and then Announcements.' },
    { text: 'Paste the banner text into the message field.', values: ['banner_text'] },
    { text: 'Publish the announcement.' },
  ],
};

const PROMPT = [
  'Call the tool mcp__handoff__handoff_to_user exactly once with this exact spec argument:',
  JSON.stringify({ spec: CANARY_SPEC }),
  'Then present the returned steps to me in your reply, one per line, and nothing else.',
].join(' ');

function textModeResults(run: CanaryRun): string[] {
  return run.toolResults.map((result) => result.text).filter((text) => text.includes('text_mode'));
}

export const textModeScenario: Scenario = {
  id: 'e2e-08-text-mode',
  title: 'a handoff opened with no overlay listening comes back as text mode',
  covers: ['E2E-8', 'A-01'],
  options: { prompt: PROMPT, maxTurns: 6 },

  check(run) {
    const assertions: Assertion[] = [wellFormed(run), serverConnected(run)];
    const results = observationsOf(run, 'tool_result').filter(
      (observation) => observation['method'] === 'handoff_to_user',
    );
    const reply = run.result?.result ?? '';
    const resultTexts = textModeResults(run);

    assertions.push(
      check(
        'model',
        'the agent calls handoff_to_user with the spec it was given',
        'model',
        observationsOf(run, 'tool_call').some(
          (observation) => observation['method'] === 'handoff_to_user',
        ),
        `tool calls ${JSON.stringify(observationsOf(run, 'tool_call').map((o) => o['method']))}`,
      ),
      check(
        'E2E-8',
        'the outcome the server returns has status text_mode',
        'protocol',
        results.length === 1 && results[0]?.['status'] === 'text_mode',
        `statuses ${JSON.stringify(results.map((observation) => observation['status']))}`,
      ),
      check(
        'E2E-8',
        'the tool result the agent received carries the rendered spec of §5.9',
        'protocol',
        resultTexts.some((text) => text.includes(TEXT_MODE_HEADING)),
        `${String(resultTexts.length)} text_mode results, ` +
          `${String(resultTexts.filter((text) => text.includes(TEXT_MODE_HEADING)).length)} with the heading`,
      ),
      check(
        'E2E-8',
        'the rendered spec names every step of the spec that was sent',
        'protocol',
        CANARY_SPEC.steps.every((step) => resultTexts.some((text) => text.includes(step.text))),
        `steps found ${String(
          CANARY_SPEC.steps.filter((step) => resultTexts.some((text) => text.includes(step.text)))
            .length,
        )} of ${String(CANARY_SPEC.steps.length)}`,
      ),
      check(
        'model',
        'the agent presents the steps to the user rather than only reporting a status',
        'model',
        CANARY_SPEC.steps.filter((step) => reply.includes(step.text.replace(/\.$/u, ''))).length >=
          2,
        `reply of ${String(reply.length)} characters`,
      ),
    );

    return assertions;
  },

  facts(run) {
    const results = observationsOf(run, 'tool_result').filter(
      (observation) => observation['method'] === 'handoff_to_user',
    );
    return {
      status: results[0]?.['status'] ?? null,
      turns: run.result?.num_turns ?? null,
    };
  },
};

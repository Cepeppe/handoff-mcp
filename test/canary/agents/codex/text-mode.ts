/**
 * E2E-8 against Codex: a handoff opened with no overlay listening comes back as text mode
 * (T-066, TECHNICAL-DESIGN §11.5, §5.9, SRV-14..16).
 *
 * The same spec and the same assertions as the Claude scenario of
 * `../../scenarios/e2e-08-text-mode.ts`, which is where both are defined, so the two agents
 * are measured against one thing. `HANDOFF_HOME` is an empty temporary folder with no token
 * file, so the server cannot reach an app and must answer `text_mode`.
 */
import { check, type Assertion } from '../../classify.ts';
import { observationsOf, type CanaryRun } from '../../runner.ts';
import { CANARY_SPEC, TEXT_MODE_HEADING } from '../../scenarios/e2e-08-text-mode.ts';
import { wellFormed } from '../../scenarios/scenario.ts';
import { serverRegistered, type CodexScenario } from './scenario.ts';

const PROMPT = [
  'Call the tool handoff_to_user of the MCP server handoff exactly once with this exact argument:',
  JSON.stringify({ spec: CANARY_SPEC }),
  'Then present the returned steps to me in your reply, one per line, and nothing else.',
].join(' ');

function textModeResults(run: CanaryRun): string[] {
  return run.toolResults.map((result) => result.text).filter((text) => text.includes('text_mode'));
}

export const codexTextModeScenario: CodexScenario = {
  id: 'codex-e2e-08-text-mode',
  title: 'a handoff Codex opens with no overlay listening comes back as text mode',
  covers: ['E2E-8'],
  options: { prompt: PROMPT },

  check(run) {
    const results = observationsOf(run, 'tool_result').filter(
      (observation) => observation['method'] === 'handoff_to_user',
    );
    const texts = textModeResults(run);
    const reply = run.result?.result ?? '';
    const calls = observationsOf(run, 'tool_call').map((observation) => observation['method']);

    const assertions: Assertion[] = [
      wellFormed(run),
      serverRegistered(run),
      check(
        'model',
        'the agent calls handoff_to_user with the spec it was given',
        'model',
        calls.includes('handoff_to_user'),
        `tool calls ${JSON.stringify(calls)}`,
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
        'the tool result Codex received carries the rendered spec of §5.9',
        'protocol',
        texts.some((text) => text.includes(TEXT_MODE_HEADING)),
        `${String(texts.length)} text_mode results, ` +
          `${String(texts.filter((text) => text.includes(TEXT_MODE_HEADING)).length)} with the heading`,
      ),
      check(
        'E2E-8',
        'the rendered spec names every step of the spec that was sent',
        'protocol',
        CANARY_SPEC.steps.every((step) => texts.some((text) => text.includes(step.text))),
        `steps found ${String(
          CANARY_SPEC.steps.filter((step) => texts.some((text) => text.includes(step.text))).length,
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
    ];
    return assertions;
  },

  facts(run) {
    const results = observationsOf(run, 'tool_result').filter(
      (observation) => observation['method'] === 'handoff_to_user',
    );
    return {
      status: results[0]?.['status'] ?? null,
      turns: run.result?.num_turns ?? null,
      usage: run.result?.['usage'] ?? null,
    };
  },
};

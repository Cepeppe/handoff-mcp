/**
 * The degraded path, against the real Codex and an overlay that is listening (T-066;
 * FM-03, FM-04, SRV-20; TECHNICAL-DESIGN §4.7.4, §5.7; DESIGN-TREE 8.1).
 *
 * This is the reason Codex is the second agent: it has no end-of-turn hook `codex exec` will
 * run, so the only things that keep a long handoff alive are the heartbeat and the text of
 * the instruction. The run proves both with nothing but the server's own mechanisms:
 *
 * 1. Codex opens the handoff; `fake-app` answers the open and then says nothing, as a person
 *    who is still working would. With no timeout configured the codex row gives the 50 s
 *    heartbeat (FM-04): the server detaches the call, tells the overlay why, and answers
 *    `in_progress`.
 * 2. Codex resumes, as that instruction says, and the overlay reports that the user deferred
 *    the step. The instruction Codex gets is the no-hook variant of §4.7.4 — "Nothing will
 *    remind you" — because the row says there is no Stop hook (FM-03).
 * 3. Codex resumes again before it finishes, remembering by itself, and gets the final
 *    outcome.
 *
 * Each protocol assertion applies only once the model has done its part, so a model that
 * never resumes is reported, and retried, as a model failure and not as a broken protocol.
 */
import { check, type Assertion } from '../../classify.ts';
import { observationsOf, type CanaryRun } from '../../runner.ts';
import { CANARY_SPEC } from '../../scenarios/e2e-08-text-mode.ts';
import { wellFormed } from '../../scenarios/scenario.ts';
import { startScriptedApp, type AppScript } from './app.ts';
import { outcomesReceived, serverRegistered, type CodexScenario } from './scenario.ts';
import { HEARTBEAT_FLOOR_MS } from './timeouts.ts';

/** A phrase only the no-hook variant of the deferred instruction carries (§4.7.4). */
export const NO_HOOK_PHRASE = 'Nothing will remind you';

/** A phrase only the Stop-hook variant carries. */
export const HOOK_PHRASE = 'Stop hook';

/** How far past the heartbeat floor the in_progress answer may land and still be it. */
export const HEARTBEAT_TOLERANCE_MS = 30_000;

/** `fake-app` replaces this string with the handoff the connection is working on. */
const HANDOFF_ID = '$handoff_id';

/** The fields every outcome the overlay sends has in common here (handoff-outcome v1). */
const OUTCOME = {
  outcome_version: 1,
  handoff_id: HANDOFF_ID,
  round: 1,
  screenshot: null,
  context: null,
  skipped_steps: [],
  notes: [],
  secret_treated: [],
  verify: null,
  resumed_from: null,
  app_reachable: true,
  already_delivered: false,
  runbooks: [],
  spec_text: null,
};

/** The user defers on step 2. The server rewrites `instruction` from the row. */
export const DEFERRED_OUTCOME = {
  ...OUTCOME,
  status: 'deferred',
  final: false,
  instruction: 'Park this step and resume it before you conclude your turn.',
  current_step: { index: 2, total: 3, text: 'Paste the banner text into the message field.' },
  user_text: 'I have to ask a colleague for the final wording first.',
  deferral_count: 1,
};

/** The user comes back and finishes; the spec has no `verify`, so it ends confirmed (RESP-09). */
export const CONFIRMED_OUTCOME = {
  ...OUTCOME,
  status: 'confirmed_by_user',
  final: true,
  instruction: 'The handoff is complete and recorded as confirmed by the user.',
  current_step: { index: 3, total: 3, text: 'Publish the announcement.' },
  user_text: null,
  deferral_count: 1,
};

/** What the overlay does, in order. */
export const DEGRADED_PATH_SCRIPT: AppScript = {
  name: 'codex-degraded-path',
  why: 'The heartbeat detaches the first call; the agent resumes, the user defers, the agent resumes again with no hook to remind it, and the user finishes.',
  actions: [
    { onOpen: {} },
    { awaitMessage: { expect: 'handoff.detach_call' } },
    { onResume: { state: 'active' } },
    { emitEvent: { outcome: DEFERRED_OUTCOME }, afterMs: 1_000 },
    { onResume: { state: 'active' } },
    { emitEvent: { outcome: CONFIRMED_OUTCOME }, afterMs: 1_000 },
  ],
};

const PROMPT = [
  'Call the tool handoff_to_user of the MCP server handoff with this exact argument:',
  JSON.stringify({ spec: CANARY_SPEC }),
  'The call blocks while a person does the steps.',
  'Every result it returns has a status and an instruction:',
  'do exactly what the instruction says, including calling handoff_to_user again when it',
  'tells you to, until a result has final set to true.',
  'Then reply with exactly DONE and nothing else.',
].join(' ');

function methodOf(message: unknown): string | undefined {
  if (typeof message !== 'object' || message === null) return undefined;
  const method = (message as Record<string, unknown>)['method'];
  return typeof method === 'string' ? method : undefined;
}

function paramsOf(message: unknown): Readonly<Record<string, unknown>> {
  if (typeof message !== 'object' || message === null) return {};
  const params = (message as Record<string, unknown>)['params'];
  return typeof params === 'object' && params !== null ? (params as Record<string, unknown>) : {};
}

function statuses(run: CanaryRun): string[] {
  return observationsOf(run, 'tool_result')
    .filter((observation) => observation['method'] === 'handoff_to_user')
    .map((observation) => String(observation['status']));
}

/** From the first `handoff_to_user` call to its result, in milliseconds. */
function firstAnswerAfterMs(run: CanaryRun): number | undefined {
  const call = observationsOf(run, 'tool_call').find(
    (observation) => observation['method'] === 'handoff_to_user',
  );
  const result = observationsOf(run, 'tool_result').find(
    (observation) => observation['method'] === 'handoff_to_user',
  );
  return call === undefined || result === undefined
    ? undefined
    : Date.parse(result.at) - Date.parse(call.at);
}

function deferredInstruction(run: CanaryRun): string | undefined {
  const deferred = outcomesReceived(run).find((outcome) => outcome['status'] === 'deferred');
  const instruction = deferred?.['instruction'];
  return typeof instruction === 'string' ? instruction : undefined;
}

function variantOf(instruction: string | undefined): string | null {
  if (instruction === undefined) return null;
  if (instruction.includes(HOOK_PHRASE)) return 'stop_hook';
  return instruction.includes(NO_HOOK_PHRASE) ? 'no_stop_hook' : 'neither';
}

export const codexDegradedPathScenario: CodexScenario = {
  id: 'codex-degraded-path',
  title: 'heartbeat, resume, and a deferral remembered with no hook, against a listening overlay',
  covers: ['FM-03', 'FM-04', 'SRV-20'],
  options: {
    prompt: PROMPT,
    app: (home) => startScriptedApp(home, DEGRADED_PATH_SCRIPT),
  },

  check(run) {
    const received = run.app?.received ?? [];
    const methods = received.map(methodOf);
    const detach = received.find((message) => methodOf(message) === 'handoff.detach_call');
    const resumes = methods.filter((method) => method === 'handoff.resume').length;
    const opened = observationsOf(run, 'tool_call').some(
      (observation) => observation['method'] === 'handoff_to_user',
    );
    const seen = statuses(run);
    const answeredAfter = firstAnswerAfterMs(run);
    const instruction = deferredInstruction(run);

    const assertions: Assertion[] = [
      wellFormed(run),
      serverRegistered(run),
      check(
        'model',
        'the agent opens the handoff with the spec it was given',
        'model',
        opened,
        `tool uses ${JSON.stringify(run.toolUses.map((use) => use.name))}`,
      ),
      check(
        'SRV-20',
        'the server registers with the overlay and opens the handoff there',
        'protocol',
        !opened || methods.includes('handoff.open'),
        `overlay received ${JSON.stringify(methods)}`,
      ),
      check(
        'FM-04',
        'the call detaches at the heartbeat and tells the overlay so',
        'protocol',
        !opened || paramsOf(detach)['reason'] === 'heartbeat',
        `detach_call reason ${String(paramsOf(detach)['reason'])}`,
      ),
      check(
        'FM-04',
        `the first answer is in_progress, at the ${String(HEARTBEAT_FLOOR_MS)} ms heartbeat`,
        'protocol',
        !opened ||
          (seen[0] === 'in_progress' &&
            answeredAfter !== undefined &&
            answeredAfter >= HEARTBEAT_FLOOR_MS - 1000 &&
            answeredAfter <= HEARTBEAT_FLOOR_MS + HEARTBEAT_TOLERANCE_MS),
        `statuses ${JSON.stringify(seen)}, first answer after ${String(answeredAfter)} ms`,
      ),
      check(
        'model',
        'the agent resumes after in_progress, as the instruction says',
        'model',
        resumes >= 1,
        `${String(resumes)} resumes reached the overlay`,
      ),
      check(
        'FM-03',
        'the deferred instruction names no hook and tells the agent to remember by itself',
        'protocol',
        resumes < 1 || variantOf(instruction) === 'no_stop_hook',
        `instruction variant ${String(variantOf(instruction))}`,
      ),
      check(
        'model',
        'the agent resumes the deferred handoff before it finishes, with no hook to remind it',
        'model',
        resumes >= 2,
        `${String(resumes)} resumes reached the overlay`,
      ),
      check(
        'FM-03',
        'the final outcome reaches the agent',
        'protocol',
        resumes < 2 || seen.includes('confirmed_by_user'),
        `statuses ${JSON.stringify(seen)}`,
      ),
      check(
        'protocol',
        'every channel line either way is one the schema accepts',
        'protocol',
        run.app !== undefined && run.app.violations.length === 0,
        `${String(run.app?.violations.length ?? 'no overlay')} violations`,
      ),
    ];
    return assertions;
  },

  facts(run) {
    return {
      statuses: statuses(run),
      first_answer_after_ms: firstAnswerAfterMs(run) ?? null,
      resumes: (run.app?.received ?? []).filter((message) => methodOf(message) === 'handoff.resume')
        .length,
      deferred_instruction_variant: variantOf(deferredInstruction(run)),
      overlay_script_left: run.app?.remaining ?? null,
      channel_violations: run.app?.violations.length ?? null,
      usage: run.result?.['usage'] ?? null,
    };
  },
};

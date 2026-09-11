/**
 * The degraded path, against the real OpenCode and an overlay that is listening (T-074;
 * FM-03, FM-04, SRV-20; TECHNICAL-DESIGN §4.7.4, §5.7).
 *
 * OpenCode is `base` for the same reason Codex is: it has no end-of-turn hook to register, so
 * the heartbeat and the text of the instruction are what keep a long handoff alive. The flow and
 * every assertion are the Codex ones of `../codex/degraded.ts` — the overlay's script, the
 * heartbeat, the no-hook instruction variant, two resumes — imported rather than copied, since
 * they read only the server's observations, the shared transcript and what the overlay received.
 *
 * One thing is sharper here than for Codex: OpenCode's default timeout is 60 s (the
 * `opencode-default-timeout` canary), so the 50 s heartbeat is not only a safety margin, it is
 * the only reason the first call comes back as `in_progress` rather than as a timeout error.
 */
import { CANARY_SPEC } from '../../scenarios/e2e-08-text-mode.ts';
import { startScriptedApp, type AppScript } from '../codex/app.ts';
import { DEGRADED_PATH_SCRIPT, codexDegradedPathScenario } from '../codex/degraded.ts';
import type { OpenCodeScenario } from './scenario.ts';

/** The overlay's script: the Codex one, under a name of its own. */
export const OPENCODE_DEGRADED_PATH_SCRIPT: AppScript = {
  ...DEGRADED_PATH_SCRIPT,
  name: 'opencode-degraded-path',
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

export const opencodeDegradedPathScenario: OpenCodeScenario = {
  id: 'opencode-degraded-path',
  title: 'heartbeat, resume, and a deferral remembered with no hook, against a listening overlay',
  covers: ['FM-03', 'FM-04', 'SRV-20'],
  options: {
    prompt: PROMPT,
    app: (home) => startScriptedApp(home, OPENCODE_DEGRADED_PATH_SCRIPT),
  },
  check: (run) => codexDegradedPathScenario.check(run),
  facts: (run) => codexDegradedPathScenario.facts?.(run) ?? {},
};

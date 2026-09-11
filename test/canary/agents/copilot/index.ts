/**
 * The GitHub Copilot scenarios, in the order the driver runs them (T-072, TECHNICAL-DESIGN
 * §11.5).
 *
 * VS Code's first: it spends no credit and it is the editor half of the acceptance. Then the
 * CLI's, cheapest first: the observation run, E2E-8, the per-server timeout (twenty seconds of
 * sleep), the degraded path (a 50 s heartbeat and three calls) and the default timeout (a minute
 * and a half of wall clock). Each CLI run spends the account's AI credits, and the owner keeps
 * Copilot on the Free plan (T-071), so this set is run by hand, rarely, and never by a workflow.
 */
import type { CanaryRun } from '../../runner.ts';
import { copilotDegradedPathScenario } from './degraded.ts';
import { copilotEditorIdentityScenario } from './editor.ts';
import { runVsCode } from './editor-runner.ts';
import { copilotObserveScenario } from './observe.ts';
import { runCopilot } from './runner.ts';
import type { CopilotScenario } from './scenario.ts';
import { copilotTextModeScenario } from './text-mode.ts';
import { copilotDefaultTimeoutScenario, copilotPerServerTimeoutScenario } from './timeouts.ts';

export type { CopilotScenario } from './scenario.ts';

export const COPILOT_SCENARIOS: readonly CopilotScenario[] = [
  copilotEditorIdentityScenario,
  copilotObserveScenario,
  copilotTextModeScenario,
  copilotPerServerTimeoutScenario,
  copilotDegradedPathScenario,
  copilotDefaultTimeoutScenario,
];

/** Runs a scenario the way its surface is run: VS Code launched, or the CLI. */
export function runCopilotScenario(scenario: CopilotScenario): Promise<CanaryRun> {
  return scenario.surface === 'editor' ? runVsCode(scenario.options) : runCopilot(scenario.options);
}

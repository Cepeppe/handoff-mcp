/**
 * The scenarios of the server-alone canary, in the order the driver runs them (T-023,
 * TECHNICAL-DESIGN §11.5).
 *
 * Cheapest first, so a broken installation is reported before a run that costs two minutes
 * of wall clock. The app-dependent scenarios of §11.5 (E2E-1..7, 9..11) are not here and
 * cannot be: they need the closed overlay, and they belong to `handoff-app`'s own canary
 * workflow (`TASKS.md` §0.4 item 3, T-043/T-056).
 */
import { textModeScenario } from './e2e-08-text-mode.ts';
import { observeScenario } from './observe.ts';
import {
  defaultTimeoutScenario,
  perServerTimeoutScenario,
  timeoutHonouredScenario,
} from './timeouts.ts';
import type { Scenario } from './scenario.ts';

export type { Scenario } from './scenario.ts';

export const SCENARIOS: readonly Scenario[] = [
  observeScenario,
  textModeScenario,
  timeoutHonouredScenario,
  perServerTimeoutScenario,
  defaultTimeoutScenario,
];

/** The assumptions and §11.5 scenario ids this suite covers, deduplicated and sorted. */
export function coveredIds(scenarios: readonly Scenario[] = SCENARIOS): string[] {
  return [...new Set(scenarios.flatMap((scenario) => scenario.covers))].sort();
}

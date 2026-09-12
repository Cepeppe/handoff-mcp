/**
 * The Kilo Code scenarios, in the order the driver runs them (T-081, TECHNICAL-DESIGN §11.5).
 *
 * Cheapest first, as for the other agents: three one-call runs of a few seconds, then the
 * per-server timeout (twenty seconds), the degraded path (a 50 s heartbeat and three calls) and
 * the default timeout (up to two minutes of wall clock, few tokens). All six run against Kilo's
 * CLI: the VS Code surface runs the same binary as `kilo serve` and starts its servers only for
 * a task typed into its panel, which no script can do, so it is measured by hand
 * (`docs/agent-facts.md`).
 */
import { kiloDegradedPathScenario } from './degraded.ts';
import { kiloImageScenario } from './image.ts';
import { kiloObserveScenario } from './observe.ts';
import { kiloTextModeScenario } from './text-mode.ts';
import { kiloDefaultTimeoutScenario, kiloPerServerTimeoutScenario } from './timeouts.ts';
import type { KiloScenario } from './scenario.ts';

export type { KiloScenario } from './scenario.ts';

export const KILO_SCENARIOS: readonly KiloScenario[] = [
  kiloObserveScenario,
  kiloImageScenario,
  kiloTextModeScenario,
  kiloPerServerTimeoutScenario,
  kiloDegradedPathScenario,
  kiloDefaultTimeoutScenario,
];

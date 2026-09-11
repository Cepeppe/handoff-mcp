/**
 * The OpenCode scenarios, in the order the driver runs them (T-074, TECHNICAL-DESIGN §11.5).
 *
 * Cheapest first, as for the other agents: three one-call runs of a few seconds, then the
 * per-server timeout (twenty seconds), the degraded path (a 50 s heartbeat and three calls) and
 * the default timeout (one minute of wall clock, few tokens).
 */
import { opencodeDegradedPathScenario } from './degraded.ts';
import { opencodeImageScenario } from './image.ts';
import { opencodeObserveScenario } from './observe.ts';
import { opencodeTextModeScenario } from './text-mode.ts';
import { opencodeDefaultTimeoutScenario, opencodePerServerTimeoutScenario } from './timeouts.ts';
import type { OpenCodeScenario } from './scenario.ts';

export type { OpenCodeScenario } from './scenario.ts';

export const OPENCODE_SCENARIOS: readonly OpenCodeScenario[] = [
  opencodeObserveScenario,
  opencodeImageScenario,
  opencodeTextModeScenario,
  opencodePerServerTimeoutScenario,
  opencodeDegradedPathScenario,
  opencodeDefaultTimeoutScenario,
];

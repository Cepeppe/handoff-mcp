/**
 * The Codex scenarios, in the order the driver runs them (T-066, TECHNICAL-DESIGN §11.5).
 *
 * Cheapest first, as for Claude Code: three one-call runs of a few seconds, then the
 * per-server timeout (half a minute), the degraded path (a 50 s heartbeat and three calls)
 * and the bounded probe of the default timeout (two minutes of wall clock, few tokens).
 */
import { codexDegradedPathScenario } from './degraded.ts';
import { codexImageScenario } from './image.ts';
import { codexObserveScenario } from './observe.ts';
import { codexTextModeScenario } from './text-mode.ts';
import { codexDefaultTimeoutScenario, codexPerServerTimeoutScenario } from './timeouts.ts';
import type { CodexScenario } from './scenario.ts';

export type { CodexScenario } from './scenario.ts';

export const CODEX_SCENARIOS: readonly CodexScenario[] = [
  codexObserveScenario,
  codexImageScenario,
  codexTextModeScenario,
  codexPerServerTimeoutScenario,
  codexDegradedPathScenario,
  codexDefaultTimeoutScenario,
];

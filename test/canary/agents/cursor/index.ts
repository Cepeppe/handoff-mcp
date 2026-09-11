/**
 * The Cursor scenarios, in the order the driver runs them (T-069, TECHNICAL-DESIGN §11.5).
 *
 * The editor's first: it spends no agent request and it is the acceptance of T-069. Then the
 * CLI's, cheapest first: the observation run, E2E-8, the degraded path (a 50 s heartbeat and
 * three calls) and the default timeout (a minute and a half of wall clock). Each CLI run spends
 * one of the account's requests, and the owner keeps Cursor on the Free plan (T-068), so this set
 * is run by hand, rarely, and never by a workflow.
 */
import type { CanaryRun } from '../../runner.ts';
import { cursorDegradedPathScenario } from './degraded.ts';
import { cursorEditorIdentityScenario } from './editor.ts';
import { runCursorEditor } from './editor-runner.ts';
import { cursorObserveScenario } from './observe.ts';
import { runCursor } from './runner.ts';
import type { CursorScenario } from './scenario.ts';
import { cursorTextModeScenario } from './text-mode.ts';
import { cursorDefaultTimeoutScenario } from './timeouts.ts';

export type { CursorScenario } from './scenario.ts';

export const CURSOR_SCENARIOS: readonly CursorScenario[] = [
  cursorEditorIdentityScenario,
  cursorObserveScenario,
  cursorTextModeScenario,
  cursorDegradedPathScenario,
  cursorDefaultTimeoutScenario,
];

/** Runs a scenario the way its surface is run: the editor launched, or the CLI. */
export function runCursorScenario(scenario: CursorScenario): Promise<CanaryRun> {
  return scenario.surface === 'editor'
    ? runCursorEditor(scenario.options)
    : runCursor(scenario.options);
}

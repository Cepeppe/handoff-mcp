/**
 * E2E-8 against Kilo Code: a handoff opened with no overlay listening comes back as text mode
 * (T-081, TECHNICAL-DESIGN §11.5, §5.9, SRV-14..16).
 *
 * The same spec, the same prompt and the same assertions as the Codex and OpenCode scenarios,
 * which read only the server's observations and the shared transcript: the check is Codex's,
 * imported, so every agent is measured against one thing. `HANDOFF_HOME` is an empty temporary
 * folder with no token file, so the server cannot reach an app and must answer `text_mode`.
 */
import { CANARY_SPEC } from '../../scenarios/e2e-08-text-mode.ts';
import { codexTextModeScenario } from '../codex/text-mode.ts';
import type { KiloScenario } from './scenario.ts';

const PROMPT = [
  'Call the tool handoff_to_user of the MCP server handoff exactly once with this exact argument:',
  JSON.stringify({ spec: CANARY_SPEC }),
  'Then present the returned steps to me in your reply, one per line, and nothing else.',
].join(' ');

export const kiloTextModeScenario: KiloScenario = {
  id: 'kilo-code-e2e-08-text-mode',
  title: 'a handoff Kilo Code opens with no overlay listening comes back as text mode',
  covers: ['E2E-8'],
  options: { prompt: PROMPT },
  check: (run) => codexTextModeScenario.check(run),
  facts: (run) => codexTextModeScenario.facts?.(run) ?? {},
};

/**
 * `fake-app`, the scripted channel listener (TECHNICAL-DESIGN §11.3).
 *
 * Import this from an integration test:
 *
 * ```ts
 * const app = await FakeApp.start({ scenario: loadScenario('f02-happy-path') });
 * // hand `app.env` to the peer so both sides derive the same endpoint
 * await app.waitFor(() => app.sessions.length === 1, 5_000, 'a registration');
 * await app.stop();
 * ```
 *
 * `README.md` in this folder is how to write a scenario.
 */
export { FIXTURE_TOKEN, FakeApp, HELLO_TIMEOUT_MS } from './server';
export type { FakeAppOptions, Recorded, Violation } from './server';
export {
  APPLICATION_ERROR_CODES,
  HANDOFF_ID_SENTINEL,
  HANDOFF_STATES,
  REPLY_METHOD,
  REQUEST_ID_SENTINEL,
  SCENARIO_DIR,
  emptyScenario,
  expectationOf,
  isEmission,
  loadScenario,
  parseAction,
  parseScenario,
  scenarioFromGolden,
  scenarioNames,
} from './scenario';
export type {
  Action,
  AnswerHookStop,
  AwaitMessage,
  DelayHello,
  DerivedScenario,
  DropConnection,
  EmitEvent,
  Emission,
  ErrorName,
  ErrorReply,
  HandoffState,
  OnContinue,
  OnOpen,
  OnResume,
  OnVerify,
  ReplyAction,
  ResumedFrom,
  Scenario,
  SendAppShutdown,
  SendPing,
} from './scenario';
export { Canon, canonical, canonicalSequence, isObject, readGolden } from './golden';
export type { Direction, GoldenLine, JsonObject } from './golden';
export {
  CHANNEL_SCHEMA_ID,
  GOLDEN_DIR,
  REPO_ROOT,
  channelValidator,
  channelViolation,
} from './validate';

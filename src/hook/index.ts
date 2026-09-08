/**
 * The `hook stop` subcommand: ask the app for a decision, stay neutral on any failure.
 *
 * TECHNICAL-DESIGN §5.11, §9 F-10.
 */

export {
  HOOK_CONNECT_TIMEOUT_MS,
  HOOK_EVENT_NAMES,
  HOOK_HARD_EXIT_MS,
  HOOK_MAX_INPUT_BYTES,
  HOOK_TOTAL_BUDGET_MS,
  hookHelloParams,
  parseHookInput,
  runHookStop,
} from './stop';
export type {
  HookBlockDecision,
  HookEventName,
  HookInput,
  HookInvocation,
  HookStopOptions,
} from './stop';

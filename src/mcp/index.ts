/**
 * MCP tool registration, descriptions, input parsing and outcome rendering.
 *
 * TECHNICAL-DESIGN §5.2. `createServer` registers the three tools with the descriptions,
 * input schemas and annotations generated from `schemas/tool-contract.v1.md`, and
 * `renderOutcome` maps what the pipeline produced onto an MCP tool result.
 */

export * from './generated/contract';
export {
  inferShape,
  parseRunbooksQuery,
  INPUT_FIELDS,
  LANG_PATTERN,
  QUERY_MAX_LENGTH,
  QUERY_MIN_LENGTH,
  REGISTERED_HANDOFF_ID_PATTERNS,
  REPLY_MAX_LENGTH,
  REPLY_MIN_LENGTH,
} from './input';
export type {
  CallShape,
  InputField,
  QueryParse,
  RunbooksQuery,
  ShapeInference,
  ShapeKind,
} from './input';
export {
  hookVariant,
  instructionFor,
  renderError,
  renderOutcome,
  renderRunbooks,
  runbookMatchOutcome,
  OUTCOME_OUTPUT_SCHEMA,
  RUNBOOKS_OUTPUT_SCHEMA,
} from './outcome';
export type {
  Outcome,
  OutcomeContext,
  OutcomeNote,
  OutcomeScreenshot,
  OutcomeStep,
  OutcomeVerify,
  ResumedFrom,
  RunbooksResult,
} from './outcome';
export { NullChannel } from './port';
export type { ChannelPort } from './port';
export { createServer, serve, toolDefinitions, SERVER_NAME } from './server';
export type { ServerDeps } from './server';

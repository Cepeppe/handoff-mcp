/**
 * Schema loading, validation pipeline, semantic rules S1-S6 and error rendering.
 *
 * TECHNICAL-DESIGN §5.4. `validateSpec` is the entry point: the tool (T-017) and
 * `handoff-mcp validate` run the same pure function over the same schema, so a spec that
 * validates offline validates in a session.
 */

export { catalogueError, catalogueFix, errorJson, handoffError, toErrorPayload } from './errors';
export type { ErrorCode, HandoffError, HandoffErrorPayload, Problem } from './errors';
export { childPath, displayPath } from './paths';
export { renderAjvErrors } from './render-errors';
export type { RenderOptions } from './render-errors';
export {
  ALLOWED_URL_SCHEMES,
  ROOT_FIELDS,
  STEP_FIELDS,
  SUPPORTED_SPEC_VERSION,
  URL_PATTERN,
} from './schema';
export {
  controlFieldProblem,
  CONTROL_FIELDS,
  emptyFieldProblem,
  isRecord,
  placeholderProblem,
  semanticProblems,
  stepProblems,
  unknownValueKeyProblem,
  urlSchemeProblem,
  versionCheck,
} from './semantic';
export type { HandoffSpec, HandoffStep, SpecValue } from './types';
export { validateReplacementSteps, validateSpec } from './validate';
export type { SpecValidation, StepsValidation } from './validate';

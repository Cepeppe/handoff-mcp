/**
 * Runbook reader, normaliser, matcher and conversion to a draft spec.
 *
 * TECHNICAL-DESIGN §4.5, §5.10. `RunbookStore` reads the files and `searchRunbooks`
 * answers a query over what it read; the two are separate because the tool and the RUN-07
 * safety net treat an unreadable folder differently and share everything else.
 */

export { convertRunbook, toRunbookMatch } from './convert';
export type { ConvertedRunbook } from './convert';
export { matchRunbooks, RUNBOOK_MATCH_MAX_RESULTS } from './match';
export type { MatchedRunbook, RunbookQuery } from './match';
export {
  MIN_GOAL_TOKEN_LENGTH,
  normalizeWhere,
  stopWords,
  STOP_WORD_LANGUAGES,
  tokens,
} from './normalize';
export { defaultRunbookRoots, RunbookStore, RUNBOOKS_FOLDER_NAME } from './reader';
export type { RunbookRead, RunbookStoreOptions, WarnSink } from './reader';
export { SUPPORTED_RUNBOOK_VERSION } from './schema';
export { searchRunbooks } from './search';
export type {
  AnnotationKind,
  Runbook,
  RunbookAnnotation,
  RunbookMatch,
  RunbookStep,
  RunbookTrust,
  RunbookValue,
  StoredRunbook,
} from './types';

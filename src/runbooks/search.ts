/**
 * Match, then convert: what `handoff_runbooks` answers with (§4.7.3, §5.10).
 *
 * Pure, and deliberately separate from the reader. The tool and the safety net of RUN-07
 * disagree about one thing only — what an unreadable folder means — so they each decide
 * that with the reader's own two functions and then run the identical search.
 */
import { matchRunbooks, type RunbookQuery } from './match';
import { toRunbookMatch } from './convert';
import type { RunbookMatch, StoredRunbook } from './types';

/** The ranked, capped, converted results, in the shape the outcome's `runbooks[]` takes. */
export function searchRunbooks(
  runbooks: readonly StoredRunbook[],
  query: RunbookQuery,
): RunbookMatch[] {
  return matchRunbooks(runbooks, query).map((matched) =>
    toRunbookMatch(matched.stored, matched.matchedWords),
  );
}

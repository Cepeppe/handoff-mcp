/**
 * The matching rule and its ranking (TECHNICAL-DESIGN §4.5.3, RUN-07a).
 *
 * A runbook matches when its `where` normalises to the same string as the query's and the
 * two goals share at least one word beyond stop-words. Nothing else is consulted: not the
 * steps, not the url, not the trust label. The shared words come back as `matched_words` so
 * that the agent — and the person reading the outcome — can see exactly why.
 *
 * Ranking is shared-token count descending, then `last_verified_at` descending. The design
 * stops there, which leaves two runbooks verified in the same instant with the same number
 * of shared words in an order that would depend on the directory listing; `id` ascending
 * closes it, so the server and the app (T-029, T-044) cannot disagree about a tie.
 */
import { normalizeWhere, tokens } from './normalize';
import type { StoredRunbook } from './types';

/** At most this many results, whatever the ranking (§4.1). */
export const RUNBOOK_MATCH_MAX_RESULTS = 5;

/** What the query asks: the same three inputs `handoff_runbooks` takes (§4.7.3). */
export interface RunbookQuery {
  readonly where: string;
  readonly goal: string;
  readonly lang?: string;
}

/** One runbook that matched, with the words that made it match. */
export interface MatchedRunbook {
  readonly stored: StoredRunbook;
  readonly matchedWords: readonly string[];
}

/**
 * `last_verified_at` as an instant, so two timestamps written with different offsets or
 * different fractional precision still compare correctly. The schema has already checked
 * the format with `ajv-formats`; a value that still fails to parse ranks last rather than
 * poisoning the comparison with `NaN`.
 */
function verifiedAt(stored: StoredRunbook): number {
  const instant = Date.parse(stored.runbook.last_verified_at);
  return Number.isNaN(instant) ? Number.NEGATIVE_INFINITY : instant;
}

/**
 * The matching runbooks, ranked and capped.
 *
 * `runbooks` is whatever the reader handed over; this function does no I/O, so the safety
 * net (which never fails on a runbook problem) and the tool (which reports an unreadable
 * folder) can share it after deciding what to do about the folder.
 */
export function matchRunbooks(
  runbooks: readonly StoredRunbook[],
  query: RunbookQuery,
): MatchedRunbook[] {
  const where = normalizeWhere(query.where);
  const goalTokens = tokens(query.goal, query.lang);

  const matched: MatchedRunbook[] = [];
  for (const stored of runbooks) {
    if (normalizeWhere(stored.runbook.where) !== where) continue;
    const theirs = new Set(tokens(stored.runbook.goal, query.lang));
    const matchedWords = goalTokens.filter((word) => theirs.has(word));
    if (matchedWords.length === 0) continue;
    matched.push({ stored, matchedWords });
  }

  matched.sort((a, b) => {
    if (a.matchedWords.length !== b.matchedWords.length) {
      return b.matchedWords.length - a.matchedWords.length;
    }
    // Compared, not subtracted: two unparsable dates are both -Infinity, and their
    // difference would be a NaN the sort cannot use.
    const [mine, theirs] = [verifiedAt(a.stored), verifiedAt(b.stored)];
    if (mine !== theirs) return theirs > mine ? 1 : -1;
    const [left, right] = [a.stored.runbook.id, b.stored.runbook.id];
    // Code-unit order, not `localeCompare`: ids are ASCII and the order must not depend
    // on the machine's locale.
    return left < right ? -1 : left > right ? 1 : 0;
  });

  return matched.slice(0, RUNBOOK_MATCH_MAX_RESULTS);
}

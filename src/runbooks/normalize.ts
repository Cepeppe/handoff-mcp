/**
 * The two normalisations of the matching rule (TECHNICAL-DESIGN §4.5.3, RUN-07a).
 *
 * `normalizeWhere` decides whether two places are the same place; `tokens` decides which
 * words of two goals are shared. Both are pure, deterministic and explainable: no fuzzy
 * similarity, no stemming, no model.
 *
 * The app re-implements this rule in Rust (T-029, T-044), so every character class here is
 * written out rather than taken from a shorthand whose meaning differs between the two
 * engines. That is the whole reason `WHITESPACE` is spelled out instead of being `\s`:
 * JavaScript's `\s` contains U+FEFF and not U+0085, the Rust `regex` crate's contains
 * U+0085 and not U+FEFF, so the shorthand would cut a string differently on the two sides.
 * `\p{L}` and `\p{N}` mean the same thing in both and are used as they are.
 */
import patternFile from '../../patterns/certain-secrets.v1.json';

/**
 * Whitespace, as the union of what JavaScript and Rust each call whitespace, so that the
 * two implementations agree by construction. NFKC has already folded most of the exotic
 * spaces into U+0020 by the time this class is applied; the rest are listed anyway.
 */
const WHITESPACE =
  '\\t\\n\\v\\f\\r\\u0020\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff';

/**
 * The separator characters §4.5.3 lists, in its order: `→ > » / \ | – — - : , ; .`
 *
 * Written with escapes for the four non-ASCII ones so the source cannot be misread, and
 * with the hyphen escaped so it can never be taken for a range.
 */
const SEPARATORS = '\\u2192>\\u00bb\\/\\\\|\\u2013\\u2014\\-:,;.';

/** A run of whitespace or of separators, which collapses to a single space. */
const SEPARATOR_RUN = new RegExp(`[${WHITESPACE}${SEPARATORS}]+`, 'gu');

/** Anything that is neither a letter nor a number, which is where a goal is cut. */
const NON_ALPHANUMERIC = /[^\p{L}\p{N}]+/u;

/** Tokens shorter than this carry no meaning worth matching on (§4.5.3). */
export const MIN_GOAL_TOKEN_LENGTH = 3;

/**
 * The stop-word lists of `patterns/certain-secrets.v1.json`, so that the server and the app
 * drop exactly the same words (§4.5.3). The union is the fallback for a language we do not
 * ship a list for, and is what an absent `lang` gets.
 */
const STOP_WORDS: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  Object.entries(patternFile.stop_words).map(([tag, words]) => [tag, new Set(words)]),
);

const STOP_WORDS_UNION: ReadonlySet<string> = new Set(Object.values(patternFile.stop_words).flat());

/** The languages a list is shipped for, in file order. */
export const STOP_WORD_LANGUAGES: readonly string[] = [...STOP_WORDS.keys()];

/**
 * The primary subtag of a BCP-47 tag, lowercased: `en-GB` and `EN` both select `en`.
 * A tag we ship no list for behaves exactly like an absent one.
 */
function primarySubtag(lang: string | undefined): string | undefined {
  if (lang === undefined) return undefined;
  const tag = lang.split('-')[0]?.toLowerCase();
  return tag === undefined || tag === '' ? undefined : tag;
}

/** The stop-word set for a language: its own list if shipped, else the union of all. */
export function stopWords(lang?: string): ReadonlySet<string> {
  const tag = primarySubtag(lang);
  if (tag === undefined) return STOP_WORDS_UNION;
  return STOP_WORDS.get(tag) ?? STOP_WORDS_UNION;
}

/**
 * `where` reduced to the form two specs must share to be the same place (§4.5.3):
 * NFKC, lowercase, every run of whitespace or of the separator characters to one space,
 * trimmed.
 *
 * "Stripe Dashboard → Developers → Webhooks" and "stripe dashboard / developers / webhooks"
 * both become "stripe dashboard developers webhooks".
 */
export function normalizeWhere(where: string): string {
  return where.normalize('NFKC').toLowerCase().replace(SEPARATOR_RUN, ' ').trim();
}

/**
 * The words of a goal that matching looks at (§4.5.3): NFKC, lowercase, cut on everything
 * that is not a letter or a number, tokens shorter than {@link MIN_GOAL_TOKEN_LENGTH}
 * dropped, stop-words dropped.
 *
 * Returned distinct and in order of first appearance, because the intersection is a set —
 * a word repeated in a goal must not count twice — and because `matched_words` is read by
 * a person, who follows it best in the order they wrote it.
 *
 * A token's length is counted in code points, not in UTF-16 units, so that an emoji or an
 * astral character is one character here and one character in the Rust implementation.
 */
export function tokens(goal: string, lang?: string): string[] {
  const stop = stopWords(lang);
  const found: string[] = [];
  const seen = new Set<string>();
  for (const token of goal.normalize('NFKC').toLowerCase().split(NON_ALPHANUMERIC)) {
    if (token === '' || seen.has(token)) continue;
    // Code points, deliberately, and not grapheme clusters: this is what Rust's
    // `chars().count()` counts, and the two implementations have to drop the same tokens.
    if (Array.from(token).length < MIN_GOAL_TOKEN_LENGTH) continue;
    if (stop.has(token)) continue;
    seen.add(token);
    found.push(token);
  }
  return found;
}

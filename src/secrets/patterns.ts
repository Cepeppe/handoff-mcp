/**
 * Certain-secret detection over the public pattern file (TECHNICAL-DESIGN §4.6, DD-20).
 *
 * The file `patterns/certain-secrets.v1.json` is the contract: the app compiles the same
 * file with the Rust `regex` crate, so nothing here may depend on a JavaScript-only regex
 * feature, and no pattern may be added, removed or rewritten in code. It is bundled into
 * the executable rather than read from disk, because the single-file build has no package
 * directory to read from at run time.
 *
 * The matched text never leaves this module: a match is reported as a family and a span
 * (§5.5, R-19), and nothing else is ever logged or stored.
 */
import patternFile from '../../patterns/certain-secrets.v1.json';

/** The coarse family reported in the outcome's `secret_treated` and kept by the log. */
export type CertainSecretKind =
  'private_key' | 'api_key' | 'token' | 'webhook_secret' | 'webhook_url' | 'jwt';

export const CERTAIN_SECRET_KINDS: readonly CertainSecretKind[] = [
  'private_key',
  'api_key',
  'token',
  'webhook_secret',
  'webhook_url',
  'jwt',
];

/** Version of the pattern file, reported so that a mismatch between sides is visible. */
export const PATTERNS_VERSION: number = patternFile.patterns_version;

/** One match: which family, and where it was found. Never what it was. */
export interface SecretMatch {
  readonly kind: CertainSecretKind;
  readonly start: number;
  readonly end: number;
}

interface CompiledPattern {
  readonly id: string;
  readonly kind: CertainSecretKind;
  readonly regex: RegExp;
}

function isCertainSecretKind(value: string): value is CertainSecretKind {
  return (CERTAIN_SECRET_KINDS as readonly string[]).includes(value);
}

/**
 * Compiled once, at module load, in the order of the file: the pattern list is fixed at
 * build time, and a scan must not pay for compilation.
 *
 * `u` is the flag the patterns are written for; `g` only drives the scan loop and changes
 * no matching semantics.
 */
const COMPILED: readonly CompiledPattern[] = patternFile.patterns.map((entry) => {
  if (!isCertainSecretKind(entry.kind)) {
    throw new Error(`certain-secret pattern ${entry.id} declares an unknown kind`);
  }
  return { id: entry.id, kind: entry.kind, regex: new RegExp(entry.regex, 'gu') };
});

/**
 * Every certain secret in `text`, ordered by position.
 *
 * Patterns are applied in file order and a match overlapping one already found is dropped,
 * so a value is reported once under its most specific family. That is what makes the file
 * order meaningful: `anthropic_api_key` precedes `openai_api_key` because an Anthropic key
 * also satisfies the wider OpenAI shape.
 */
export function scanText(text: string): SecretMatch[] {
  const found: SecretMatch[] = [];
  for (const pattern of COMPILED) {
    const { regex } = pattern;
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      if (match[0].length === 0) {
        // No pattern can match the empty string; the guard keeps the loop finite anyway.
        regex.lastIndex += 1;
        continue;
      }
      const start = match.index;
      const end = start + match[0].length;
      const overlaps = found.some((other) => start < other.end && other.start < end);
      if (!overlaps) {
        found.push({ kind: pattern.kind, start, end });
      }
    }
  }
  found.sort((a, b) => (a.start === b.start ? a.end - b.end : a.start - b.start));
  return found;
}

/**
 * Contract test for the certain-secret pattern file and for the identifier shapes
 * (TECHNICAL-DESIGN §4.1, §4.6).
 *
 * `patterns/certain-secrets.v1.json` is compiled by two engines: JavaScript here and the
 * Rust `regex` crate in the app. This test enforces what a compiler cannot: that the file
 * stays inside the common subset of the two, that every family of §4.6 is present in the
 * documented order, that the two corpora keep recall at 1.0 with zero false positives, and
 * that no identifier this project generates can ever be read as a secret.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  CALL_ID_RE,
  HANDOFF_ID_RE,
  ID_ALPHABET,
  RUNBOOK_ID_RE,
  SESSION_REF_RE,
  newCallId,
  newHandoffId,
  newRequestId,
  newRunbookId,
  newSessionRef,
} from '../../src/ids';
import { CERTAIN_SECRET_KINDS, PATTERNS_VERSION, scanText } from '../../src/secrets';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

interface PatternEntry {
  id: string;
  kind: string;
  regex: string;
  description: string;
  tests: { match: string[]; no_match: string[] };
}

/**
 * The documentation the file carries with it; every note is part of the deliverable. A type
 * alias rather than an interface, so that the notes can also be read as a plain string map.
 */
type PatternNotes = {
  purpose: string;
  policy: string;
  regex_subset: string;
  word_boundaries: string;
  escapes: string;
  order: string;
  kind: string;
  matched_text: string;
  stop_words: string;
  fixtures: string;
  deviation: string;
};

interface PatternFile {
  patterns_version: number;
  _notes: PatternNotes;
  patterns: PatternEntry[];
  stop_words: { en: string[]; it: string[] };
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

const file = readJson(join(ROOT, 'patterns', 'certain-secrets.v1.json')) as PatternFile;

/** Every pattern with its own compiled regex, so a failure names the family that broke. */
const compiled = file.patterns.map((entry) => ({ entry, regex: new RegExp(entry.regex, 'u') }));

/** The families of §4.6, in the order the file must keep. */
const EXPECTED_IDS = [
  'private_key_block',
  'aws_access_key_id',
  'stripe_secret_key',
  'stripe_webhook_secret',
  'github_token',
  'slack_token',
  'slack_webhook_url',
  'google_api_key',
  'anthropic_api_key',
  'openai_api_key',
  'gitlab_pat',
  'npm_token',
  'sendgrid_api_key',
  'huggingface_token',
  'digitalocean_token',
  'jwt',
];

/**
 * Constructs the Rust `regex` crate does not have, or has with other semantics. `\b` is on
 * the list because JavaScript in `u` mode defines it over ASCII word characters and Rust
 * over Unicode ones, so the same pattern would cut differently on the two sides.
 */
const FORBIDDEN_CONSTRUCTS: readonly { probe: RegExp; name: string }[] = [
  { probe: /\(\?=/u, name: 'look-ahead' },
  { probe: /\(\?!/u, name: 'negative look-ahead' },
  { probe: /\(\?</u, name: 'look-behind or named group' },
  { probe: /\(\?>/u, name: 'atomic group' },
  { probe: /\(\?[imsuxU)-]/u, name: 'inline flags' },
  { probe: /\\[1-9]/u, name: 'back-reference' },
  { probe: /[*+?}]\+/u, name: 'possessive quantifier' },
  { probe: /\\[bB]/u, name: 'word boundary' },
];

function corpus(name: string): string {
  return readFileSync(join(ROOT, 'fixtures', 'secrets', name), 'utf8');
}

/** Corpus lines that carry a secret: blank lines and `#` headers are not part of it. */
function positiveLines(): string[] {
  return corpus('positive.txt')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

describe('certain-secret pattern file', () => {
  it('is version 1 and carries the notes that explain the regex subset', () => {
    expect(file.patterns_version).toBe(1);
    expect(PATTERNS_VERSION).toBe(file.patterns_version);
    expect(file._notes.regex_subset).toMatch(/no look-behind/i);
    expect(file._notes.word_boundaries).toMatch(/\\b/);
    expect(file._notes.policy).toMatch(/precision first/i);
    const notes: Record<string, string> = file._notes;
    expect(Object.entries(notes).filter(([, text]) => text.trim() === '')).toEqual([]);
  });

  it('holds every family of the design, in the documented order', () => {
    expect(file.patterns.map((entry) => entry.id)).toEqual(EXPECTED_IDS);
  });

  it('orders anthropic before openai, so the more specific prefix wins', () => {
    const ids = file.patterns.map((entry) => entry.id);
    expect(ids.indexOf('anthropic_api_key')).toBeLessThan(ids.indexOf('openai_api_key'));
  });

  it('gives every pattern a documented kind and both kinds of example', () => {
    for (const entry of file.patterns) {
      expect(CERTAIN_SECRET_KINDS).toContain(entry.kind);
      expect(entry.description.length).toBeGreaterThan(0);
      expect(entry.tests.match.length).toBeGreaterThan(0);
      expect(entry.tests.no_match.length).toBeGreaterThan(0);
    }
  });

  it('compiles every regex with the unicode flag', () => {
    for (const entry of file.patterns) {
      expect(() => new RegExp(entry.regex, 'u')).not.toThrow();
    }
  });

  it('stays inside the subset the Rust regex crate shares with JavaScript', () => {
    for (const entry of file.patterns) {
      const used = FORBIDDEN_CONSTRUCTS.filter(({ probe }) => probe.test(entry.regex)).map(
        ({ name }) => name,
      );
      expect(used, `${entry.id} uses a construct that does not travel`).toEqual([]);
    }
  });
});

describe('embedded examples', () => {
  for (const { entry, regex } of compiled) {
    it(`${entry.id} matches its own examples`, () => {
      for (const sample of entry.tests.match) {
        expect(regex.test(sample), `${entry.id} should match a ${entry.kind}`).toBe(true);
      }
    });

    it(`${entry.id} rejects its own counter-examples`, () => {
      for (const sample of entry.tests.no_match) {
        expect(regex.test(sample), `${entry.id} should not match ${sample}`).toBe(false);
      }
    });
  }
});

describe('secret corpora', () => {
  it('reaches recall 1.0 on the positive corpus', () => {
    const lines = positiveLines();
    expect(lines.length).toBeGreaterThanOrEqual(60);
    const missed = lines.filter((line) => scanText(line).length === 0);
    expect(missed).toEqual([]);
  });

  it('covers every pattern with at least one positive line', () => {
    const lines = positiveLines();
    const uncovered = compiled
      .filter(({ regex }) => !lines.some((line) => regex.test(line)))
      .map(({ entry }) => entry.id);
    expect(uncovered).toEqual([]);
  });

  it('finds nothing in the negative corpus', () => {
    const text = corpus('negative.txt');
    expect(text.split('\n').filter((line) => line !== '').length).toBeGreaterThanOrEqual(200);
    const hits = scanText(text).map((match) => ({
      kind: match.kind,
      excerpt: text.slice(match.start, match.end),
    }));
    expect(hits).toEqual([]);
  });
});

describe('scanText', () => {
  it('reports the family and the span of a secret inside ordinary text', () => {
    const secret = 'AKIAIOSFODNN7EXAMPLE';
    const text = `The access key is ${secret} and it was rotated today.`;
    expect(scanText(text)).toEqual([
      { kind: 'api_key', start: text.indexOf(secret), end: text.indexOf(secret) + secret.length },
    ]);
  });

  it('reports a value once, under the most specific family', () => {
    // The Anthropic key also satisfies the wider OpenAI shape; file order resolves it.
    const matches = scanText('sk-ant-api03-A1b2C3d4E5f6G7h8I9j0KlMnOpQrStUvWxYz');
    expect(matches).toHaveLength(1);
    expect(matches[0]?.start).toBe(0);
  });

  it('returns the matches in reading order', () => {
    const text = 'first hf_QzWxEcRvTyBnUmIoLpAsDfGhJkZxCv3456 then glpat-A1b2C3d4E5f6G7h8I9j0';
    const matches = scanText(text);
    expect(matches.map((match) => match.kind)).toEqual(['token', 'token']);
    expect(matches.map((match) => match.start)).toEqual([
      text.indexOf('hf_'),
      text.indexOf('glpat-'),
    ]);
  });

  it('never returns the matched text', () => {
    const matches = scanText('whsec_KpQ8vN2mR7tYxW4bZ1cD5eF9gH3jL6nM');
    expect(matches).toHaveLength(1);
    expect(Object.keys(matches[0] ?? {}).sort()).toEqual(['end', 'kind', 'start']);
  });

  it('finds nothing in empty or ordinary text', () => {
    expect(scanText('')).toEqual([]);
    expect(scanText('Open the settings page and copy the publishable key.')).toEqual([]);
  });
});

describe('identifiers', () => {
  it('uses the Crockford alphabet without i, l, o and u', () => {
    expect(ID_ALPHABET).toHaveLength(32);
    expect(new Set(ID_ALPHABET).size).toBe(32);
    for (const forbidden of ['i', 'l', 'o', 'u']) {
      expect(ID_ALPHABET).not.toContain(forbidden);
    }
  });

  it('generates each shape as the design writes it', () => {
    expect(newHandoffId()).toMatch(HANDOFF_ID_RE);
    expect(newRequestId()).toMatch(HANDOFF_ID_RE);
    expect(newSessionRef()).toMatch(SESSION_REF_RE);
    expect(newCallId()).toMatch(CALL_ID_RE);
    expect(newRunbookId()).toMatch(RUNBOOK_ID_RE);
  });

  it('never generates an id that a certain pattern would treat as a secret', () => {
    const shapes = [
      { make: newHandoffId, shape: HANDOFF_ID_RE },
      { make: newSessionRef, shape: SESSION_REF_RE },
      { make: newCallId, shape: CALL_ID_RE },
      { make: newRunbookId, shape: RUNBOOK_ID_RE },
    ];
    for (const { make, shape } of shapes) {
      const bad: string[] = [];
      for (let i = 0; i < 10_000; i += 1) {
        const id = make();
        if (!shape.test(id) || scanText(id).length !== 0) {
          bad.push(id);
        }
      }
      expect(bad, 'ids that broke their shape or looked like a secret').toEqual([]);
    }
  });
});

describe('stop words', () => {
  it('ships at least forty lowercase words per language', () => {
    for (const words of [file.stop_words.en, file.stop_words.it]) {
      expect(words.length).toBeGreaterThanOrEqual(40);
      expect(new Set(words).size).toBe(words.length);
      for (const word of words) {
        expect(word).toBe(word.toLowerCase());
        expect(word).toMatch(/^[a-z]+$/u);
      }
    }
  });

  it('contains the excerpt printed in the design', () => {
    for (const word of ['the', 'and', 'for', 'with', 'into', 'from', 'that', 'this']) {
      expect(file.stop_words.en).toContain(word);
    }
    for (const word of [
      'il',
      'lo',
      'la',
      'gli',
      'per',
      'con',
      'del',
      'della',
      'che',
      'una',
      'uno',
    ]) {
      expect(file.stop_words.it).toContain(word);
    }
  });
});

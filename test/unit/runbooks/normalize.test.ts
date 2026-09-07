/**
 * The two normalisations of §4.5.3, at the level the fixtures cannot reach.
 *
 * `fixtures/matching/*.json` pins the rule as a whole, for both implementations; these
 * assert the pieces — the exact separator set, the code-point length, which stop-word list
 * a tag selects — where a single wrong character would still let most fixtures pass.
 */
import { describe, expect, it } from 'vitest';

import patternFile from '../../../patterns/certain-secrets.v1.json';
import {
  MIN_GOAL_TOKEN_LENGTH,
  normalizeWhere,
  stopWords,
  STOP_WORD_LANGUAGES,
  tokens,
} from '../../../src/runbooks';

describe('normalizeWhere', () => {
  it('lowercases, collapses every separator and trims', () => {
    expect(normalizeWhere('Stripe Dashboard → Developers → Webhooks')).toBe(
      'stripe dashboard developers webhooks',
    );
  });

  it.each([
    ['→', 'arrow'],
    ['>', 'chevron'],
    ['»', 'guillemet'],
    ['/', 'slash'],
    ['\\', 'backslash'],
    ['|', 'pipe'],
    ['–', 'en dash'],
    ['—', 'em dash'],
    ['-', 'hyphen'],
    [':', 'colon'],
    [',', 'comma'],
    [';', 'semicolon'],
    ['.', 'full stop'],
  ])('treats %s (%s) as a separator', (separator) => {
    expect(normalizeWhere(`a${separator}b`)).toBe('a b');
  });

  it('leaves characters outside the list alone', () => {
    // `_`, `(`, `)` and `+` are not separators: a place that uses them keeps them.
    expect(normalizeWhere('App_Settings (beta) + more')).toBe('app_settings (beta) + more');
  });

  it('collapses a mixed run of whitespace and separators to a single space', () => {
    expect(normalizeWhere('a  --  ,;  b')).toBe('a b');
  });

  it('normalises NFKC before lowercasing', () => {
    expect(normalizeWhere('Ｓｔｒｉｐｅ　Ｄａｓｈｂｏａｒｄ')).toBe('stripe dashboard');
  });

  it('treats a no-break space and a byte-order mark as whitespace', () => {
    expect(normalizeWhere('﻿a b')).toBe('a b');
  });

  it('is empty when the whole string is separators', () => {
    expect(normalizeWhere(' → / - . ')).toBe('');
  });
});

describe('tokens', () => {
  it('cuts on everything that is not a letter or a number', () => {
    expect(tokens('deploy_the-app/prod (now!)', 'en')).toEqual(['deploy', 'app', 'prod', 'now']);
  });

  it('keeps letters outside ASCII', () => {
    expect(tokens('Configurazione perché', 'it')).toEqual(['configurazione', 'perché']);
  });

  it(`drops tokens shorter than ${String(MIN_GOAL_TOKEN_LENGTH)} code points`, () => {
    expect(tokens('id db key api', 'en')).toEqual(['key', 'api']);
  });

  it('counts a token in code points, not in UTF-16 units', () => {
    // Two astral characters: four UTF-16 units, two characters, so the token is dropped.
    expect('𝟘𝟙'.length).toBe(4);
    expect(tokens('𝟘𝟙', 'en')).toEqual([]);
  });

  it('returns each word once, in order of first appearance', () => {
    expect(tokens('webhook events webhook payment', 'en')).toEqual([
      'webhook',
      'events',
      'payment',
    ]);
  });

  it('drops the stop-words of the language it is given', () => {
    expect(tokens('Update the account with these settings', 'en')).toEqual([
      'update',
      'account',
      'settings',
    ]);
  });
});

describe('stopWords', () => {
  it('ships a list for every language the pattern file declares', () => {
    expect(STOP_WORD_LANGUAGES).toEqual(Object.keys(patternFile.stop_words));
    expect(STOP_WORD_LANGUAGES).toContain('en');
    expect(STOP_WORD_LANGUAGES).toContain('it');
  });

  it('reads the lists out of the shared pattern file, never out of a copy', () => {
    expect([...stopWords('en')].sort()).toEqual([...patternFile.stop_words.en].sort());
    expect([...stopWords('it')].sort()).toEqual([...patternFile.stop_words.it].sort());
  });

  it('selects a list by primary subtag, whatever the case of the tag', () => {
    expect(stopWords('en-GB')).toBe(stopWords('en'));
    expect(stopWords('IT')).toBe(stopWords('it'));
  });

  it('falls back to the union of every list when the language is absent or unshipped', () => {
    const union = stopWords();
    expect(stopWords('fr')).toBe(union);
    expect(union.has('the')).toBe(true);
    expect(union.has('che')).toBe(true);
    expect(union.size).toBeGreaterThan(stopWords('en').size);
  });
});

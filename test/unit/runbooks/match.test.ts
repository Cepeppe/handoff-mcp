/**
 * The matching rule, at the level `fixtures/matching/*.json` does not reach.
 *
 * The fixtures are the cross-implementation contract; these assert the constant, the shape
 * the search hands on, and that the rule never looks at anything but `where` and `goal`.
 */
import { describe, expect, it } from 'vitest';

import {
  matchRunbooks,
  RUNBOOK_MATCH_MAX_RESULTS,
  searchRunbooks,
  type Runbook,
  type StoredRunbook,
} from '../../../src/runbooks';

/** A runbook reduced to what the rule reads; everything else is filler the rule ignores. */
function stored(id: string, where: string, goal: string, lastVerifiedAt: string): StoredRunbook {
  const runbook: Runbook = {
    runbook_version: 1,
    id,
    where,
    goal,
    why_human: 'A person has to do this.',
    url: null,
    lang: null,
    values: {},
    secrets: {},
    steps: [{ text: 'Do the thing.', url: null, values: [], warning: null, annotations: [] }],
    verify: null,
    trust: 'verified',
    last_verified_at: lastVerifiedAt,
    last_run_failed_at: null,
    runs: 1,
    created_at: lastVerifiedAt,
    updated_at: lastVerifiedAt,
    origin: { app: 'handoff-app', app_version: '1.0.0' },
  };
  return { path: `/runbooks/${id}.json`, runbook };
}

const WHERE = 'Stripe Dashboard → Developers → Webhooks';
const GOAL = 'Register the Stripe webhook for payment events';

describe('matchRunbooks', () => {
  it('caps the result at RUNBOOK_MATCH_MAX_RESULTS, which is 5 (§4.1)', () => {
    expect(RUNBOOK_MATCH_MAX_RESULTS).toBe(5);
    const many = Array.from({ length: 20 }, (_unused, index) =>
      stored(`rb_a0000000${String(index).padStart(2, '0')}`, WHERE, GOAL, '2026-09-07T10:00:00Z'),
    );
    expect(matchRunbooks(many, { where: WHERE, goal: GOAL })).toHaveLength(
      RUNBOOK_MATCH_MAX_RESULTS,
    );
  });

  it('is an empty list when there is nothing to search', () => {
    expect(matchRunbooks([], { where: WHERE, goal: GOAL })).toEqual([]);
  });

  it('does not care about trust, runs, or a run that failed', () => {
    const one = stored('rb_a000000001', WHERE, GOAL, '2026-09-07T10:00:00Z');
    const flaky: StoredRunbook = {
      path: one.path,
      runbook: {
        ...one.runbook,
        trust: 'confirmed_by_user',
        runs: 9,
        last_run_failed_at: '2026-09-07T11:00:00Z',
      },
    };
    expect(matchRunbooks([flaky], { where: WHERE, goal: GOAL })).toHaveLength(1);
  });

  it('ranks an unparsable last_verified_at last instead of scrambling the order', () => {
    const good = stored('rb_b000000002', WHERE, GOAL, '2020-01-01T00:00:00Z');
    const broken = stored('rb_a000000001', WHERE, GOAL, 'not a date at all');
    expect(
      matchRunbooks([broken, good], { where: WHERE, goal: GOAL }).map(
        (one) => one.stored.runbook.id,
      ),
    ).toEqual(['rb_b000000002', 'rb_a000000001']);
  });
});

describe('searchRunbooks', () => {
  it('returns the matches already converted, in ranking order', () => {
    const items = searchRunbooks(
      [
        stored('rb_a000000001', WHERE, 'Update the webhook', '2026-09-07T10:00:00Z'),
        stored('rb_b000000002', WHERE, GOAL, '2026-09-07T10:00:00Z'),
      ],
      { where: WHERE, goal: GOAL, lang: 'en' },
    );

    expect(items.map((one) => one.id)).toEqual(['rb_b000000002', 'rb_a000000001']);
    expect(items[0]?.matched_words).toEqual(['register', 'stripe', 'webhook', 'payment', 'events']);
    expect(items[0]?.draft_spec.goal).toBe(GOAL);
    expect(items[0]?.path).toBe('/runbooks/rb_b000000002.json');
  });
});

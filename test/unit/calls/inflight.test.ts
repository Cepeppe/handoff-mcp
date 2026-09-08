/**
 * The in-flight table (TECHNICAL-DESIGN §5.7).
 *
 * Two invariants and nothing else, because that is all the table is: a call is found by the
 * id an event names, and a handoff has at most one waiting call in this server. The second
 * one is the interesting half — `attach` hands back what it displaced, and everything the
 * caller does about that (a `transferred_to_other_session` for the older call) depends on
 * getting that object rather than losing it.
 */
import { describe, expect, it } from 'vitest';

import { InFlightTable, type InFlightCall } from '../../../src/calls';

type Marker = string;

function call(
  callId: string,
  handoffId: string,
  resolve: (value: Marker) => void = () => undefined,
): InFlightCall<Marker> {
  return { call_id: callId, handoff_id: handoffId, started_at: 0, deadline: 1_000, resolve };
}

describe('InFlightTable', () => {
  it('finds a call by its id and by the handoff it waits on', () => {
    const table = new InFlightTable<Marker>();
    table.attach(call('call_aaaaaaaa', 'hf_7k3m9p2q4r'));

    expect(table.size).toBe(1);
    expect(table.get('call_aaaaaaaa')?.handoff_id).toBe('hf_7k3m9p2q4r');
    expect(table.forHandoff('hf_7k3m9p2q4r')?.call_id).toBe('call_aaaaaaaa');
    expect(table.get('call_bbbbbbbb')).toBeUndefined();
    expect(table.forHandoff('hf_0000000000')).toBeUndefined();
  });

  it('keeps one waiting call per handoff and returns the one it displaced', () => {
    const table = new InFlightTable<Marker>();
    const first = call('call_aaaaaaaa', 'hf_7k3m9p2q4r');
    const second = call('call_bbbbbbbb', 'hf_7k3m9p2q4r');

    expect(table.attach(first)).toBeUndefined();
    expect(table.attach(second)).toBe(first);
    expect(table.size).toBe(1);
    expect(table.get('call_aaaaaaaa')).toBeUndefined();
    expect(table.forHandoff('hf_7k3m9p2q4r')?.call_id).toBe('call_bbbbbbbb');
  });

  it('leaves the calls of other handoffs alone', () => {
    const table = new InFlightTable<Marker>();
    table.attach(call('call_aaaaaaaa', 'hf_7k3m9p2q4r'));
    expect(table.attach(call('call_bbbbbbbb', 'hf_9p2r4k7m3t'))).toBeUndefined();
    expect(table.size).toBe(2);
    expect(table.waiting().map((entry) => entry.call_id)).toEqual([
      'call_aaaaaaaa',
      'call_bbbbbbbb',
    ]);
  });

  it('forgets a call and frees the handoff for the next one', () => {
    const table = new InFlightTable<Marker>();
    const only = call('call_aaaaaaaa', 'hf_7k3m9p2q4r');
    table.attach(only);

    expect(table.detach('call_aaaaaaaa')).toBe(only);
    expect(table.detach('call_aaaaaaaa')).toBeUndefined();
    expect(table.size).toBe(0);
    expect(table.forHandoff('hf_7k3m9p2q4r')).toBeUndefined();
    expect(table.attach(call('call_bbbbbbbb', 'hf_7k3m9p2q4r'))).toBeUndefined();
  });

  /**
   * A displaced call keeps its own entry nowhere, but the handoff index must not be cleared
   * by the *late* detach of that displaced call: the newer call is the one waiting, and
   * losing the index would let a third call attach without displacing it.
   */
  it('does not let a displaced call clear the index of the one that replaced it', () => {
    const table = new InFlightTable<Marker>();
    table.attach(call('call_aaaaaaaa', 'hf_7k3m9p2q4r'));
    table.attach(call('call_bbbbbbbb', 'hf_7k3m9p2q4r'));

    expect(table.detach('call_aaaaaaaa')).toBeUndefined();
    expect(table.forHandoff('hf_7k3m9p2q4r')?.call_id).toBe('call_bbbbbbbb');
  });

  /**
   * An open is registered before it has a handoff, because the outcome can arrive in the
   * same read as the answer that names it. Until `bind` it is findable by its call id — which
   * is what an event addresses — and by nothing else.
   */
  describe('a call registered before it has a handoff', () => {
    it('is found by its call id and takes no handoff slot', () => {
      const table = new InFlightTable<Marker>();
      expect(table.attach(call('call_aaaaaaaa', ''))).toBeUndefined();

      expect(table.get('call_aaaaaaaa')?.handoff_id).toBe('');
      expect(table.forHandoff('')).toBeUndefined();
      // A second unnamed call does not displace the first: they are not the same handoff.
      expect(table.attach(call('call_bbbbbbbb', ''))).toBeUndefined();
      expect(table.size).toBe(2);
    });

    it('takes the slot when bind names it, displacing whoever held it', () => {
      const table = new InFlightTable<Marker>();
      const held = call('call_aaaaaaaa', 'hf_7k3m9p2q4r');
      table.attach(held);
      table.attach(call('call_bbbbbbbb', ''));

      expect(table.bind('call_bbbbbbbb', 'hf_7k3m9p2q4r')).toBe(held);
      expect(table.forHandoff('hf_7k3m9p2q4r')?.call_id).toBe('call_bbbbbbbb');
      expect(table.get('call_bbbbbbbb')?.handoff_id).toBe('hf_7k3m9p2q4r');
      expect(table.size).toBe(1);
    });

    it('is not resurrected by a bind that arrives after it has returned', () => {
      const table = new InFlightTable<Marker>();
      table.attach(call('call_aaaaaaaa', ''));
      table.detach('call_aaaaaaaa');

      expect(table.bind('call_aaaaaaaa', 'hf_7k3m9p2q4r')).toBeUndefined();
      expect(table.size).toBe(0);
      expect(table.forHandoff('hf_7k3m9p2q4r')).toBeUndefined();
    });

    it('does not displace itself when bound twice', () => {
      const table = new InFlightTable<Marker>();
      table.attach(call('call_aaaaaaaa', ''));

      expect(table.bind('call_aaaaaaaa', 'hf_7k3m9p2q4r')).toBeUndefined();
      expect(table.bind('call_aaaaaaaa', 'hf_7k3m9p2q4r')).toBeUndefined();
      expect(table.size).toBe(1);
    });
  });
});

/**
 * The stderr logger and its field guard (TECHNICAL-DESIGN §5.12, R-19).
 *
 * The important half of this file is not the formatting: it is the two assertions that a
 * spec value cannot become a log field. One is checked by `pnpm typecheck` through the
 * `@ts-expect-error` lines — remove a name from the allow-list type and they stop being
 * errors, which fails the build — and the other at run time, for the fields that reach the
 * logger through a cast or a parsed object, where the type says nothing.
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LOG_LEVEL,
  LOG_LEVELS,
  createLogger,
  isAllowedLogField,
  type LogFields,
} from '../../src/log';

/** Collects the records instead of writing them, which is also how the server injects it. */
function recorder() {
  const lines: string[] = [];
  return { lines, sink: (line: string) => lines.push(line) };
}

describe('levels', () => {
  it('are the two of §5.12, error by default', () => {
    expect(LOG_LEVELS).toEqual(['error', 'debug']);
    expect(DEFAULT_LOG_LEVEL).toBe('error');
  });

  it('drop debug records at the error level', () => {
    const { lines, sink } = recorder();
    const log = createLogger('error', sink);
    log.debug('channel_connect_attempt', { attempt: 3 });
    log.error('channel_connect_failed', { attempt: 3 });
    expect(lines).toEqual(['handoff-mcp error channel_connect_failed attempt=3']);
  });

  it('keep both at the debug level', () => {
    const { lines, sink } = recorder();
    const log = createLogger('debug', sink);
    log.debug('a');
    log.error('b');
    expect(lines).toEqual(['handoff-mcp debug a', 'handoff-mcp error b']);
    expect(log.level).toBe('debug');
  });
});

describe('the record', () => {
  it('is one line, event first, fields in the order they were given', () => {
    const { lines, sink } = recorder();
    createLogger('debug', sink).debug('handoff_open', {
      handoff_id: 'hf_4m7q2t9xab',
      steps_count: 3,
      elapsed_ms: 42,
      ok: true,
    });
    expect(lines).toEqual([
      'handoff-mcp debug handoff_open handoff_id=hf_4m7q2t9xab steps_count=3 elapsed_ms=42 ok=true',
    ]);
  });

  it('quotes a value that would not survive a whitespace split', () => {
    const { lines, sink } = recorder();
    createLogger('debug', sink).debug('e', { reason: 'app disconnected' });
    expect(lines).toEqual(['handoff-mcp debug e reason="app disconnected"']);
  });

  it('skips a field that was not set', () => {
    const { lines, sink } = recorder();
    createLogger('debug', sink).debug('e', { code: 'SPEC_INVALID', reason: undefined });
    expect(lines).toEqual(['handoff-mcp debug e code=SPEC_INVALID']);
  });

  it('still emits the event when every field was dropped', () => {
    const { lines, sink } = recorder();
    createLogger('debug', sink).debug('e', { goal: 'x' } as unknown as LogFields);
    expect(lines).toEqual(['handoff-mcp debug e']);
  });
});

describe('the field guard', () => {
  const forbidden = [
    'spec',
    'values',
    'text',
    'goal',
    'where',
    'why_human',
    'secrets',
    'answer',
    'note',
    'url',
    'warning',
    'token',
    'verify',
    'steps',
  ];

  it('refuses every field that could carry a spec value or a text', () => {
    for (const name of forbidden) {
      expect(isAllowedLogField(name), name).toBe(false);
    }
  });

  it('allows ids, codes, sizes and timings', () => {
    for (const name of [
      'handoff_id',
      'call_id',
      'session_ref',
      'agent_id',
      'code',
      'reason',
      'state',
      'elapsed_ms',
      'heartbeat_after_ms',
      'steps_count',
      'image_bytes',
      'protocol_version',
      'started_at',
    ]) {
      expect(isAllowedLogField(name), name).toBe(true);
    }
  });

  it('does not take a bare suffix for a field name', () => {
    for (const name of ['_id', '_ms', '_count', '_bytes', '_ref', '_at', '_version']) {
      expect(isAllowedLogField(name), name).toBe(false);
    }
  });

  it('drops a forbidden field at run time, value and all', () => {
    const { lines, sink } = recorder();
    createLogger('debug', sink).debug('spec_rejected', {
      handoff_id: 'hf_4m7q2t9xab',
      goal: 'rotate the Stripe key',
      values: 'sk_live_0123456789abcdef',
    } as unknown as LogFields);
    expect(lines).toEqual(['handoff-mcp debug spec_rejected handoff_id=hf_4m7q2t9xab']);
    expect(lines.join('\n')).not.toContain('sk_live');
    expect(lines.join('\n')).not.toContain('Stripe');
  });

  it('drops an object or an array even under an allowed name', () => {
    const { lines, sink } = recorder();
    createLogger('debug', sink).debug('e', {
      code: 'SPEC_INVALID',
      problems_count: [{ path: 'goal' }],
      steps_ref: { text: 'open the dashboard' },
    } as unknown as LogFields);
    expect(lines).toEqual(['handoff-mcp debug e code=SPEC_INVALID']);
  });

  it('rejects a spec field at compile time', () => {
    const { lines, sink } = recorder();
    const log = createLogger('debug', sink);
    // @ts-expect-error a spec never becomes a log field (R-19)
    log.debug('e', { spec: 'anything' });
    // @ts-expect-error nor do the values of a spec
    log.debug('e', { values: 'anything' });
    // @ts-expect-error nor any free text
    log.debug('e', { text: 'anything' });
    // @ts-expect-error nor the channel token
    log.debug('e', { token: 'anything' });
    // @ts-expect-error and a field must hold a scalar, not a structure
    log.debug('e', { handoff_id: { id: 'hf_4m7q2t9xab' } });
    expect(lines).toEqual([
      'handoff-mcp debug e',
      'handoff-mcp debug e',
      'handoff-mcp debug e',
      'handoff-mcp debug e',
      'handoff-mcp debug e',
    ]);
  });
});

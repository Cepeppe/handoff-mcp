/**
 * Framing and JSON-RPC classification (TECHNICAL-DESIGN §6.1, §6.3).
 *
 * The golden sequences of `fixtures/channel/` are the real traffic of the protocol, so they
 * are the round-trip corpus: every line of every flow is encoded, split into chunks at every
 * byte boundary and decoded again, and must come back the same object. What that catches is
 * the whole class of framing defects — a chunk cut inside a multi-byte character, a line
 * held across two reads, a trailing fragment kept for the next chunk — which a test written
 * around one hand-made message does not.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  CHANNEL_MAX_MESSAGE_BYTES,
  NdjsonDecoder,
  classify,
  encodeMessage,
  frameBytes,
  isFailure,
  isNotification,
  isRequest,
  isSuccess,
  notification,
  request,
  success,
  type JsonRpcMessage,
} from '../../../src/channel';

const FIXTURES = fileURLToPath(new URL('../../../fixtures/channel/', import.meta.url));
const FILES = readdirSync(FIXTURES).filter((name) => name.endsWith('.jsonl'));

/** Every `msg` of every golden sequence, in file order. */
function goldenMessages(file: string): JsonRpcMessage[] {
  return readFileSync(join(FIXTURES, file), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => (JSON.parse(line) as { msg: JsonRpcMessage }).msg);
}

function decodeAll(chunks: readonly (Buffer | string)[]): JsonRpcMessage[] {
  const decoder = new NdjsonDecoder();
  const messages: JsonRpcMessage[] = [];
  for (const chunk of chunks) {
    const outcome = decoder.push(chunk);
    if (!outcome.ok) throw new Error(`unexpected violation: ${outcome.violation}`);
    messages.push(...outcome.messages);
  }
  return messages;
}

describe('the golden sequences', () => {
  it('cover every file of fixtures/channel', () => {
    expect(FILES).toHaveLength(11);
  });

  it.each(FILES)('round-trip through the codec: %s', (file) => {
    const golden = goldenMessages(file);
    expect(golden.length).toBeGreaterThan(0);
    const wire = golden.map((message) => encodeMessage(message)).join('');
    expect(decodeAll([wire])).toEqual(golden);
  });

  it.each(FILES)('survive being cut at every byte boundary: %s', (file) => {
    const golden = goldenMessages(file);
    const wire = Buffer.from(golden.map((message) => encodeMessage(message)).join(''), 'utf8');
    const chunks: Buffer[] = [];
    for (let index = 0; index < wire.length; index += 1) {
      chunks.push(wire.subarray(index, index + 1));
    }
    expect(decodeAll(chunks)).toEqual(golden);
  });
});

describe('framing', () => {
  it('ends every message with exactly one newline', () => {
    const line = encodeMessage(request(1, 'ping', {}));
    expect(line).toBe('{"jsonrpc":"2.0","id":1,"method":"ping","params":{}}\n');
  });

  it('holds an unfinished line until its newline arrives', () => {
    const decoder = new NdjsonDecoder();
    const [head, tail] = ['{"jsonrpc":"2.0","method":"session.bye","par', 'ams":{}}\n'];
    expect(decoder.push(head)).toEqual({ ok: true, messages: [] });
    expect(decoder.pending).toBeGreaterThan(0);
    expect(decoder.push(tail)).toEqual({
      ok: true,
      messages: [notification('session.bye', {})],
    });
    expect(decoder.pending).toBe(0);
  });

  it('keeps a multi-byte character whole across a chunk boundary', () => {
    const message = notification('app.shutdown', { reason: 'l’app è chiusa — à più tard' });
    const wire = Buffer.from(encodeMessage(message), 'utf8');
    for (let cut = 1; cut < wire.length; cut += 1) {
      expect(decodeAll([wire.subarray(0, cut), wire.subarray(cut)])).toEqual([message]);
    }
  });

  it('ignores blank lines', () => {
    expect(decodeAll(['\n\n', `${encodeMessage(request(1, 'ping', {}))}\n`])).toEqual([
      request(1, 'ping', {}),
    ]);
  });

  it('closes on a line longer than the cap, before the line even ends', () => {
    const decoder = new NdjsonDecoder(64);
    expect(decoder.push('x'.repeat(65))).toEqual({ ok: false, violation: 'message_too_large' });
    expect(decoder.pending).toBe(0);
  });

  it('closes on a complete line longer than the cap', () => {
    const decoder = new NdjsonDecoder(64);
    expect(decoder.push(`${'x'.repeat(65)}\n`)).toEqual({
      ok: false,
      violation: 'message_too_large',
    });
  });

  it('measures the cap in bytes, at the 16 MiB of §6.1', () => {
    expect(CHANNEL_MAX_MESSAGE_BYTES).toBe(16 * 1024 * 1024);
    expect(frameBytes('é')).toBe(2);
  });

  it('closes on a line that is not JSON', () => {
    expect(new NdjsonDecoder().push('{ not json }\n')).toEqual({
      ok: false,
      violation: 'invalid_json',
    });
  });

  it('closes on JSON that is not a JSON-RPC message', () => {
    for (const line of ['[1,2]', '"hello"', '{}', '{"jsonrpc":"1.0","method":"ping"}', 'null']) {
      expect(new NdjsonDecoder().push(`${line}\n`), line).toEqual({
        ok: false,
        violation: 'not_jsonrpc',
      });
    }
  });
});

describe('classification', () => {
  it('tells the four envelopes apart', () => {
    const asked = request(1, 'hello', {});
    const told = notification('session.bye', {});
    const answered = success(1, {});
    const refused = classify({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32001, message: 'auth_failed' },
    });

    expect(isRequest(asked)).toBe(true);
    expect(isNotification(told)).toBe(true);
    expect(isSuccess(answered)).toBe(true);
    expect(refused).toBeDefined();
    expect(refused !== undefined && isFailure(refused)).toBe(true);
  });

  it('tolerates unknown fields in a result, as §6.3 requires of the server', () => {
    const decoded = classify({
      jsonrpc: '2.0',
      id: 4,
      result: { handoff_id: 'hf_7k3m9p2q4r', resumed_from: null, invented_by_a_newer_app: 42 },
    });
    expect(decoded).toEqual({
      jsonrpc: '2.0',
      id: 4,
      result: { handoff_id: 'hf_7k3m9p2q4r', resumed_from: null, invented_by_a_newer_app: 42 },
    });
  });

  it('carries the data of an error, which is where the app states its version', () => {
    expect(
      classify({
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32002, message: 'protocol_unsupported', data: { protocol_version: 1 } },
      }),
    ).toEqual({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32002, message: 'protocol_unsupported', data: { protocol_version: 1 } },
    });
  });

  it('treats a missing params as the empty object every method declares', () => {
    expect(classify({ jsonrpc: '2.0', method: 'session.bye' })).toEqual(
      notification('session.bye', {}),
    );
  });

  it('refuses a response whose result is not an object, and an error without a code', () => {
    expect(classify({ jsonrpc: '2.0', id: 1, result: true })).toBeUndefined();
    expect(classify({ jsonrpc: '2.0', id: 1, error: { message: 'auth_failed' } })).toBeUndefined();
    expect(classify({ jsonrpc: '2.0', id: null, result: {} })).toBeUndefined();
  });
});

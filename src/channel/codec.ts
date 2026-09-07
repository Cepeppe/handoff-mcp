/**
 * Framing and JSON-RPC shapes for the channel (TECHNICAL-DESIGN §6.1, §6.3, §6.6).
 *
 * One JSON-RPC 2.0 object per line, UTF-8, newline-delimited, at most
 * `CHANNEL_MAX_MESSAGE_BYTES`. Three properties of this module are worth stating, because
 * each one is a bug the design already anticipated:
 *
 * - **Bytes, not characters.** A chunk boundary can fall inside a multi-byte character, so
 *   the decoder accumulates `Buffer`s and splits on the newline **byte**; decoding to a
 *   string per chunk would corrupt any line carrying an accented letter at the wrong
 *   offset. The size cap is measured in bytes for the same reason.
 * - **The cap is checked before the line ends.** A peer that never sends a newline must not
 *   be able to grow the buffer for ever, so the overflow is reported as soon as what is
 *   held exceeds the cap, not when the line finally arrives.
 * - **A result may carry fields we do not know.** §6.3 makes the server deliberately more
 *   tolerant than the schema, so classification looks at the envelope only and hands the
 *   payload on as it came.
 *
 * A framing violation is not answered with a JSON-RPC error: the connection closes
 * (`protocol/channel/README.md`), which is what the caller does with the outcome below.
 */
import { CHANNEL_MAX_MESSAGE_BYTES } from './protocol';

export type JsonRpcId = number | string;

/** The `params` and `result` of every method of §6.3 are objects. */
export type JsonRpcParams = Readonly<Record<string, unknown>>;

export interface JsonRpcRequest {
  readonly jsonrpc: '2.0';
  readonly id: JsonRpcId;
  readonly method: string;
  readonly params: JsonRpcParams;
}

export interface JsonRpcNotification {
  readonly jsonrpc: '2.0';
  readonly method: string;
  readonly params: JsonRpcParams;
}

export interface JsonRpcSuccess {
  readonly jsonrpc: '2.0';
  readonly id: JsonRpcId;
  readonly result: JsonRpcParams;
}

export interface JsonRpcErrorObject {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export interface JsonRpcFailure {
  readonly jsonrpc: '2.0';
  readonly id: JsonRpcId;
  readonly error: JsonRpcErrorObject;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcSuccess | JsonRpcFailure;

export function isRequest(message: JsonRpcMessage): message is JsonRpcRequest {
  return 'method' in message && 'id' in message;
}

export function isNotification(message: JsonRpcMessage): message is JsonRpcNotification {
  return 'method' in message && !('id' in message);
}

export function isSuccess(message: JsonRpcMessage): message is JsonRpcSuccess {
  return 'result' in message;
}

export function isFailure(message: JsonRpcMessage): message is JsonRpcFailure {
  return 'error' in message;
}

export function request(id: JsonRpcId, method: string, params: JsonRpcParams): JsonRpcRequest {
  return { jsonrpc: '2.0', id, method, params };
}

export function notification(method: string, params: JsonRpcParams): JsonRpcNotification {
  return { jsonrpc: '2.0', method, params };
}

export function success(id: JsonRpcId, result: JsonRpcParams): JsonRpcSuccess {
  return { jsonrpc: '2.0', id, result };
}

/** One message as it goes on the wire: compact JSON and the newline that ends the frame. */
export function encodeMessage(message: JsonRpcMessage): string {
  return `${JSON.stringify(message)}\n`;
}

/** The size the cap of §6.1 is measured against: the frame without its newline. */
export function frameBytes(line: string): number {
  return Buffer.byteLength(line, 'utf8');
}

/** Why a line could not be accepted. Each one closes the connection (§6.3). */
export type FramingViolation = 'message_too_large' | 'invalid_json' | 'not_jsonrpc';

export type DecodeOutcome =
  | { readonly ok: true; readonly messages: readonly JsonRpcMessage[] }
  | { readonly ok: false; readonly violation: FramingViolation };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readId(value: Record<string, unknown>): JsonRpcId | undefined {
  const id = value['id'];
  if (typeof id === 'number' || typeof id === 'string') return id;
  return undefined;
}

function readError(value: unknown): JsonRpcErrorObject | undefined {
  if (!isObject(value)) return undefined;
  const code = value['code'];
  const message = value['message'];
  if (typeof code !== 'number' || typeof message !== 'string') return undefined;
  return 'data' in value ? { code, message, data: value['data'] } : { code, message };
}

/**
 * Recognises one of the four envelopes of JSON-RPC 2.0, or nothing.
 *
 * `params` defaults to `{}` when it is absent: the schema requires it on every method, so
 * an absent one is a peer being sloppy rather than a different message, and the alternative
 * — closing the connection — would cost the user their overlay over a formality.
 */
export function classify(value: unknown): JsonRpcMessage | undefined {
  if (!isObject(value) || value['jsonrpc'] !== '2.0') return undefined;

  const method = value['method'];
  if (typeof method === 'string') {
    const raw = value['params'];
    const params: JsonRpcParams = isObject(raw) ? raw : {};
    const id = readId(value);
    return id === undefined ? notification(method, params) : request(id, method, params);
  }

  const id = readId(value);
  if (id === undefined) return undefined;

  if ('result' in value) {
    const result = value['result'];
    return isObject(result) ? success(id, result) : undefined;
  }

  const error = readError(value['error']);
  return error === undefined ? undefined : { jsonrpc: '2.0', id, error };
}

const NEWLINE = 0x0a;

/**
 * Turns a stream of bytes into messages. One decoder per connection: the buffer holds the
 * tail of an unfinished line, so a decoder that outlives its socket would splice two
 * connections' bytes together.
 */
export class NdjsonDecoder {
  private buffer: Buffer = Buffer.alloc(0);
  private readonly maxBytes: number;

  constructor(maxBytes: number = CHANNEL_MAX_MESSAGE_BYTES) {
    this.maxBytes = maxBytes;
  }

  /** Bytes held for a line that has not ended yet. Zero between messages. */
  get pending(): number {
    return this.buffer.length;
  }

  push(chunk: Buffer | string): DecodeOutcome {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    this.buffer = this.buffer.length === 0 ? bytes : Buffer.concat([this.buffer, bytes]);

    const messages: JsonRpcMessage[] = [];
    let start = 0;

    for (;;) {
      const end = this.buffer.indexOf(NEWLINE, start);
      if (end === -1) break;
      if (end - start > this.maxBytes) return this.overflow();

      const line = this.buffer.toString('utf8', start, end).trim();
      start = end + 1;
      if (line === '') continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        this.buffer = Buffer.alloc(0);
        return { ok: false, violation: 'invalid_json' };
      }

      const message = classify(parsed);
      if (message === undefined) {
        this.buffer = Buffer.alloc(0);
        return { ok: false, violation: 'not_jsonrpc' };
      }
      messages.push(message);
    }

    this.buffer = start === 0 ? this.buffer : this.buffer.subarray(start);
    if (this.buffer.length > this.maxBytes) return this.overflow();
    return { ok: true, messages };
  }

  private overflow(): DecodeOutcome {
    this.buffer = Buffer.alloc(0);
    return { ok: false, violation: 'message_too_large' };
  }
}

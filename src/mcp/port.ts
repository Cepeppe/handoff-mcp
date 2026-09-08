/**
 * The server's view of the channel to the app (TECHNICAL-DESIGN §5.2 step 4, §5.8, §6).
 *
 * T-017 needed one fact about the channel — whether the app is reachable right now — and
 * this interface carried nothing else, because nothing else could be answered without a
 * client. The client exists now, so the port is what T-017 said it would become: the small
 * surface the tool pipeline and the in-flight table use, and no more.
 *
 * It is deliberately a **structural subset of `ChannelClient`** (`src/channel/client.ts`),
 * so `serve` hands the real client over where `NullChannel` used to go, with no adapter and
 * no import of `src/mcp` from `src/channel`. The types it borrows are type-only: nothing of
 * the channel is in this module's runtime graph, and `NullChannel` stays a five-line object
 * that keeps every call on the degraded path of §5.2 step 4 for the tests that want it.
 */
import type { ChannelEvents, ChannelFailure, ChannelListener, JsonRpcParams } from '../channel';

export type { ChannelEvents, ChannelFailure, ChannelListener, JsonRpcParams };

export interface ChannelPort {
  /** Whether the channel to the app is registered and usable right now (§5.3). */
  isConnected(): boolean;
  /**
   * Why registration is not happening, in the vocabulary of the error catalogue (§4.7.5):
   * `CHANNEL_AUTH_FAILED` or `PROTOCOL_MISMATCH`, which is what turns a plain "the app is
   * not there" into the fix text of FM-10 and FM-11.
   */
  readonly failure: ChannelFailure | undefined;
  /**
   * One non-blocking request, with the 10 s budget of §6.6. Rejects with `ChannelError`
   * when the app is unreachable and with `ChannelResponseError` when the app answers an
   * error of §6.3.
   */
  request(method: string, params?: JsonRpcParams): Promise<JsonRpcParams>;
  /** One notification. `false` when the channel is down and nothing was sent. */
  notify(method: string, params?: JsonRpcParams): boolean;
  /** Subscribes; the returned function unsubscribes. */
  on<K extends keyof ChannelEvents>(event: K, listener: ChannelListener<K>): () => void;
}

/**
 * The channel that is never there. Every call takes the degraded path of §5.2 step 4: an
 * open is text mode, a continue, a resume or a verify is `APP_DISCONNECTED`. It is what
 * `createServer` is given when a test wants the text-mode server of T-017 in full.
 */
export const NullChannel: ChannelPort = {
  isConnected: () => false,
  failure: undefined,
  request: (method) => Promise.reject(new Error(`there is no channel, so ${method} was not sent`)),
  notify: () => false,
  on: () => () => undefined,
};

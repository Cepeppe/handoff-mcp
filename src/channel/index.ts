/**
 * Channel client: framing, hello and authentication, reconnection with backoff.
 *
 * TECHNICAL-DESIGN §5.8, §6.
 */

export { ChannelClient, ChannelError, ChannelResponseError, SESSION_BYE_FLUSH_MS } from './client';
export type {
  ChannelClientOptions,
  ChannelConnect,
  ChannelErrorKind,
  ChannelEvents,
  ChannelListener,
} from './client';
export {
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
} from './codec';
export type {
  DecodeOutcome,
  FramingViolation,
  JsonRpcErrorObject,
  JsonRpcFailure,
  JsonRpcId,
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcParams,
  JsonRpcRequest,
  JsonRpcSuccess,
} from './codec';
export {
  APP_TO_SERVER_METHODS,
  AUTH_FAILED_CODE,
  BACKOFF_SCHEDULE_MS,
  CHANNEL_MAX_MESSAGE_BYTES,
  MISSED_PINGS_BEFORE_DEAD,
  PING_INTERVAL_MS,
  PROTOCOL_MISMATCH_RETRY_MS,
  PROTOCOL_UNSUPPORTED_CODE,
  PROTOCOL_VERSION,
  REQUEST_TIMEOUT_MS,
  backoffDelayMs,
} from './protocol';
export type {
  AppShutdownParams,
  ChannelFailure,
  ChannelIdentity,
  ClientInfo,
  HandoffEventParams,
  HelloResult,
} from './protocol';

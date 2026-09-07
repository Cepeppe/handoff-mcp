/**
 * The numbers and the payload shapes of the internal channel (TECHNICAL-DESIGN §4.1, §6,
 * `protocol/channel/README.md`).
 *
 * The machine-readable definition is `protocol/channel/channel.v1.schema.json`, which the
 * **app** validates every incoming line against. The server does not: it has to tolerate
 * unknown fields in a result so that a patch release of the app does not break a stale
 * server (§6.3), and a closed schema cannot express that. What lives here instead is the
 * small set of facts the client needs to speak the protocol correctly, transcribed from the
 * design and pinned against the schema by `test/contract/channel.test.ts` — the version
 * above all, because a constant that drifts from `protocol/channel/protocol_version` would
 * make every connection fail with `protocol_unsupported` and nothing would say why.
 */

/**
 * The version this server speaks. Equal to `protocol/channel/protocol_version` and to the
 * `protocol_version_current` constant of the schema; both peers require **equality**, there
 * is no negotiation (§6.5).
 *
 * It is a constant rather than a read of the file because the server ships as a single
 * bundled executable with no package directory to read at run time (§5.1).
 */
export const PROTOCOL_VERSION = 1;

/** §6.1: a longer line closes the connection. */
export const CHANNEL_MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

/** §6.6: non-blocking requests only. A blocking wait is a notification and has no timeout. */
export const REQUEST_TIMEOUT_MS = 10_000;

/** §6.3: a ping after this much silence. */
export const PING_INTERVAL_MS = 30_000;

/** §6.3: two pings without an answer mean the connection is dead. */
export const MISSED_PINGS_BEFORE_DEAD = 2;

/** §5.3, §4.1: the reconnect schedule, in seconds 1, 2, 5, 10, then 30 for ever. */
export const BACKOFF_SCHEDULE_MS: readonly number[] = [1_000, 2_000, 5_000, 10_000, 30_000];

/** §6.5: after a version mismatch the server retries every five minutes, not sooner. */
export const PROTOCOL_MISMATCH_RETRY_MS = 300_000;

/** The delay of the `attempt`-th retry, saturating on the last step of the schedule. */
export function backoffDelayMs(attempt: number, schedule = BACKOFF_SCHEDULE_MS): number {
  const index = Math.min(Math.max(attempt, 0), schedule.length - 1);
  return schedule[index] ?? 0;
}

/** The two connection-level errors of §6.3, with the numbers the design fixes. */
export const AUTH_FAILED_CODE = -32001;
export const PROTOCOL_UNSUPPORTED_CODE = -32002;

/**
 * How a failure to register is reported to the tool pipeline: the two codes of the error
 * catalogue (§4.7.5) whose fix text tells the user what to repair. `CHANNEL_AUTH_FAILED`
 * covers a rejected token and a token file that is missing or unreadable alike (FM-10):
 * there is nothing else to say and nothing else to do about either.
 */
export type ChannelFailure = 'CHANNEL_AUTH_FAILED' | 'PROTOCOL_MISMATCH';

/** The identity payload of §5.8, as `hello` carries it for a server. */
export interface ChannelIdentity {
  readonly pid: number;
  readonly ppid: number;
  readonly ancestors: readonly { readonly pid: number; readonly name: string }[];
  readonly cwd: string;
  readonly project_dir: string;
}

/** `clientInfo` of the MCP `initialize` handshake, as it travels in `hello`. */
export interface ClientInfo {
  readonly name: string;
  readonly version: string;
}

/** The result the app answers `hello` with (§6.3). */
export interface HelloResult {
  readonly app_version: string;
  readonly protocol_version: number;
  readonly session_ref: string | null;
}

/** The payload of the `handoff.event` notification (§6.3). */
export interface HandoffEventParams {
  readonly call_id: string;
  readonly handoff_id: string;
  readonly outcome: Record<string, unknown>;
}

/** The payload of the `app.shutdown` notification (§6.3). */
export interface AppShutdownParams {
  readonly reason: string;
}

/** The methods the app may send to the server (§6.3): one request and two notifications. */
export const APP_TO_SERVER_METHODS: readonly string[] = ['ping', 'handoff.event', 'app.shutdown'];

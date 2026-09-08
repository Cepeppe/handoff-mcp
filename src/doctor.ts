/**
 * `handoff-mcp doctor` (TECHNICAL-DESIGN §5.12): the first thing support asks for.
 *
 * It answers, in one screen and with no agent and no overlay involved, the five questions
 * every report about this server turns out to be: which agent do you think you are talking
 * to, what did the capability table resolve for it, is the channel token there and readable,
 * can the app be reached on the endpoint the two peers derive independently, and are there
 * any runbooks. Everything it prints is already known to both peers or to the user; the
 * **token itself is never printed**, only whether the file is usable and how tight its
 * permissions are (§5.8, SRV-08).
 *
 * The channel line is a real connection, not a `stat`: a hello with `role: "server"` and
 * then `session.bye`, which is what tells the difference between "the app is not running"
 * (normal — every call degrades to text mode) and "the app refused the token" or "the two
 * speak different protocol versions" (a repair the user has to make). The probe therefore
 * drives `ChannelClient` exactly as `serve` does, with one difference: a single attempt.
 * The client's schedule retries for ever by design (§5.3), which is right for a session and
 * would make a diagnostic hang.
 *
 * Exit code: 0 when nothing needs repairing, 1 when something does. An app that is simply
 * not running is **not** a problem — text mode is a supported way to work (SRV-14) — while
 * an unusable token, a refused token, a version mismatch and an unreadable runbook folder
 * all are, and each is repeated in a `problem:` line at the end, so that a person pasting
 * the output has the summary in the last lines.
 */
import { statSync } from 'node:fs';
import { connect as netConnect } from 'node:net';

import {
  CAPABILITIES_VERSION,
  capabilityRowForHello,
  heartbeatAfterMs,
  resolveCapabilityRow,
  resolveToolTimeout,
  type ResolvedCapabilityRow,
  type ResolvedTimeout,
} from './adapters';
import {
  ChannelClient,
  PROTOCOL_VERSION,
  type ChannelConnect,
  type ChannelFailure,
} from './channel';
import { readConfig, type EnvRecord } from './config';
import { createLogger, type LogLevel, type Logger } from './log';
import {
  TOKEN_MODE,
  TokenFile,
  endpointTarget,
  resolveEndpoint,
  resolveProcessIdentity,
  runbooksDir,
  type Endpoint,
  type ProcessIdentity,
  type TokenProblem,
  type TokenRead,
} from './platform';
import { RunbookStore, defaultRunbookRoots } from './runbooks';

/**
 * How long the endpoint probe is given. §6.2 lets the app take two seconds to answer
 * `hello` after accepting the socket, so anything shorter would report a busy app as
 * unreachable; the extra second covers the accept itself. Nothing waits this long in
 * practice: an app that is not listening fails in a millisecond and is reported at once.
 */
export const DOCTOR_PROBE_TIMEOUT_MS = 3_000;

/** Versions, and where the folder shared with the app is. */
export interface DoctorServer {
  readonly version: string;
  readonly protocol_version: number;
  readonly capabilities_version: number;
  readonly node: string;
  readonly platform: string;
  readonly home: string;
  readonly log_level: LogLevel;
  /** Environment variables set to something unusable, which are treated as unset (§5.12). */
  readonly ignored: readonly string[];
}

/** The resolved row of §5.6, with the timeout arithmetic that hangs off it. */
export interface DoctorAgent {
  readonly row: ResolvedCapabilityRow;
  readonly timeout: ResolvedTimeout;
  readonly heartbeat_after_ms: number;
  /** `HANDOFF_AGENT` as the installer wrote it, when it is set. */
  readonly requested: string | undefined;
}

/** The token file (§5.8). Never its contents. */
export interface DoctorToken {
  readonly path: string;
  readonly status: 'ok' | TokenProblem;
  /** `0600`, or `-` where the platform has no POSIX mode or it could not be read. */
  readonly mode: string;
  /** True when another user of this machine could read the token (§5.8). */
  readonly loose: boolean;
}

/** What the probe found on the endpoint. */
export type DoctorChannel = { readonly endpoint: string } & (
  | { readonly status: 'reachable'; readonly app_version: string; readonly session_ref: string }
  | { readonly status: 'unreachable'; readonly reason: string }
  | { readonly status: 'refused'; readonly failure: ChannelFailure }
  | { readonly status: 'not_probed'; readonly reason: string }
);

/** `~/.handoff/runbooks/` (§5.10, §12.3). */
export interface DoctorRunbooks {
  readonly path: string;
  readonly status: 'ok' | 'missing' | 'unreadable';
  readonly count: number;
}

export interface DoctorReport {
  readonly server: DoctorServer;
  readonly agent: DoctorAgent;
  readonly token: DoctorToken;
  readonly channel: DoctorChannel;
  readonly runbooks: DoctorRunbooks;
  /** One sentence per thing the user has to repair. Empty means exit 0. */
  readonly problems: readonly string[];
}

/** Everything the report reads, injected so a test needs no app and no file system. */
export interface DoctorOptions {
  /** The version of this server, as `src/main.ts` knows it. */
  readonly version: string;
  readonly env?: EnvRecord;
  readonly logger?: Logger;
  /** Where a warning about an unreadable runbook file goes (§5.10). */
  readonly warn?: (line: string) => void;
  readonly probeTimeoutMs?: number;
  readonly connect?: ChannelConnect;
  readonly endpoint?: () => Endpoint;
  readonly identity?: () => Promise<ProcessIdentity>;
  readonly runbooks?: RunbookStore;
  /** The POSIX permission bits of a file, or nothing when they cannot be read. */
  readonly mode?: (path: string) => number | undefined;
  readonly folderExists?: (path: string) => boolean;
  readonly node?: string;
  readonly platform?: string;
}

function statMode(path: string): number | undefined {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return undefined;
  }
}

function isFolder(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** `0644`: the notation `chmod` takes, which is what a fix sentence tells the user. */
function octal(mode: number): string {
  return `0${mode.toString(8).padStart(3, '0')}`;
}

/** The token file, read but never printed. A no-op warn: the report has its own mode line. */
function tokenFile(env: EnvRecord | undefined): TokenFile {
  return new TokenFile({
    ...(env === undefined ? {} : { env }),
    warn: () => {
      /* the report prints the mode itself, once */
    },
  });
}

function inspectToken(
  env: EnvRecord | undefined,
  mode: (path: string) => number | undefined,
): DoctorToken {
  const file = tokenFile(env);
  const read = file.read();
  const bits = process.platform === 'win32' ? undefined : mode(file.file);
  const loose = bits !== undefined && (bits & ~TOKEN_MODE & 0o777) !== 0;
  return {
    path: file.file,
    status: read.ok ? 'ok' : read.problem,
    mode: bits === undefined ? '-' : octal(bits),
    loose,
  };
}

interface ProbeOptions {
  readonly endpoint: Endpoint;
  readonly row: ResolvedCapabilityRow;
  readonly timeout: ResolvedTimeout;
  readonly version: string;
  readonly identity: ProcessIdentity;
  readonly projectDir: string;
  readonly token: () => TokenRead;
  readonly logger: Logger;
  readonly probeTimeoutMs: number;
  readonly connect: ChannelConnect;
}

const defaultConnect: ChannelConnect = (endpoint) => netConnect({ path: endpointTarget(endpoint) });

/**
 * One attempt at the endpoint, then goodbye.
 *
 * `backoff` is a single step as long as the probe itself, so the client's retry can never
 * fire inside the window; the wait ends as soon as the registration succeeds or the socket
 * reports an error, which is what keeps "the app is not running" instant instead of costing
 * the full timeout. `close()` is the `session.bye` of §5.3.
 */
async function probeChannel(options: ProbeOptions): Promise<DoctorChannel> {
  const { endpoint, logger, probeTimeoutMs, row, timeout } = options;
  const target = endpointTarget(endpoint);

  let settle: (() => void) | undefined;
  let socketError: string | undefined;

  const client = new ChannelClient({
    identity: {
      pid: options.identity.pid,
      ppid: options.identity.ppid,
      ancestors: options.identity.ancestors,
      cwd: process.cwd(),
      project_dir: options.projectDir,
    },
    agentId: row.agent_id,
    client: { name: row.agent_id, version: options.version },
    capabilityRow: capabilityRowForHello(row, timeout.ms),
    serverVersion: options.version,
    logger,
    endpoint: () => endpoint,
    token: options.token,
    backoff: [probeTimeoutMs],
    connect: (where) => {
      const socket = options.connect(where);
      socket.once('error', (cause: Error) => {
        socketError ??= codeOf(cause);
        settle?.();
      });
      return socket;
    },
  });

  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, probeTimeoutMs);
    settle = (): void => {
      clearTimeout(timer);
      resolve();
    };
    client.on('connected', () => {
      settle?.();
    });
    client.start();
  });

  const connected = client.isConnected();
  const appVersion = client.appVersion;
  const sessionRef = client.sessionRef;
  const failure = client.failure;
  const reason = socketError ?? 'the app did not answer hello';
  await client.close();

  if (connected && appVersion !== undefined && sessionRef !== undefined) {
    return {
      endpoint: target,
      status: 'reachable',
      app_version: appVersion,
      session_ref: sessionRef,
    };
  }
  if (failure !== undefined) return { endpoint: target, status: 'refused', failure };
  return { endpoint: target, status: 'unreachable', reason };
}

function codeOf(cause: unknown): string {
  if (typeof cause === 'object' && cause !== null) {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return cause instanceof Error ? cause.name : 'unknown';
}

/** The problems worth an exit code, in the order the report prints their sections. */
function problemsOf(
  token: DoctorToken,
  channel: DoctorChannel,
  runbooks: DoctorRunbooks,
): string[] {
  const problems: string[] = [];
  if (token.status !== 'ok') {
    problems.push(
      `the channel token file is ${token.status}: install the app, or repair the installation from its settings`,
    );
  }
  if (channel.status === 'refused') {
    problems.push(
      channel.failure === 'CHANNEL_AUTH_FAILED'
        ? 'the app refused the token: repair the installation from the app settings'
        : 'the app speaks another protocol version: update the app, which bundles the matching server',
    );
  }
  if (runbooks.status === 'unreadable') {
    problems.push('the runbook folder exists but cannot be read: check its permissions');
  }
  return problems;
}

/** Reads everything the report is made of. Prints nothing: `runDoctor` does that. */
export async function collectDoctorReport(options: DoctorOptions): Promise<DoctorReport> {
  const {
    env,
    version,
    logger = createLogger('error', () => {
      /* the CLI passes its own */
    }),
    warn = (): void => {
      /* the CLI passes its own */
    },
    probeTimeoutMs = DOCTOR_PROBE_TIMEOUT_MS,
    mode = statMode,
    folderExists = isFolder,
    connect = defaultConnect,
    node = process.version,
    platform = `${process.platform} ${process.arch}`,
  } = options;

  const config = readConfig(env);
  const row = resolveCapabilityRow({ agent: config.agent });
  const timeout = resolveToolTimeout(row, config);
  const token = inspectToken(env, mode);
  const resolveHere = (): Endpoint => resolveEndpoint(env === undefined ? {} : { env });
  const endpoint = (options.endpoint ?? resolveHere)();

  // A token that cannot be used makes every attempt fail for the reason the token line
  // already gives, so the probe is skipped rather than reported twice.
  const channel: DoctorChannel =
    token.status === 'ok'
      ? await probeChannel({
          endpoint,
          row,
          timeout,
          version,
          identity: await (options.identity ?? resolveProcessIdentity)(),
          projectDir: config.projectDir,
          token: () => tokenFile(env).read(),
          logger,
          probeTimeoutMs,
          connect,
        })
      : {
          endpoint: endpointTarget(endpoint),
          status: 'not_probed',
          reason: `the token file is ${token.status}`,
        };

  const store = options.runbooks ?? new RunbookStore(defaultRunbookRoots(env), { warn });
  const read = store.readForTool();
  const folder = runbooksDir(env);
  const runbooks: DoctorRunbooks = read.ok
    ? { path: folder, status: folderExists(folder) ? 'ok' : 'missing', count: read.runbooks.length }
    : { path: folder, status: 'unreadable', count: 0 };

  return {
    server: {
      version,
      protocol_version: PROTOCOL_VERSION,
      capabilities_version: CAPABILITIES_VERSION,
      node,
      platform,
      home: config.home,
      log_level: config.logLevel,
      ignored: config.ignored,
    },
    agent: {
      row,
      timeout,
      heartbeat_after_ms: heartbeatAfterMs(row, config),
      requested: config.agent,
    },
    token,
    channel,
    runbooks,
    problems: problemsOf(token, channel, runbooks),
  };
}

/** How wide the label column is, so every value lines up under its heading. */
const LABEL_WIDTH = 27;

function field(label: string, value: string | number | boolean): string {
  return `  ${label.padEnd(LABEL_WIDTH)}${String(value)}`;
}

function channelLines(channel: DoctorChannel): string[] {
  const lines = [field('endpoint', channel.endpoint)];
  switch (channel.status) {
    case 'reachable':
      lines.push(
        field('status', 'reachable'),
        field('app_version', channel.app_version),
        field('session_ref', channel.session_ref),
      );
      break;
    case 'unreachable':
      lines.push(
        field('status', `not reachable (${channel.reason})`),
        field('', 'the app is not running; every call degrades to text mode'),
      );
      break;
    case 'refused':
      lines.push(field('status', `refused (${channel.failure})`));
      break;
    case 'not_probed':
      lines.push(field('status', `not probed (${channel.reason})`));
      break;
  }
  return lines;
}

/** The report as the lines `doctor` prints, in order. */
export function renderDoctorReport(report: DoctorReport): string[] {
  const { agent, channel, runbooks, server, token } = report;
  const { row } = agent;

  const lines = [
    'server',
    field('version', server.version),
    field('protocol_version', server.protocol_version),
    field('capabilities_version', server.capabilities_version),
    field('node', server.node),
    field('platform', server.platform),
    field('home', server.home),
    field('log_level', server.log_level),
  ];
  if (server.ignored.length > 0) lines.push(field('ignored', server.ignored.join(', ')));

  lines.push(
    '',
    'agent',
    field('agent_id', row.agent_id),
    field('display_name', row.display_name),
    field('resolved_from', agent.requested === undefined ? 'the unknown row' : 'HANDOFF_AGENT'),
    field('support', row.support),
    field('table_status', row.status),
    field('images_in_results', row.images_in_results),
    field('stop_hook', row.stop_hook),
    field('subagent_stop_hook', row.subagent_stop_hook),
    field('session_identity', row.session_identity),
    field('user_request_delivery', row.user_request_delivery.join(', ')),
    field('cancellation_notifications', row.cancellation_notifications),
    field(
      'tool_timeout_ms',
      agent.timeout.ms === null
        ? `unknown (${agent.timeout.source})`
        : `${String(agent.timeout.ms)} (${agent.timeout.source})`,
    ),
    field('heartbeat_after_ms', agent.heartbeat_after_ms),
    field(
      'per_server_timeout_field',
      row.per_server_timeout_field === null ? '-' : row.per_server_timeout_field,
    ),

    '',
    'token',
    field('path', token.path),
    field('status', token.status),
    field('mode', token.loose ? `${token.mode} (wider than 0600)` : token.mode),

    '',
    'channel',
    ...channelLines(channel),

    '',
    'runbooks',
    field('path', runbooks.path),
    field('status', runbooks.status),
    field('count', runbooks.count),
    '',
  );

  if (report.problems.length === 0) lines.push('doctor: nothing to repair');
  else for (const problem of report.problems) lines.push(`problem: ${problem}`);

  return lines;
}

export interface RunDoctorOptions extends DoctorOptions {
  /** The report goes to stdout, like the result of every other subcommand (§5.12). */
  readonly out: (line: string) => void;
}

/** `handoff-mcp doctor`: 0 when nothing needs repairing, 1 when something does. */
export async function runDoctor(options: RunDoctorOptions): Promise<number> {
  const report = await collectDoctorReport(options);
  for (const line of renderDoctorReport(report)) options.out(line);
  return report.problems.length === 0 ? 0 : 1;
}

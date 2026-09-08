/**
 * Tool registration and the tool-call pipeline (TECHNICAL-DESIGN §5.2, §5.3, §4.7, §5.7).
 *
 * The five steps of §5.2 in one file: parse the input and infer the shape, validate and scan
 * an open, decide what a missing channel means, send `handoff.open` / `handoff.continue` /
 * `handoff.resume`, and block until the app answers. `handoff_verify` and `handoff_runbooks`
 * are the two calls that never block — the first is a forward, the second reads files.
 *
 * **The degraded half is not an afterthought.** Every path here has a second reading for a
 * channel that is not there (§5.2 step 4, PRIN-10): an open becomes text mode and the
 * handoff happens in chat (SRV-14), while a continue, a resume or a verify becomes
 * `APP_DISCONNECTED`, because the state they need lives in the app and nowhere else. When
 * the channel is refusing rather than absent — a token that does not match, a protocol
 * version that differs — the text mode carries the fix text of FM-10 and FM-11 as well.
 *
 * **Why the low-level `Server` and not `McpServer`.** `McpServer.registerTool` accepts only
 * Zod schemas and converts them to JSON Schema itself. The input schemas of this server are
 * generated from `schemas/tool-contract.v1.md` — with the whole published spec schema
 * inlined into `handoff_to_user` — and the whole point of generating them is that what an
 * agent is shown is byte for byte what the document promises. Round-tripping them through
 * Zod would put a converter between the document and the agent. The low-level server
 * registers them verbatim, which is what §4.7 means by "the input schemas below are the
 * ones registered with MCP".
 *
 * Output discipline: while `serve` is serving, stdout carries the MCP transport and
 * nothing else (§5.12). Everything this module says goes through the injected logger, on
 * stderr, and never carries a spec value (R-19).
 */
/* eslint-disable @typescript-eslint/no-deprecated -- `Server` is the SDK's low-level API,
   marked deprecated only in favour of `McpServer`, which cannot register a JSON Schema.
   See "Why the low-level Server" in the module comment above. */
import type { Readable, Writable } from 'node:stream';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';

import {
  heartbeatAfterMs,
  resolveCapabilityRow,
  resolveToolTimeout,
  type ResolvedCapabilityRow,
} from '../adapters';
import { InFlightCalls, readSnapshot, type WaitOutcome } from '../calls';
import { applicationErrorName, type ClientInfo, type JsonRpcParams } from '../channel';
import type { Config } from '../config';
import {
  catalogueError,
  handoffError,
  unknownValueKeyProblem,
  validateReplacementSteps,
  validateSpec,
  type HandoffError,
  type HandoffSpec,
  type Problem,
} from '../format';
import { newCallId } from '../ids';
import type { Logger } from '../log';
import {
  searchRunbooks,
  type RunbookMatch,
  type RunbookQuery,
  type RunbookStore,
} from '../runbooks';
import { scanSpecSpans, toSecretTreated, type SecretTreated } from '../secrets';
import { textModeOutcome } from '../textmode';

import {
  ANNOTATIONS,
  TOOL_DESCRIPTIONS,
  TOOL_INPUT_SCHEMAS,
  TOOL_NAMES,
  type ToolName,
} from './generated/contract';
import { inferShape, parseRunbooksQuery, parseVerifyInput, type CallShape } from './input';
import {
  hookVariant,
  outcomeFromChannel,
  renderError,
  renderOutcome,
  renderRunbooks,
  runbookMatchOutcome,
  serverOutcome,
  withChannelFailure,
  OUTCOME_OUTPUT_SCHEMA,
  RUNBOOKS_OUTPUT_SCHEMA,
  type Outcome,
} from './outcome';
import { type ChannelPort } from './port';

/** The name the server reports in `initialize`; it is the executable's, not the package's. */
export const SERVER_NAME = 'handoff-mcp';

/** Everything the pipeline needs, injected so a test drives it without a process. */
export interface ServerDeps {
  /** The environment read once at startup (§5.3). */
  readonly config: Config;
  /** What `serverInfo.version` reports. */
  readonly version: string;
  /** The route to the app: `ChannelClient` in `serve`, `NullChannel` in a text-mode test. */
  readonly channel: ChannelPort;
  /** The runbook reader, already pointed at its roots (§5.10). */
  readonly runbooks: RunbookStore;
  /** stderr, structured and field-filtered (§5.12, R-19). */
  readonly logger: Logger;
  /**
   * How long a blocking call waits before the heartbeat, overriding the arithmetic of §5.6.
   *
   * The real value is `max(tool_timeout − 60 s, 50 s)` (TOOL-06a), so the shortest heartbeat
   * a configuration can produce is fifty seconds. An integration test that has to see one
   * fire injects a few hundred milliseconds here; nothing else sets it, and left unset the
   * session's capability row decides, which is what the design says.
   */
  readonly heartbeatAfterMs?: number;
  /**
   * Called once the agent has completed `initialize` (§5.3), with the capability row
   * resolved from its `clientInfo` and that `clientInfo` itself.
   *
   * §5.3 registers the session **after** this moment and not before, because `hello` carries
   * both of them and neither is known until the handshake is over: `hello.client` is a
   * required field of the channel and the row decides the heartbeat the app is told about.
   * It is still "at session start rather than at the first tool call" (SRV-20) — `initialize`
   * is the first thing an MCP client does.
   */
  readonly onInitialized?: (row: ResolvedCapabilityRow, client: ClientInfo) => void;
  /**
   * The agent's pipes. `serve` uses the process's own; a test hands it a pair so it can pull
   * stdin out from under the server and watch it stop, without writing the MCP transport to
   * the terminal it is being run from.
   */
  readonly stdio?: { readonly input: Readable; readonly output: Writable };
}

/** The `outputSchema` each tool declares (§4.3 MCP mapping, TOOL-15). */
const OUTPUT_SCHEMAS: Readonly<Record<ToolName, unknown>> = {
  handoff_to_user: OUTCOME_OUTPUT_SCHEMA,
  handoff_verify: OUTCOME_OUTPUT_SCHEMA,
  handoff_runbooks: RUNBOOKS_OUTPUT_SCHEMA,
};

/**
 * The three tools as `tools/list` returns them: the generated description, the generated
 * input schema verbatim, the output schema of §4.3 and the annotations of §4.7.
 */
export function toolDefinitions(): Tool[] {
  return TOOL_NAMES.map((name) => ({
    name,
    description: TOOL_DESCRIPTIONS[name],
    inputSchema: TOOL_INPUT_SCHEMAS[name] as unknown as Tool['inputSchema'],
    outputSchema: OUTPUT_SCHEMAS[name] as Tool['outputSchema'],
    annotations: ANNOTATIONS[name],
  }));
}

// ------------------------------------------------------------- errors from the channel

/**
 * What the app's refusal means to the agent (§6.3 → §4.7.5).
 *
 * The mapping rests on the JSON-RPC **code** alone, which is why the five application errors
 * were numbered at all (`protocol/channel/README.md`, `DEVIATIONS.md`). `unknown_value_key`
 * is the one that is not a catalogue code of its own: it is the app performing S3 on
 * `replacement_steps` with the value keys only it holds, so it comes back as the
 * `SPEC_INVALID` that same rule produces here, one problem per key it named.
 */
function channelError(cause: unknown, path: string): HandoffError {
  const code = (cause as { code?: unknown }).code;
  const name = typeof code === 'number' ? applicationErrorName(code) : undefined;

  switch (name) {
    case 'unknown_value_key':
      return unknownValueKeys(cause);
    case 'not_waiting':
      return catalogueError('HANDOFF_NOT_WAITING', path);
    case 'final':
      return catalogueError('HANDOFF_FINAL', path);
    case 'no_verify_in_spec':
      return catalogueError('NO_VERIFY_IN_SPEC', path);
    case 'not_found':
      return catalogueError('HANDOFF_NOT_FOUND', path);
    default:
      // Either the app is unreachable (`ChannelError`) or it answered something this
      // version does not know. Both leave the agent with the same move: retry the same
      // call in a few seconds, which is `APP_DISCONNECTED`'s fix text.
      return catalogueError('APP_DISCONNECTED', path);
  }
}

/** `data.keys` of `unknown_value_key`, turned into the S3 problems of §4.2. */
function unknownValueKeys(cause: unknown): HandoffError {
  const data = (cause as { data?: unknown }).data;
  const raw = typeof data === 'object' && data !== null ? (data as { keys?: unknown }).keys : [];
  const keys = Array.isArray(raw)
    ? raw.filter((key): key is string => typeof key === 'string')
    : [];
  const problems: Problem[] = keys.map((key) =>
    // The known keys are the app's, not ours: it holds the spec. Naming them here would
    // mean guessing, so the problem cites the key the app refused and nothing more.
    unknownValueKeyProblem('replacement_steps', key, 'replacement_steps', []),
  );
  return handoffError(
    'SPEC_INVALID',
    problems.length > 0
      ? problems
      : [
          {
            path: 'replacement_steps',
            problem: 'A replacement step cites a value the handoff does not declare.',
            fix: 'Cite only value names the handoff already declares, or remove the citation.',
          },
        ],
  );
}

// ------------------------------------------------------------------------ the pipeline

/** The safety net's query is the spec's own `where`, `goal` and `lang` (RUN-07, §4.5.3). */
function safetyNetQuery(spec: HandoffSpec): RunbookQuery {
  const { where, goal, lang } = spec;
  return lang === undefined ? { where, goal } : { where, goal, lang };
}

/**
 * §5.2 step 2, the open shape: version check and schema, then S2-S6, then the certain
 * detector, then the runbook safety net.
 *
 * Returns the result to send when the call ends here — an invalid spec, or a runbook that
 * already covers this work — and otherwise the validated spec with what the detector found,
 * so the caller goes on to step 4.
 */
function openChecks(
  deps: ServerDeps,
  row: ResolvedCapabilityRow,
  shape: Extract<CallShape, { kind: 'open' }>,
):
  | { readonly done: CallToolResult }
  | { readonly spec: HandoffSpec; readonly treated: readonly SecretTreated[] } {
  const validated = validateSpec(shape.spec);
  if (!validated.ok) return { done: renderError(validated.error) };
  const spec = validated.spec;

  const treated: readonly SecretTreated[] = toSecretTreated(scanSpecSpans(spec));

  if (!shape.ignoreRunbook) {
    // An unreadable folder is skipped here, never reported: a permissions problem on a
    // folder of recipes must not stop a handoff from opening (§5.10, FM-19).
    const matches: readonly RunbookMatch[] = searchRunbooks(
      deps.runbooks.readForSafetyNet(),
      safetyNetQuery(spec),
    );
    if (matches.length > 0) {
      return {
        done: renderOutcome(runbookMatchOutcome(matches, treated, hookVariant(row)), row),
      };
    }
  }

  return { spec, treated };
}

/** Everything a blocking call needs after the app has accepted it. */
interface PipelineContext {
  readonly deps: ServerDeps;
  readonly calls: InFlightCalls;
  readonly row: ResolvedCapabilityRow;
  readonly signal: AbortSignal;
}

/** Text mode, with the fix text of FM-10 or FM-11 when the channel is refusing (§5.9). */
function textMode(context: PipelineContext, spec: HandoffSpec): CallToolResult {
  const { deps, row } = context;
  return withChannelFailure(
    renderOutcome(textModeOutcome(spec, hookVariant(row)), row),
    deps.channel.failure,
  );
}

/**
 * §5.2 step 5: the call is registered in the in-flight table and blocks until §8.2 says it
 * is over. The four endings become the four results an agent can receive.
 */
async function block(
  context: PipelineContext,
  handoffId: string,
  callId: string,
): Promise<CallToolResult> {
  const { deps, calls, row, signal } = context;
  const waited: WaitOutcome = await calls.waitForOutcome({
    handoff_id: handoffId,
    call_id: callId,
    heartbeatAfterMs: deps.heartbeatAfterMs ?? heartbeatAfterMs(row, deps.config),
    signal,
  });

  switch (waited.kind) {
    case 'outcome':
      return renderChannelOutcome(context, waited.outcome, waited.image, waited.already_delivered);
    case 'heartbeat':
      return renderOutcome(serverOutcome('in_progress', handoffId), row);
    case 'transferred':
      return renderOutcome(serverOutcome('transferred_to_other_session', handoffId), row);
    case 'not_found':
      return renderError(catalogueError('HANDOFF_NOT_FOUND', 'resume'));
    case 'cancelled':
      // The agent is gone and the SDK will drop whatever is returned here. Answering the
      // shape of a result rather than throwing keeps the handler's contract honest.
      return renderOutcome(serverOutcome('in_progress', handoffId), row);
  }
}

/**
 * An outcome the app produced, rendered for this session (§4.3, §4.7.4).
 *
 * The image is attached only when the user sent one **and** the row says the client can show
 * it; either way the bytes are a local of this function and of the result it builds, held
 * for the duration of the tool result and never stored (§6.6).
 */
function renderChannelOutcome(
  context: PipelineContext,
  raw: Record<string, unknown>,
  image: string | undefined,
  alreadyDelivered: boolean,
): CallToolResult {
  const outcome = outcomeFromChannel(raw);
  if (outcome === undefined) {
    const status = raw['status'];
    // The status is the one field that cannot be defaulted, so it is the one worth naming;
    // it is an enum of fourteen words, never a value of the user's (R-19).
    context.deps.logger.error('outcome_unreadable', {
      status: typeof status === 'string' ? status : 'absent',
    });
    return renderError(catalogueError('INTERNAL'));
  }
  const delivered: Outcome = alreadyDelivered ? { ...outcome, already_delivered: true } : outcome;
  return renderOutcome(delivered, context.row, image);
}

/**
 * The open shape (§4.7.1, §5.2 steps 1, 2, 4, 5).
 *
 * The spec crosses the channel **unmasked**: the app shows the true values behind a Copy
 * button and needs them (FM-15, DET-03). What travels with it is `secret_treated`, the list
 * of locations the detector matched, so the app masks the same spans the server reported to
 * the agent.
 */
async function openHandoff(
  context: PipelineContext,
  shape: Extract<CallShape, { kind: 'open' }>,
): Promise<CallToolResult> {
  const { deps, row } = context;
  const checked = openChecks(deps, row, shape);
  if ('done' in checked) return checked.done;

  if (!deps.channel.isConnected()) return textMode(context, checked.spec);

  const callId = newCallId();
  let result: JsonRpcParams;
  try {
    result = await deps.channel.request('handoff.open', {
      call_id: callId,
      spec: checked.spec as unknown as JsonRpcParams,
      secret_treated: [...checked.treated],
      request_id: shape.requestId ?? null,
    });
  } catch (cause) {
    // The handoff was never created, so there is state nowhere and text mode is the whole
    // of the degradation: the agent guides the user in chat instead (FM-01, SRV-14).
    deps.logger.error('open_failed', { call_id: callId, reason: reasonOf(cause) });
    return textMode(context, checked.spec);
  }

  const handoffId = result['handoff_id'];
  if (typeof handoffId !== 'string') {
    deps.logger.error('open_without_handoff_id', { call_id: callId });
    return renderError(catalogueError('INTERNAL'));
  }
  deps.logger.debug('handoff_opened', { handoff_id: handoffId, call_id: callId });
  return block(context, handoffId, callId);
}

/**
 * The continue shape (§4.7.1, §5.2 step 3).
 *
 * `replacement_steps` are held to the schema of the steps they replace and to S3-S6, but S3
 * needs the handoff's value keys and the handoff belongs to the app: this server may never
 * have seen its spec, because a resume works from any session (TOOL-08). So the schema and
 * the rules that need no keys are checked here, and the app answers `unknown_value_key` for
 * the one that does — which is the same check, run where the keys are (§5.2 step 3).
 */
async function continueHandoff(
  context: PipelineContext,
  shape: Extract<CallShape, { kind: 'continue' }>,
): Promise<CallToolResult> {
  const { deps } = context;
  if (!deps.channel.isConnected()) return renderError(disconnected(deps, 'handoff_id'));

  let steps: readonly unknown[] | undefined;
  if (shape.replacementSteps !== undefined) {
    const validated = validateReplacementSteps(shape.replacementSteps, null);
    if (!validated.ok) return renderError(validated.error);
    steps = validated.steps;
  }

  // A continue re-attaches the call the question came back on: only an open and a resume
  // mint a `call_id` (§6.3, the golden sequences). A handoff this server never opened —
  // resume works from any session — has none to reuse, and a fresh one is correct there.
  const callId = context.calls.callIdFor(shape.handoffId) ?? newCallId();
  try {
    await deps.channel.request('handoff.continue', {
      call_id: callId,
      handoff_id: shape.handoffId,
      reply: shape.reply,
      ...(steps === undefined ? {} : { replacement_steps: steps }),
    });
  } catch (cause) {
    deps.logger.debug('continue_refused', { handoff_id: shape.handoffId, call_id: callId });
    return renderError(channelError(cause, 'handoff_id'));
  }

  deps.logger.debug('handoff_continued', { handoff_id: shape.handoffId, call_id: callId });
  return block(context, shape.handoffId, callId);
}

/**
 * The resume shape (§4.7.1, §5.7, TOOL-07, TOOL-08).
 *
 * The snapshot decides between the three endings §5.7 names: a final handoff hands back the
 * outcome it already delivered, with `already_delivered` set by **this** server because
 * that flag is about the agent's history and not about the app's state; a queued undelivered
 * event is returned at once; anything else attaches the call and waits.
 */
async function resumeHandoff(
  context: PipelineContext,
  shape: Extract<CallShape, { kind: 'resume' }>,
): Promise<CallToolResult> {
  const { deps } = context;
  if (!deps.channel.isConnected()) return renderError(disconnected(deps, 'resume'));

  const callId = newCallId();
  let result: JsonRpcParams;
  try {
    result = await deps.channel.request('handoff.resume', {
      call_id: callId,
      handoff_id: shape.handoffId,
    });
  } catch (cause) {
    deps.logger.debug('resume_refused', { handoff_id: shape.handoffId, call_id: callId });
    return renderError(channelError(cause, 'resume'));
  }

  const snapshot = readSnapshot(result);
  deps.logger.debug('handoff_resumed', {
    handoff_id: shape.handoffId,
    call_id: callId,
    state: snapshot.state,
  });
  if (snapshot.outcome !== null) {
    return renderChannelOutcome(context, snapshot.outcome, snapshot.image, snapshot.final);
  }
  return block(context, shape.handoffId, callId);
}

/** `handoff_to_user` (§4.7.1, §5.2): one flat object, three shapes, one pipeline. */
async function handoffToUser(context: PipelineContext, args: unknown): Promise<CallToolResult> {
  const inferred = inferShape(args);
  if (!inferred.ok) return renderError(inferred.error);

  switch (inferred.shape.kind) {
    case 'open':
      return openHandoff(context, inferred.shape);
    case 'continue':
      return continueHandoff(context, inferred.shape);
    case 'resume':
      return resumeHandoff(context, inferred.shape);
  }
}

/**
 * `handoff_verify` (§4.7.2, §4.4): non-blocking, and nothing but a forward to the app, which
 * owns the handoff, its spec's `verify` and the states this call moves it between. Without
 * the channel there is nothing to check and nothing to record, so it answers what §4.7.5
 * reserves for exactly that (SRV-21).
 */
async function handoffVerify(context: PipelineContext, args: unknown): Promise<CallToolResult> {
  const { deps } = context;
  const parsed = parseVerifyInput(args);
  if (!parsed.ok) {
    throw new McpError(ErrorCode.InvalidParams, `handoff_verify: ${parsed.problem}`);
  }
  if (!deps.channel.isConnected()) return renderError(disconnected(deps, 'handoff_id'));

  let result: JsonRpcParams;
  try {
    result = await deps.channel.request('handoff.verify', {
      handoff_id: parsed.input.handoffId,
      verify: { ok: parsed.input.ok, detail: parsed.input.detail },
    });
  } catch (cause) {
    deps.logger.debug('verify_refused', { handoff_id: parsed.input.handoffId });
    return renderError(channelError(cause, 'handoff_id'));
  }

  const outcome = result['outcome'];
  if (typeof outcome !== 'object' || outcome === null || Array.isArray(outcome)) {
    deps.logger.error('verify_without_outcome', { handoff_id: parsed.input.handoffId });
    return renderError(catalogueError('INTERNAL'));
  }
  // A verification is never a screenshot, so no image accompanies its outcome (§4.4).
  return renderChannelOutcome(context, outcome as Record<string, unknown>, undefined, false);
}

/**
 * `handoff_runbooks` (§4.7.3, RUN-10): local files only, never the channel.
 *
 * The tool has one shape, so arguments that do not fit its registered input schema are a
 * protocol violation rather than one of the errors of §4.7.5, and they come back as the
 * JSON-RPC `Invalid params` that layer is for. The catalogue's own `RUNBOOKS_UNREADABLE`
 * stays what it is: the answer to "I looked and could not read the folder".
 */
function handoffRunbooks(deps: ServerDeps, args: unknown): CallToolResult {
  const parsed = parseRunbooksQuery(args);
  if (!parsed.ok) {
    throw new McpError(ErrorCode.InvalidParams, `handoff_runbooks: ${parsed.problem}`);
  }

  const read = deps.runbooks.readForTool();
  if (!read.ok) return renderError(read.error);
  return renderRunbooks(searchRunbooks(read.runbooks, parsed.query));
}

/**
 * The app is not reachable for a call that cannot be degraded (§4.7.5, FM-10, FM-11). A
 * refused token or a version mismatch is named for what it is, because those two have a
 * repair the agent can pass on to the user; anything else is `APP_DISCONNECTED`.
 */
function disconnected(deps: ServerDeps, path: string): HandoffError {
  return catalogueError(deps.channel.failure ?? 'APP_DISCONNECTED', path);
}

/** A cause as a short code, never a message that could quote something (R-19). */
function reasonOf(cause: unknown): string {
  if (typeof cause === 'object' && cause !== null) {
    const kind = (cause as { kind?: unknown }).kind;
    if (typeof kind === 'string') return kind;
    const code = (cause as { code?: unknown }).code;
    if (typeof code === 'number') return String(code);
  }
  return 'unknown';
}

// ------------------------------------------------------------------------ registration

/**
 * The MCP server, with the three tools registered over the channel it was given.
 *
 * The capability row is resolved from `HANDOFF_AGENT` and the `clientInfo` the SDK records
 * at `initialize` (§5.6). It is resolved per call rather than cached: resolution is a walk
 * over a table of six rows, and caching it would mean deciding what to do about a call
 * that somehow arrived first.
 */
export function createServer(deps: ServerDeps): Server {
  const server = new Server(
    { name: SERVER_NAME, version: deps.version },
    { capabilities: { tools: {} } },
  );
  // Built here rather than in `serve`, so that a test driving `createServer` over the
  // in-memory transport gets the same table and the same subscriptions as the product.
  const calls = new InFlightCalls({ channel: deps.channel, logger: deps.logger });

  const capabilityRow = (): ResolvedCapabilityRow =>
    resolveCapabilityRow({
      agent: deps.config.agent,
      clientName: server.getClientVersion()?.name,
    });

  server.oninitialized = () => {
    const row = capabilityRow();
    const timeout = resolveToolTimeout(row, deps.config);
    deps.logger.debug('session_initialized', {
      agent_id: row.agent_id,
      support: row.support,
      tool_timeout_ms: timeout.ms ?? undefined,
      reason: timeout.source,
    });
    const info = server.getClientVersion();
    deps.onInitialized?.(row, {
      name: info?.name ?? row.agent_id,
      version: typeof info?.version === 'string' ? info.version : '0.0.0',
    });
  };

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: toolDefinitions() }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args } = request.params;
    const context: PipelineContext = {
      deps,
      calls,
      row: capabilityRow(),
      signal: extra.signal,
    };
    const result = await dispatch(context, name, args);
    deps.logger.debug('tool_result', { method: name, ok: result.isError !== true });
    return result;
  });

  const close = server.onclose?.bind(server);
  server.onclose = () => {
    calls.close();
    close?.();
  };

  return server;
}

/** Routes one `tools/call`. An unknown name is a protocol error, not a catalogue error. */
async function dispatch(
  context: PipelineContext,
  name: string,
  args: unknown,
): Promise<CallToolResult> {
  switch (name) {
    case 'handoff_to_user':
      return handoffToUser(context, args);
    case 'handoff_verify':
      return handoffVerify(context, args);
    case 'handoff_runbooks':
      return handoffRunbooks(context.deps, args);
    default:
      throw new McpError(ErrorCode.MethodNotFound, `this server has no tool named ${name}`);
  }
}

/**
 * `handoff-mcp serve`: the three MCP tools over the stdio transport (§5.3, §5.12).
 *
 * Resolves when the agent closes stdin, which is how a stdio MCP server learns its client
 * has gone. The channel is started and stopped by the caller (`src/main.ts`), because it is
 * the caller that built it; what this function owns is the MCP half of the session.
 *
 * **The SDK does not watch stdin for EOF.** `StdioServerTransport` subscribes to `data` and
 * `error` and closes only when somebody calls `close()`, so the end of the pipe — which is
 * the only thing §5.3 has to detect, the agent having exited — reaches nobody. Until this
 * task the omission was invisible: with no channel there was nothing left holding the event
 * loop and the process fell out on its own. With a channel there is a socket and a retry
 * timer, and a server that did not watch stdin itself would outlive every session that ever
 * started it. Hence the two listeners below.
 */
export async function serve(deps: ServerDeps): Promise<number> {
  for (const name of deps.config.ignored) {
    deps.logger.error('env_ignored', { env_var: name });
  }

  const input = deps.stdio?.input ?? process.stdin;
  const output = deps.stdio?.output ?? process.stdout;

  const server = createServer(deps);
  const closed = new Promise<void>((resolve) => {
    const previous = server.onclose?.bind(server);
    server.onclose = () => {
      previous?.();
      resolve();
    };
  });

  await server.connect(new StdioServerTransport(input, output));
  deps.logger.debug('serve_started');

  // `end` is the ordinary EOF and `close` covers a pipe that was destroyed rather than
  // ended; whichever arrives first, closing the server twice is a no-op.
  const stop = (): void => {
    deps.logger.debug('stdin_closed');
    void server.close();
  };
  input.once('end', stop);
  input.once('close', stop);

  await closed;
  return 0;
}

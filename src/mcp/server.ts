/**
 * Tool registration and the tool-call pipeline (TECHNICAL-DESIGN §5.2, §5.3, §4.7).
 *
 * After this module `npx baton-handoff-mcp` is a working MCP server in **text mode**:
 * `handoff_runbooks` is complete, `handoff_to_user` validates a spec, scans it for certain
 * secrets, applies the runbook safety net and hands the spec back as text, and everything
 * that needs the handoff's state answers `APP_DISCONNECTED`. The channel is absent by
 * construction (`ChannelPort` / `NullChannel`); T-018 builds the client and T-020 plugs it
 * in, at the one seam marked below.
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

import { resolveCapabilityRow, resolveToolTimeout, type ResolvedCapabilityRow } from '../adapters';
import type { Config } from '../config';
import { catalogueError, validateSpec, type HandoffSpec } from '../format';
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
import { inferShape, parseRunbooksQuery, type CallShape } from './input';
import {
  hookVariant,
  renderError,
  renderOutcome,
  renderRunbooks,
  runbookMatchOutcome,
  OUTCOME_OUTPUT_SCHEMA,
  RUNBOOKS_OUTPUT_SCHEMA,
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
  /** The route to the app. `NullChannel` until T-020. */
  readonly channel: ChannelPort;
  /** The runbook reader, already pointed at its roots (§5.10). */
  readonly runbooks: RunbookStore;
  /** stderr, structured and field-filtered (§5.12, R-19). */
  readonly logger: Logger;
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
 * already covers this work — and otherwise the validated spec, so the caller goes on to
 * step 4.
 */
function openChecks(
  deps: ServerDeps,
  row: ResolvedCapabilityRow,
  shape: Extract<CallShape, { kind: 'open' }>,
): { readonly done: CallToolResult } | { readonly spec: HandoffSpec } {
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

  return { spec };
}

/**
 * `handoff_to_user` (§4.7.1, §5.2).
 *
 * Step 4 is the whole of this task: with no channel an open degrades to text mode (§5.9,
 * SRV-14) and a continue or a resume has nothing to work on, because the handoff's state
 * lives in the app. Step 5 — `handoff.open` / `handoff.continue` / `handoff.resume`, the
 * in-flight table and the wait — is T-020, and `NullChannel` is what keeps it out of reach
 * until then.
 */
function handoffToUser(
  deps: ServerDeps,
  row: ResolvedCapabilityRow,
  args: unknown,
): CallToolResult {
  const inferred = inferShape(args);
  if (!inferred.ok) return renderError(inferred.error);

  if (inferred.shape.kind === 'open') {
    const checked = openChecks(deps, row, inferred.shape);
    if ('done' in checked) return checked.done;
    if (!deps.channel.isConnected()) {
      return renderOutcome(textModeOutcome(checked.spec, hookVariant(row)), row);
    }
  }

  // TASK: T-020 — §5.2 step 5, the connected path. Unreachable while `NullChannel` is the
  // only `ChannelPort`: a call that gets here has no route to the state it needs, and
  // `APP_DISCONNECTED` is what §4.7.5 says to answer then.
  return renderError(catalogueError('APP_DISCONNECTED'));
}

/**
 * `handoff_verify` (§4.7.2): non-blocking, and nothing but a forward to the app, which
 * owns the handoff, its spec's `verify` and the states this call moves it between. Without
 * the channel there is nothing to check and nothing to record, so it answers what §4.7.5
 * reserves for exactly that (SRV-21).
 */
function handoffVerify(): CallToolResult {
  // TASK: T-020 — forward `handoff.verify` and render the outcome the app answers with.
  return renderError(catalogueError('APP_DISCONNECTED'));
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

// ------------------------------------------------------------------------ registration

/**
 * The MCP server, with the three tools registered and nothing connected yet.
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
  };

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: toolDefinitions() }));

  server.setRequestHandler(CallToolRequestSchema, (request) => {
    const { name, arguments: args } = request.params;
    const result = dispatch(deps, capabilityRow(), name, args);
    deps.logger.debug('tool_result', { method: name, ok: result.isError !== true });
    return result;
  });

  return server;
}

/** Routes one `tools/call`. An unknown name is a protocol error, not a catalogue error. */
function dispatch(
  deps: ServerDeps,
  row: ResolvedCapabilityRow,
  name: string,
  args: unknown,
): CallToolResult {
  switch (name) {
    case 'handoff_to_user':
      return handoffToUser(deps, row, args);
    case 'handoff_verify':
      return handoffVerify();
    case 'handoff_runbooks':
      return handoffRunbooks(deps, args);
    default:
      throw new McpError(ErrorCode.MethodNotFound, `this server has no tool named ${name}`);
  }
}

/**
 * `handoff-mcp serve`: the three tools over the stdio transport (§5.3, §5.12).
 *
 * Resolves when the agent closes stdin, which is how a stdio MCP server learns its client
 * has gone. The channel connection with its backoff, and the `session.bye` §5.3 asks for
 * on the way out, arrive with the client itself in T-018 and T-020.
 */
export async function serve(deps: ServerDeps): Promise<number> {
  for (const name of deps.config.ignored) {
    deps.logger.error('env_ignored', { env_var: name });
  }

  const server = createServer(deps);
  const closed = new Promise<void>((resolve) => {
    server.onclose = resolve;
  });

  await server.connect(new StdioServerTransport());
  deps.logger.debug('serve_started');
  await closed;
  return 0;
}

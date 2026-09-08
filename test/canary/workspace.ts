/**
 * The temporary project a canary run is executed in (T-023, TECHNICAL-DESIGN §11.5).
 *
 * Everything here is pure: it turns a scenario's requirements into the two JSON documents
 * Claude Code reads — the MCP configuration passed to `--mcp-config` and the project
 * `.claude/settings.json` — plus the environment the child process gets. That separation
 * is what lets the shapes be unit-tested in `test/unit/canary/` without a real agent, which
 * matters because a canary that fails for a malformed configuration says nothing about the
 * agent.
 *
 * Three rules are baked in rather than left to a caller:
 *
 * 1. **`HANDOFF_HOME` is always a temporary folder.** The probe writes its observations
 *    under it and the token file of a real installation lives there, so a canary must never
 *    be pointed at `~/.handoff/`.
 * 2. **`CLAUDECODE` is always cleared for the child.** Claude Code refuses to run nested
 *    inside another Claude Code session; the harness is normally started from one.
 * 3. **`HANDOFF_CANARY=1` is always in the server's `env` block**, because every scenario
 *    reads the observation file the probe writes.
 */
import { join } from 'node:path';

/** The name the MCP entry is registered under; the tools are `mcp__handoff__*`. */
export const MCP_SERVER_NAME = 'handoff';

/** What `--allowedTools` is given, so no tool outside our server can be used. */
export const ALLOWED_TOOLS = `mcp__${MCP_SERVER_NAME}__*`;

/**
 * The value written into `HANDOFF_PROBE` and `HANDOFF_PROBE_TOKEN` (A-23). Only the name
 * ever reaches an observation, so the value exists to be non-blank and nothing else.
 */
export const PROBE_ENV_VALUE = 'canary';

/** One MCP server entry as `--mcp-config` takes it. */
export interface McpServerEntry {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  /** A-04: the per-server timeout field, written only when the scenario measures it. */
  readonly timeout?: number;
}

export interface McpConfig {
  readonly mcpServers: Readonly<Record<string, McpServerEntry>>;
}

/** What a scenario may change about the way the server is declared and the agent is run. */
export interface WorkspaceOptions {
  /** Absolute path of the built bundle, `dist/handoff-mcp.cjs`. */
  readonly serverBundle: string;
  /** The temporary `HANDOFF_HOME` of this run. */
  readonly home: string;
  /** Absolute path of the recording Stop hook, or nothing to install no hook. */
  readonly stopHook?: string;
  /** A-03: `MCP_TOOL_TIMEOUT` in the settings `env` block, in milliseconds. */
  readonly mcpToolTimeoutMs?: number;
  /** A-04: the per-server `timeout` field of the MCP entry, in milliseconds. */
  readonly perServerTimeoutMs?: number;
  /** The agent id the installer would have written (A-02). */
  readonly agentId?: string;
}

/** `.claude/settings.json` of the temporary project. */
export interface ProjectSettings {
  readonly env?: Readonly<Record<string, string>>;
  readonly hooks?: {
    readonly Stop: readonly {
      readonly matcher: string;
      readonly hooks: readonly { readonly type: 'command'; readonly command: string }[];
    }[];
  };
}

/**
 * The MCP configuration `--mcp-config` is given.
 *
 * `node <bundle> serve` rather than the SEA binary: the bundle is what `pnpm build`
 * produces on every machine and in CI, and what the canary is about is the agent, not the
 * packaging. The `env` block carries `HANDOFF_AGENT` (A-02), the isolated `HANDOFF_HOME`,
 * the canary switch and the A-23 pair.
 */
export function mcpConfig(options: WorkspaceOptions): McpConfig {
  const entry: McpServerEntry = {
    command: process.execPath,
    args: [options.serverBundle, 'serve'],
    env: {
      HANDOFF_AGENT: options.agentId ?? 'claude-code',
      HANDOFF_HOME: options.home,
      HANDOFF_CANARY: '1',
      HANDOFF_PROBE: PROBE_ENV_VALUE,
      HANDOFF_PROBE_TOKEN: PROBE_ENV_VALUE,
    },
    ...(options.perServerTimeoutMs === undefined ? {} : { timeout: options.perServerTimeoutMs }),
  };
  return { mcpServers: { [MCP_SERVER_NAME]: entry } };
}

/**
 * `.claude/settings.json` of the temporary project: the `env` block A-03 is measured
 * through, and the recording Stop hook of A-05, A-06 and A-11.
 *
 * The hook command is `<node> <script>` with both paths quoted, because the hook runs
 * through a shell and either path can hold a space on Windows.
 */
export function projectSettings(options: WorkspaceOptions): ProjectSettings {
  const env: Record<string, string> = {};
  if (options.mcpToolTimeoutMs !== undefined) {
    env['MCP_TOOL_TIMEOUT'] = String(options.mcpToolTimeoutMs);
  }
  return {
    ...(Object.keys(env).length === 0 ? {} : { env }),
    ...(options.stopHook === undefined
      ? {}
      : {
          hooks: {
            Stop: [
              {
                matcher: '*',
                hooks: [
                  {
                    type: 'command' as const,
                    command: `"${process.execPath}" "${options.stopHook}"`,
                  },
                ],
              },
            ],
          },
        }),
  };
}

/**
 * The environment of the `claude` child.
 *
 * `CLAUDECODE` is removed rather than emptied: the harness is normally started from inside
 * a Claude Code session, and a nested one refuses to run. `HANDOFF_HOME` is exported for
 * the hook, which is spawned by the agent and inherits from here rather than from the MCP
 * entry's `env` block.
 */
export function childEnvironment(
  options: WorkspaceOptions,
  parent: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const child: Record<string, string> = {};
  for (const [name, value] of Object.entries(parent)) {
    if (value === undefined) continue;
    if (name === 'CLAUDECODE') continue;
    child[name] = value;
  }
  child['HANDOFF_HOME'] = options.home;
  child['HANDOFF_CANARY_HOOK_OUT'] = join(options.home, 'canary', 'hook.jsonl');
  return child;
}

/**
 * The `claude` command line of §11.5, with the two flags that version 2.1.263 requires and
 * the design text does not name: `--verbose`, without which `--output-format stream-json`
 * is refused outright, and `--model`, which pins the canary to one model so that a run is
 * comparable with the one before it.
 *
 * `--strict-mcp-config` is not optional and never becomes optional: without it the agent
 * loads every MCP server the user has configured, which on a real machine means their own
 * accounts.
 */
export function claudeArgs(options: {
  readonly prompt: string;
  readonly mcpConfig: string;
  readonly maxTurns: number;
  readonly model: string;
  readonly settingSources?: string;
}): string[] {
  return [
    '-p',
    options.prompt,
    '--mcp-config',
    options.mcpConfig,
    '--strict-mcp-config',
    '--allowedTools',
    ALLOWED_TOOLS,
    '--output-format',
    'stream-json',
    '--verbose',
    '--max-turns',
    String(options.maxTurns),
    '--model',
    options.model,
    ...(options.settingSources === undefined ? [] : ['--setting-sources', options.settingSources]),
  ];
}

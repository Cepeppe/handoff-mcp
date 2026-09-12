/**
 * The deterministic half of the Kilo Code canary (T-081, TECHNICAL-DESIGN §11.5).
 *
 * A Kilo run happens only on demand. What is tested here is what decides whether such a run
 * means anything: the command line, the inline configuration that declares our server, the
 * environment that keeps the user's own configuration out, how the native `kilo` is found past
 * its npm launcher, how Kilo's JSON events become the shared transcript, and the scenario set.
 */
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CAPABILITY_TABLE } from '../../../src/adapters';
import { parseScenario } from '../../fake-app';
import { CANARY_AGENTS, parseCanaryArguments } from '../../canary/cli.ts';
import { CODEX_SCENARIOS } from '../../canary/agents/codex/index.ts';
import { DEGRADED_PATH_SCRIPT } from '../../canary/agents/codex/degraded.ts';
import { KILO_DEGRADED_PATH_SCRIPT } from '../../canary/agents/kilo-code/degraded.ts';
import { KILO_SCENARIOS } from '../../canary/agents/kilo-code/index.ts';
import {
  kiloBinaryCandidates,
  kiloCommandFrom,
  kiloLauncherEnv,
  kiloPlatformPackages,
  type KiloPlatform,
} from '../../canary/agents/kilo-code/runner.ts';
import { kiloRow } from '../../canary/agents/kilo-code/scenario.ts';
import {
  KILO_DEFAULT_MODEL,
  KILO_DROPPED_PARENT_ENV,
  KILO_IMAGE_MODEL,
  KILO_ISOLATION_ENV,
  KILO_SESSION_TITLE,
  kiloArgs,
  kiloChildEnvironment,
  kiloConfig,
  kiloDeleteArgs,
  type KiloWorkspaceOptions,
} from '../../canary/agents/kilo-code/workspace.ts';
import { OPENCODE_SCENARIOS } from '../../canary/agents/opencode/index.ts';
import { parseOpenCodeEvents } from '../../canary/agents/opencode/runner.ts';
import { SCENARIOS } from '../../canary/scenarios/index.ts';

const workspace: KiloWorkspaceOptions = {
  serverBundle: 'C:\\repo\\dist\\handoff-mcp.cjs',
  home: 'C:\\temp\\run\\home',
  project: 'C:\\temp\\run\\project',
  configHome: 'C:\\temp\\run\\config',
};

describe('the kilo command line', () => {
  const args = kiloArgs({ prompt: 'do the thing', model: KILO_DEFAULT_MODEL });

  it('is kilo run printing JSON events, with the prompt last', () => {
    expect(args[0]).toBe('run');
    expect(args[args.indexOf('--format') + 1]).toBe('json');
    expect(args.at(-1)).toBe('do the thing');
  });

  it('loads no external plugin and keeps the prompt out of the session title', () => {
    expect(args).toContain('--pure');
    expect(args[args.indexOf('--title') + 1]).toBe(KILO_SESSION_TITLE);
  });

  it('runs on free models of the Kilo Gateway, so a canary spends nothing', () => {
    expect(args[args.indexOf('-m') + 1]).toBe(KILO_DEFAULT_MODEL);
    expect(KILO_DEFAULT_MODEL).toBe('kilo/kilo-auto/free');
    expect(KILO_IMAGE_MODEL).toMatch(/^kilo\/.+:free$/u);
  });

  it('deletes the run session by its id, since kilo run has no ephemeral mode', () => {
    expect(kiloDeleteArgs('ses_1')).toEqual(['session', 'delete', 'ses_1']);
  });
});

describe('the inline configuration that declares our server', () => {
  it('is one local server: node, the bundle and serve, with the five canary names', () => {
    expect(kiloConfig(workspace)).toEqual({
      mcp: {
        handoff: {
          type: 'local',
          command: [process.execPath, 'C:\\repo\\dist\\handoff-mcp.cjs', 'serve'],
          environment: {
            HANDOFF_AGENT: 'kilo-code',
            HANDOFF_HOME: 'C:\\temp\\run\\home',
            HANDOFF_CANARY: '1',
            HANDOFF_PROBE: 'canary',
            HANDOFF_PROBE_TOKEN: 'canary',
          },
        },
      },
    });
  });

  it('writes the timeout only when a scenario measures it, and in milliseconds', () => {
    expect(kiloConfig(workspace).mcp['handoff']).not.toHaveProperty('timeout');
    expect(kiloConfig({ ...workspace, timeoutMs: 20_000 }).mcp['handoff']?.timeout).toBe(20_000);
  });
});

describe('the environment of the kilo child', () => {
  const env = kiloChildEnvironment(workspace, {
    CLAUDECODE: '1',
    VSCODE_PID: '7000',
    WORKSPACE_FOLDER_PATHS: 'C:\\somewhere\\else',
    PATH: '/usr/bin',
    PWD: '/c/repo',
    HANDOFF_HOME: 'C:/real/.handoff',
    XDG_CONFIG_HOME: 'C:/real/.config',
    KILO_CONFIG: 'C:/mine/kilo.json',
    KILO_CONFIG_DIR: 'C:/mine',
    KILO_SERVER_PASSWORD: 'not ours',
    kilo_permission: '{"*":"allow"}',
    UNSET: undefined,
  });

  it('declares our server inline, so nothing is written where Kilo reads', () => {
    expect(JSON.parse(env['KILO_CONFIG_CONTENT'] ?? '')).toEqual(kiloConfig(workspace));
  });

  it('moves the global configuration to the run folder, which keeps the user servers out', () => {
    expect(env['XDG_CONFIG_HOME']).toBe(workspace.configHome);
  });

  it('points PWD at the run folder, because an OpenCode fork starts its servers from PWD', () => {
    expect(env['PWD']).toBe(workspace.project);
  });

  it('drops every KILO_ variable of the parent and sets the isolation switches', () => {
    expect(env).not.toHaveProperty('KILO_CONFIG');
    expect(env).not.toHaveProperty('KILO_CONFIG_DIR');
    expect(env).not.toHaveProperty('KILO_SERVER_PASSWORD');
    expect(env).not.toHaveProperty('kilo_permission');
    expect(KILO_ISOLATION_ENV).toMatchObject({
      KILO_DISABLE_PROJECT_CONFIG: '1',
      KILO_DISABLE_CLAUDE_CODE: '1',
      KILO_DISABLE_SHARE: '1',
      KILO_DISABLE_AUTOUPDATE: '1',
    });
    for (const [name, value] of Object.entries(KILO_ISOLATION_ENV)) {
      expect(env[name], name).toBe(value);
    }
  });

  it("drops the editor's pointers and CLAUDECODE, which Kilo would hand to the server", () => {
    // Kilo hands its whole environment to the servers it starts (T-080), so a harness run from
    // a shell inside an editor would otherwise start a server that looks for that editor.
    expect(KILO_DROPPED_PARENT_ENV).toEqual(['CLAUDECODE', 'VSCODE_PID', 'WORKSPACE_FOLDER_PATHS']);
    for (const name of KILO_DROPPED_PARENT_ENV) expect(env, name).not.toHaveProperty(name);
  });

  it('keeps the rest, and points HANDOFF_HOME at the run folder', () => {
    expect(env).not.toHaveProperty('UNSET');
    expect(env['PATH']).toBe('/usr/bin');
    expect(env['HANDOFF_HOME']).toBe(workspace.home);
  });
});

describe('the Kilo JSON transcript', () => {
  it("is OpenCode's: one event per line, our tools named <server>_<tool>", () => {
    const parsed = parseOpenCodeEvents([
      {
        line: '{"type":"tool_use","timestamp":2,"sessionID":"ses_k","part":{"type":"tool","tool":"handoff_handoff_runbooks","callID":"call_1","state":{"status":"completed","input":{"where":"w","goal":"g"},"output":"{\\"runbooks\\":[]}","time":{"start":10,"end":12}}}}',
      },
      {
        line: '{"type":"step_finish","timestamp":4,"sessionID":"ses_k","part":{"type":"step-finish","reason":"stop","tokens":{"input":100,"output":5},"cost":0}}',
      },
    ]);
    expect(parsed.sessionId).toBe('ses_k');
    expect(parsed.toolUses.map((use) => use.name)).toEqual(['mcp__handoff__handoff_runbooks']);
    expect(parsed.result?.is_error).toBe(false);
  });
});

describe('finding kilo', () => {
  const windows = (present: readonly string[] = []): KiloPlatform => ({
    windows: true,
    name: 'win32',
    arch: 'x64',
    exists: (path) => present.includes(path),
    realpath: (path) => path,
  });

  // Forward slashes: a Windows path with backslashes does not parse on the macOS leg (T-039).
  const cli = join('C:/npm', 'node_modules', '@kilocode', 'cli');
  const nested = join(cli, 'node_modules', '@kilocode', 'cli-windows-x64', 'bin', 'kilo.exe');
  const hoisted = join('C:/npm', 'node_modules', '@kilocode', 'cli-windows-x64', 'bin', 'kilo.exe');
  const baseline = join(
    cli,
    'node_modules',
    '@kilocode',
    'cli-windows-x64-baseline',
    'bin',
    'kilo.exe',
  );

  it('asks for the platform package the launcher asks for, then its baseline build', () => {
    expect(kiloPlatformPackages('win32', 'x64')).toEqual([
      'cli-windows-x64',
      'cli-windows-x64-baseline',
    ]);
    expect(kiloPlatformPackages('darwin', 'arm64')).toEqual(['cli-darwin-arm64']);
  });

  it('bypasses the npm shim for the native binary, where npm nests it', () => {
    // T-080: the server's parent is that binary, two generations below the shim.
    expect(kiloCommandFrom(['C:/npm/kilo', 'C:/npm/kilo.cmd'], windows([nested]))).toEqual({
      command: nested,
      shell: false,
    });
  });

  it('finds it hoisted as well, and falls back to the baseline build', () => {
    expect(kiloCommandFrom(['C:/npm/kilo.cmd'], windows([hoisted])).command).toBe(hoisted);
    expect(kiloCommandFrom(['C:/npm/kilo.cmd'], windows([baseline])).command).toBe(baseline);
    expect(kiloBinaryCandidates(join(cli, 'bin', 'kilo'), windows()).indexOf(nested)).toBeLessThan(
      kiloBinaryCandidates(join(cli, 'bin', 'kilo'), windows()).indexOf(baseline),
    );
  });

  it('uses the shim through a shell only when no binary is where npm puts it', () => {
    expect(kiloCommandFrom(['C:/npm/kilo.cmd'], windows())).toEqual({
      command: 'C:/npm/kilo.cmd',
      shell: true,
    });
  });

  it('starts a native executable directly, and asks PATH when nothing was found', () => {
    expect(kiloCommandFrom(['C:/Kilo/kilo.exe'], windows())).toEqual({
      command: 'C:/Kilo/kilo.exe',
      shell: false,
    });
    expect(kiloCommandFrom([], windows())).toEqual({ command: 'kilo', shell: true });
  });

  it('follows the symlink npm puts on PATH elsewhere, to the binary beside the launcher', () => {
    const launcher = join('/usr/local/lib/node_modules/@kilocode/cli', 'bin', 'kilo');
    const binary = join(
      '/usr/local/lib/node_modules/@kilocode/cli',
      'node_modules',
      '@kilocode',
      'cli-linux-arm64',
      'bin',
      'kilo',
    );
    const linux: KiloPlatform = {
      windows: false,
      name: 'linux',
      arch: 'arm64',
      exists: (path) => path === binary,
      realpath: () => launcher,
    };
    expect(kiloCommandFrom(['/usr/local/bin/kilo'], linux)).toEqual({
      command: binary,
      shell: false,
    });
  });

  it('points the binary at the tree-sitter resources beside it, as the launcher does', () => {
    const wasm = join('C:/k/bin', 'tree-sitter', 'tree-sitter.wasm');
    expect(
      kiloLauncherEnv(
        { command: join('C:/k/bin', 'kilo.exe'), shell: false },
        (path) => path === wasm,
      ),
    ).toEqual({ KILO_TREE_SITTER_WASM_DIR: join('C:/k/bin', 'tree-sitter') });
    expect(kiloLauncherEnv({ command: 'C:/npm/kilo.cmd', shell: true }, () => true)).toEqual({});
  });
});

describe('the Kilo Code scenario set', () => {
  it('is an agent of the canary command line', () => {
    expect(CANARY_AGENTS).toContain('kilo-code');
    expect(parseCanaryArguments(['--agent', 'kilo-code']).agent).toBe('kilo-code');
  });

  it('has ids of its own, prefixed kilo-code-, unique across every agent', () => {
    const ids = [...SCENARIOS, ...CODEX_SCENARIOS, ...OPENCODE_SCENARIOS, ...KILO_SCENARIOS].map(
      (scenario) => scenario.id,
    );
    expect(new Set(ids).size).toBe(ids.length);
    for (const scenario of KILO_SCENARIOS) expect(scenario.id).toMatch(/^kilo-code-/u);
  });

  it('gives each a prompt naming our server, what it covers, and a bounded run', () => {
    for (const scenario of KILO_SCENARIOS) {
      expect(scenario.options.prompt, scenario.id).toContain('MCP server handoff');
      expect(scenario.covers.length, scenario.id).toBeGreaterThan(0);
      expect(scenario.options.timeoutMs ?? 300_000, scenario.id).toBeLessThanOrEqual(330_000);
    }
  });

  it('covers E2E-8, the degraded path and the facts the kilo-code row is made of', () => {
    const covered = new Set(KILO_SCENARIOS.flatMap((scenario) => scenario.covers));
    for (const id of ['E2E-8', 'FM-03', 'FM-04', 'A-04', 'A-07', 'A-08', 'A-09', 'SRV-19']) {
      expect(covered.has(id), id).toBe(true);
    }
  });

  it('runs the image scenario, and only that one, on a model that reads images', () => {
    const pinned = KILO_SCENARIOS.filter((scenario) => scenario.options.model !== undefined);
    expect(pinned.map((scenario) => [scenario.id, scenario.options.model])).toEqual([
      ['kilo-code-image', KILO_IMAGE_MODEL],
    ]);
  });

  it('compares against the kilo-code row the server bundles, not a copy of it', () => {
    const row = CAPABILITY_TABLE.find((candidate) => candidate.agent_id === 'kilo-code');
    expect(kiloRow()).toEqual({
      client_names: row?.match.client_names,
      images_in_results: row?.images_in_results,
      stop_hook: row?.stop_hook,
      cancellation_notifications: row?.cancellation_notifications,
      tool_timeout_ms_default: row?.tool_timeout_ms_default,
    });
  });

  it('drives the overlay with the Codex script, under a name of its own', () => {
    expect(KILO_DEGRADED_PATH_SCRIPT.name).toBe('kilo-code-degraded-path');
    expect(KILO_DEGRADED_PATH_SCRIPT.actions).toEqual(DEGRADED_PATH_SCRIPT.actions);
    const scenario = parseScenario(
      {
        scenario: KILO_DEGRADED_PATH_SCRIPT.name,
        why: KILO_DEGRADED_PATH_SCRIPT.why,
        actions: KILO_DEGRADED_PATH_SCRIPT.actions,
      },
      KILO_DEGRADED_PATH_SCRIPT.name,
    );
    expect(scenario.send).toEqual([
      'onOpen',
      'awaitMessage',
      'onResume',
      'emitEvent',
      'onResume',
      'emitEvent',
    ]);
  });
});

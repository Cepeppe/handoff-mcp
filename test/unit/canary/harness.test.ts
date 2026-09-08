/**
 * The deterministic half of the canary harness (T-023, TECHNICAL-DESIGN §11.5).
 *
 * The canary itself needs a real agent and real money and therefore runs only when someone
 * asks for it (`pnpm canary`, `canary.yml`). What is tested here is everything that decides
 * whether such a run is *meaningful*: the configuration handed to Claude Code, the
 * environment its child gets, the command line, and the classifier that decides whether a
 * failure may be retried. A malformed MCP entry would make every canary fail for a reason
 * that has nothing to do with the agent, and nobody would notice until the report was read.
 */
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  classify,
  check,
  failures,
  note,
  reported,
  shouldRetry,
  type Assertion,
} from '../../canary/classify.ts';
import { REPO_ROOT, resolveServerBundle } from '../../canary/runner.ts';
import { coveredIds, SCENARIOS } from '../../canary/scenarios/index.ts';
import {
  childEnvironment,
  claudeArgs,
  mcpConfig,
  projectSettings,
  ALLOWED_TOOLS,
  MCP_SERVER_NAME,
  type WorkspaceOptions,
} from '../../canary/workspace.ts';

const workspace: WorkspaceOptions = {
  serverBundle: 'C:/repo/dist/handoff-mcp.cjs',
  home: 'C:/temp/run/home',
};

describe('the MCP configuration the agent is given', () => {
  const config = mcpConfig(workspace);
  const entry = config.mcpServers[MCP_SERVER_NAME];

  it('registers our server under the name the allowed-tools pattern matches', () => {
    expect(Object.keys(config.mcpServers)).toEqual([MCP_SERVER_NAME]);
    expect(ALLOWED_TOOLS).toBe(`mcp__${MCP_SERVER_NAME}__*`);
  });

  it('runs the built bundle with the current Node, and nothing else', () => {
    expect(entry?.command).toBe(process.execPath);
    expect(entry?.args).toEqual([workspace.serverBundle, 'serve']);
  });

  it('carries the canary switch, an isolated home and the A-23 pair in its env block', () => {
    expect(entry?.env).toEqual({
      HANDOFF_AGENT: 'claude-code',
      HANDOFF_HOME: 'C:/temp/run/home',
      HANDOFF_CANARY: '1',
      HANDOFF_PROBE: 'canary',
      HANDOFF_PROBE_TOKEN: 'canary',
    });
  });

  it('writes the per-server timeout field only when a scenario measures it (A-04)', () => {
    expect(entry).not.toHaveProperty('timeout');
    expect(
      mcpConfig({ ...workspace, perServerTimeoutMs: 20_000 }).mcpServers[MCP_SERVER_NAME]?.timeout,
    ).toBe(20_000);
  });
});

describe('the project settings', () => {
  it('are empty when a scenario asks for neither a timeout nor a hook', () => {
    expect(projectSettings(workspace)).toEqual({});
  });

  it('put MCP_TOOL_TIMEOUT in the env block, which is the mechanism A-03 is about', () => {
    expect(projectSettings({ ...workspace, mcpToolTimeoutMs: 20_000 }).env).toEqual({
      MCP_TOOL_TIMEOUT: '20000',
    });
  });

  it('declare the Stop hook with both paths quoted, because either can hold a space', () => {
    const settings = projectSettings({ ...workspace, stopHook: 'C:/Program Files/x/hook.mjs' });
    const command = settings.hooks?.Stop[0]?.hooks[0]?.command ?? '';
    expect(settings.hooks?.Stop[0]?.matcher).toBe('*');
    expect(command).toBe(`"${process.execPath}" "C:/Program Files/x/hook.mjs"`);
    expect(command.match(/"/gu)).toHaveLength(4);
  });
});

describe('the environment of the claude child', () => {
  const env = childEnvironment(workspace, {
    CLAUDECODE: '1',
    PATH: '/usr/bin',
    HANDOFF_HOME: 'C:/real/.handoff',
    UNSET: undefined,
  });

  it('clears CLAUDECODE, without which a nested run is refused outright', () => {
    expect(env).not.toHaveProperty('CLAUDECODE');
  });

  it('overrides HANDOFF_HOME with the run temporary, never the real one', () => {
    expect(env['HANDOFF_HOME']).toBe('C:/temp/run/home');
  });

  it('points the recording hook at the same run folder', () => {
    expect(env['HANDOFF_CANARY_HOOK_OUT']).toBe(join('C:/temp/run/home', 'canary', 'hook.jsonl'));
  });

  it('keeps the rest of the parent environment and drops what is unset', () => {
    expect(env['PATH']).toBe('/usr/bin');
    expect(env).not.toHaveProperty('UNSET');
  });
});

describe('the claude command line', () => {
  const args = claudeArgs({
    prompt: 'do the thing',
    mcpConfig: 'C:/temp/run/mcp.json',
    maxTurns: 6,
    model: 'sonnet',
  });

  it('is the invocation of §11.5, with the prompt in print mode', () => {
    expect(args.slice(0, 2)).toEqual(['-p', 'do the thing']);
    expect(args).toContain('--strict-mcp-config');
    expect(args).toContain('--allowedTools');
    expect(args[args.indexOf('--allowedTools') + 1]).toBe(ALLOWED_TOOLS);
    expect(args[args.indexOf('--max-turns') + 1]).toBe('6');
  });

  it('never omits --strict-mcp-config, which is what keeps a run off the user own servers', () => {
    for (const settingSources of [undefined, 'project']) {
      const line = claudeArgs({
        prompt: 'x',
        mcpConfig: 'c.json',
        maxTurns: 1,
        model: 'sonnet',
        ...(settingSources === undefined ? {} : { settingSources }),
      });
      expect(line).toContain('--strict-mcp-config');
    }
  });

  it('asks for stream-json with --verbose, which 2.1.263 refuses without', () => {
    expect(args[args.indexOf('--output-format') + 1]).toBe('stream-json');
    expect(args).toContain('--verbose');
  });

  it('pins the model, so two runs are comparable and the cost is bounded', () => {
    expect(args[args.indexOf('--model') + 1]).toBe('sonnet');
  });
});

describe('the classifier', () => {
  const ok = check('A-01', 'holds', 'protocol', true);
  const protocolFailure = check('A-02', 'fails', 'protocol', false);
  const modelFailure = check('model', 'fails', 'model', false);

  it('calls a run passed when nothing failed', () => {
    expect(classify([ok])).toBe('passed');
    expect(classify([])).toBe('passed');
  });

  it('calls it a protocol failure as soon as one protocol assertion failed', () => {
    expect(classify([ok, modelFailure, protocolFailure])).toBe('protocol');
  });

  it('calls it a model failure only when every failure is one', () => {
    expect(classify([ok, modelFailure])).toBe('model');
  });

  it('lets an informational failure pass the verdict but still be reported (A-09)', () => {
    const informational = note('A-09', 'not observed', false);
    expect(classify([ok, informational])).toBe('passed');
    expect(failures([ok, informational])).toEqual([]);
    expect(reported([ok, informational])).toEqual([informational]);
  });

  it('retries a model failure once and a protocol failure never', () => {
    expect(shouldRetry('model', 1)).toBe(true);
    expect(shouldRetry('model', 2)).toBe(false);
    expect(shouldRetry('protocol', 1)).toBe(false);
    expect(shouldRetry('passed', 1)).toBe(false);
  });

  it('reports protocol failures before model ones', () => {
    const list: Assertion[] = [modelFailure, protocolFailure];
    expect(failures(list).map((assertion) => assertion.kind)).toEqual(['protocol', 'model']);
  });
});

describe('the scenario set', () => {
  it('has unique ids and a prompt, a turn limit and a check for each', () => {
    expect(new Set(SCENARIOS.map((scenario) => scenario.id)).size).toBe(SCENARIOS.length);
    for (const scenario of SCENARIOS) {
      expect(scenario.options.prompt.length, scenario.id).toBeGreaterThan(20);
      expect(scenario.options.maxTurns, scenario.id).toBeLessThanOrEqual(12);
      expect(typeof scenario.check, scenario.id).toBe('function');
    }
  });

  it('covers every assumption of §11.5 that a server-alone run can reach', () => {
    // A-07 (images in results) and A-09's E2E rows need the overlay, and A-10 is manual.
    expect(coveredIds()).toEqual([
      'A-01',
      'A-02',
      'A-03',
      'A-04',
      'A-05',
      'A-06',
      'A-08',
      'A-09',
      'A-11',
      'A-23',
      'A-24',
      'E2E-8',
    ]);
  });

  it('keeps every scenario inside the turn budget the task Notes set', () => {
    const total = SCENARIOS.reduce((sum, scenario) => sum + scenario.options.maxTurns, 0);
    expect(total).toBeLessThanOrEqual(12 * SCENARIOS.length);
  });
});

describe('which bundle the canary runs', () => {
  const repoBundle = join(REPO_ROOT, 'dist', 'handoff-mcp.cjs');

  it('is the working tree by default', () => {
    expect(resolveServerBundle({})).toBe(repoBundle);
  });

  it('is what HANDOFF_CANARY_SERVER names, so a release can drive its own tarball', () => {
    const packed = join('C:', 'temp', 'pack', 'dist', 'handoff-mcp.cjs');
    expect(resolveServerBundle({ HANDOFF_CANARY_SERVER: packed })).toBe(packed);
    expect(resolveServerBundle({ HANDOFF_CANARY_SERVER: `  ${packed}  ` })).toBe(packed);
  });

  it('falls back when the variable is exported but empty', () => {
    // An empty value would otherwise register an MCP entry that runs nothing, and every
    // scenario would fail for a reason that has nothing to do with the agent.
    expect(resolveServerBundle({ HANDOFF_CANARY_SERVER: '' })).toBe(repoBundle);
    expect(resolveServerBundle({ HANDOFF_CANARY_SERVER: '   ' })).toBe(repoBundle);
  });
});

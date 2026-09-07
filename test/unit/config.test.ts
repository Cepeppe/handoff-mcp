/**
 * Configuration from the environment (TECHNICAL-DESIGN §5.12, §5.3).
 *
 * Every case passes its own environment record: the real `process.env` is never read or
 * mutated here, so the suite says the same thing on a developer machine that happens to
 * have `HANDOFF_HOME` set and on a runner that does not.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ENV_VAR_NAMES, homeDir, readConfig, type EnvRecord } from '../../src/config';

const CWD = join('C', 'dev', 'shop');

function config(env: EnvRecord) {
  return readConfig(env, CWD);
}

describe('the declared variables', () => {
  it('are the six of §5.3, in that order', () => {
    expect(ENV_VAR_NAMES).toEqual([
      'HANDOFF_AGENT',
      'HANDOFF_TOOL_TIMEOUT_MS',
      'MCP_TOOL_TIMEOUT',
      'HANDOFF_HOME',
      'CLAUDE_PROJECT_DIR',
      'HANDOFF_MCP_LOG',
    ]);
  });
});

describe('an empty environment', () => {
  const cfg = config({});

  it('reads nothing and reports nothing ignored', () => {
    expect(cfg.agent).toBeUndefined();
    expect(cfg.toolTimeoutMs).toBeUndefined();
    expect(cfg.mcpToolTimeoutMs).toBeUndefined();
    expect(cfg.ignored).toEqual([]);
  });

  it('defaults the home to ~/.handoff and the project to the working directory', () => {
    expect(cfg.home).toBe(join(homedir(), '.handoff'));
    expect(cfg.projectDir).toBe(CWD);
  });

  it('defaults the log level to error', () => {
    expect(cfg.logLevel).toBe('error');
  });
});

describe('homeDir', () => {
  it('is HANDOFF_HOME when set', () => {
    expect(homeDir({ HANDOFF_HOME: '/tmp/handoff-test' })).toBe('/tmp/handoff-test');
  });

  it('is ~/.handoff when it is unset or blank', () => {
    const fallback = join(homedir(), '.handoff');
    expect(homeDir({})).toBe(fallback);
    expect(homeDir({ HANDOFF_HOME: '   ' })).toBe(fallback);
  });
});

describe('the project folder (A-24)', () => {
  it('is CLAUDE_PROJECT_DIR when the agent sets it', () => {
    expect(config({ CLAUDE_PROJECT_DIR: '/Users/g/dev/shop' }).projectDir).toBe(
      '/Users/g/dev/shop',
    );
  });

  it('falls back to the working directory, which is what SRV-18 keys on', () => {
    expect(config({ CLAUDE_PROJECT_DIR: '' }).projectDir).toBe(CWD);
  });
});

describe('durations', () => {
  it('reads both timeout variables as milliseconds', () => {
    const cfg = config({ HANDOFF_TOOL_TIMEOUT_MS: '1800000', MCP_TOOL_TIMEOUT: ' 900000 ' });
    expect(cfg.toolTimeoutMs).toBe(1_800_000);
    expect(cfg.mcpToolTimeoutMs).toBe(900_000);
    expect(cfg.ignored).toEqual([]);
  });

  it('ignores a value that is not a positive whole number of milliseconds', () => {
    for (const value of ['0', '-1', '30s', '1.5', '1e6', '30 000', 'abc', '99999999999999999999']) {
      const cfg = config({ HANDOFF_TOOL_TIMEOUT_MS: value });
      expect(cfg.toolTimeoutMs, value).toBeUndefined();
      expect(cfg.ignored, value).toEqual(['HANDOFF_TOOL_TIMEOUT_MS']);
    }
  });

  it('treats a blank value as unset rather than as a mistake', () => {
    const cfg = config({ HANDOFF_TOOL_TIMEOUT_MS: '  ' });
    expect(cfg.toolTimeoutMs).toBeUndefined();
    expect(cfg.ignored).toEqual([]);
  });

  it('reports each bad variable once, in the order they are read', () => {
    const cfg = config({
      HANDOFF_TOOL_TIMEOUT_MS: 'x',
      MCP_TOOL_TIMEOUT: 'y',
      HANDOFF_MCP_LOG: 'z',
    });
    expect(cfg.ignored).toEqual(['HANDOFF_TOOL_TIMEOUT_MS', 'MCP_TOOL_TIMEOUT', 'HANDOFF_MCP_LOG']);
  });
});

describe('the agent id', () => {
  it('is taken as written, trimmed', () => {
    expect(config({ HANDOFF_AGENT: ' claude-code ' }).agent).toBe('claude-code');
  });

  it('is undefined when blank, so resolution moves to the handshake', () => {
    expect(config({ HANDOFF_AGENT: '' }).agent).toBeUndefined();
  });
});

describe('the log level', () => {
  it('accepts the two levels of §5.12, in any case', () => {
    expect(config({ HANDOFF_MCP_LOG: 'debug' }).logLevel).toBe('debug');
    expect(config({ HANDOFF_MCP_LOG: 'DEBUG' }).logLevel).toBe('debug');
    expect(config({ HANDOFF_MCP_LOG: 'error' }).logLevel).toBe('error');
  });

  it('falls back to error on anything else, and says so', () => {
    const cfg = config({ HANDOFF_MCP_LOG: 'trace' });
    expect(cfg.logLevel).toBe('error');
    expect(cfg.ignored).toEqual(['HANDOFF_MCP_LOG']);
  });
});

describe('reading is pure', () => {
  it('does not mutate the environment it was given', () => {
    const env = { HANDOFF_AGENT: 'codex', HANDOFF_MCP_LOG: 'debug' };
    config(env);
    expect(env).toEqual({ HANDOFF_AGENT: 'codex', HANDOFF_MCP_LOG: 'debug' });
  });
});

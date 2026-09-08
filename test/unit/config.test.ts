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

import {
  ENV_VAR_NAMES,
  envNamesPresent,
  homeDir,
  homeOverride,
  readConfig,
  windowsUserKey,
  type EnvRecord,
} from '../../src/config';

const CWD = join('C', 'dev', 'shop');

function config(env: EnvRecord) {
  return readConfig(env, CWD);
}

describe('the declared variables', () => {
  it('are the six of §5.3 in that order, the canary switch, then the two Windows names the pipe is built from', () => {
    expect(ENV_VAR_NAMES).toEqual([
      'HANDOFF_AGENT',
      'HANDOFF_TOOL_TIMEOUT_MS',
      'MCP_TOOL_TIMEOUT',
      'HANDOFF_HOME',
      'CLAUDE_PROJECT_DIR',
      'HANDOFF_MCP_LOG',
      'HANDOFF_CANARY',
      'USERDOMAIN',
      'USERNAME',
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

describe('the Windows identity the pipe is named after', () => {
  it('is USERDOMAIN\\USERNAME in lower case (§5.8, DD-26)', () => {
    expect(windowsUserKey({ USERDOMAIN: 'ACME', USERNAME: 'Giuse' })).toBe('acme\\giuse');
  });

  it('lets a variable that is not set contribute an empty string, never a substitute', () => {
    // The app derives the same name from the same two variables; a fallback taken from
    // somewhere else on one side would move the endpoint out from under the other.
    expect(windowsUserKey({})).toBe('\\');
    expect(windowsUserKey({ USERNAME: 'Giuse' })).toBe('\\giuse');
    expect(windowsUserKey({ USERDOMAIN: '  ', USERNAME: 'giuse' })).toBe('\\giuse');
  });
});

describe('the home override', () => {
  it('is the trimmed value of HANDOFF_HOME, and the folder agrees with it', () => {
    expect(homeOverride({ HANDOFF_HOME: '  /tmp/h  ' })).toBe('/tmp/h');
    expect(homeDir({ HANDOFF_HOME: '  /tmp/h  ' })).toBe('/tmp/h');
  });

  it('is undefined when the variable is unset or blank', () => {
    expect(homeOverride({})).toBeUndefined();
    expect(homeOverride({ HANDOFF_HOME: '   ' })).toBeUndefined();
  });
});

describe('the canary switch', () => {
  it('is off unless HANDOFF_CANARY is exactly 1', () => {
    expect(config({}).canary).toBe(false);
    expect(config({ HANDOFF_CANARY: '0' }).canary).toBe(false);
    expect(config({ HANDOFF_CANARY: 'true' }).canary).toBe(false);
    expect(config({ HANDOFF_CANARY: '' }).canary).toBe(false);
    expect(config({ HANDOFF_CANARY: ' 1 ' }).canary).toBe(true);
    expect(config({ HANDOFF_CANARY: '1' }).canary).toBe(true);
  });
});

describe('the presence lookup the canary probe uses (A-23)', () => {
  const env: EnvRecord = { HANDOFF_PROBE: 'yes', HANDOFF_PROBE_TOKEN: ' ', CLAUDECODE: '1' };

  it('answers with the names that are set, in the order it was asked', () => {
    expect(envNamesPresent(['CLAUDECODE', 'HANDOFF_PROBE', 'HANDOFF_PROBE_TOKEN'], env)).toEqual([
      'CLAUDECODE',
      'HANDOFF_PROBE',
    ]);
  });

  it('never answers with a value, whatever the variable holds', () => {
    const answer = envNamesPresent(['HANDOFF_PROBE'], { HANDOFF_PROBE: 'sk_live_secret' });
    expect(answer).toEqual(['HANDOFF_PROBE']);
    expect(JSON.stringify(answer)).not.toContain('sk_live');
  });

  it('treats an unset or blank variable as absent', () => {
    expect(envNamesPresent(['NOTHING_HERE'], env)).toEqual([]);
    expect(envNamesPresent(['HANDOFF_PROBE_TOKEN'], env)).toEqual([]);
  });
});

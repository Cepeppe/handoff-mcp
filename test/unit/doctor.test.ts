/**
 * What `doctor` prints, and what it calls a problem (TECHNICAL-DESIGN §5.12, §5.8, §5.10).
 *
 * The report itself — a real endpoint, a real fake app, a temporary `HANDOFF_HOME` — is
 * `test/integration/doctor.test.ts`. What this file pins is the half that has to be right
 * whatever the machine says: the four shapes the channel line can take, the mode warning,
 * and which of the findings are worth an exit code. The rule behind that last one is the
 * one worth restating: an app that is not running is **not** a fault (SRV-14, text mode is
 * a supported way to work), while anything the user has to repair is.
 */
import { describe, expect, it } from 'vitest';

import { heartbeatAfterMs, resolveCapabilityRow, resolveToolTimeout } from '../../src/adapters';
import {
  renderDoctorReport,
  type DoctorChannel,
  type DoctorReport,
  type DoctorRunbooks,
  type DoctorToken,
} from '../../src/doctor';

const ROW = resolveCapabilityRow({ agent: 'claude-code' });
const TOKEN = 'c0ffee11d0d0f00d1234567890abcdef00112233445566778899aabbccddeeff';

const OK_TOKEN: DoctorToken = {
  path: '/home/g/.handoff/channel.token',
  status: 'ok',
  mode: '0600',
  loose: false,
};

const OK_RUNBOOKS: DoctorRunbooks = { path: '/home/g/.handoff/runbooks', status: 'ok', count: 3 };

const REACHABLE: DoctorChannel = {
  endpoint: '/home/g/.handoff/app.sock',
  status: 'reachable',
  app_version: '1.0.0',
  session_ref: 'ses_2b9x4d7f',
};

/** A report with everything healthy, which a case then spoils in exactly one place. */
function report(overrides: Partial<DoctorReport> = {}): DoctorReport {
  const base: DoctorReport = {
    server: {
      version: '0.1.0',
      protocol_version: 1,
      capabilities_version: 1,
      node: 'v24.18.0',
      platform: 'linux x64',
      home: '/home/g/.handoff',
      log_level: 'error',
      ignored: [],
    },
    agent: {
      row: ROW,
      timeout: resolveToolTimeout(ROW, {}),
      heartbeat_after_ms: heartbeatAfterMs(ROW, {}),
      requested: 'claude-code',
    },
    token: OK_TOKEN,
    channel: REACHABLE,
    runbooks: OK_RUNBOOKS,
    problems: [],
  };
  return { ...base, ...overrides };
}

function text(value: DoctorReport): string {
  return renderDoctorReport(value).join('\n');
}

describe('the report', () => {
  it('has one section per question support asks, in order', () => {
    const lines = renderDoctorReport(report());
    expect(lines.filter((line) => /^\S/u.test(line) && line !== '')).toEqual([
      'server',
      'agent',
      'token',
      'channel',
      'runbooks',
      'doctor: nothing to repair',
    ]);
  });

  it('never prints the token, whatever the file holds', () => {
    const printed = text(report());
    expect(printed).not.toContain(TOKEN);
    expect(printed).toContain('/home/g/.handoff/channel.token');
    expect(printed).toContain('status');
  });

  it('prints the resolved row and where the timeout came from', () => {
    const printed = text(report());
    expect(printed).toContain(`agent_id                   ${ROW.agent_id}`);
    expect(printed).toContain('resolved_from              HANDOFF_AGENT');
    expect(printed).toContain(`heartbeat_after_ms         ${String(heartbeatAfterMs(ROW, {}))}`);
    expect(printed).toMatch(/tool_timeout_ms\s+(unknown \(none\)|\d+ \(table\))/u);
  });

  it('says the unknown row was the fallback when nothing named an agent', () => {
    const unknown = resolveCapabilityRow({});
    const printed = text(
      report({
        agent: {
          row: unknown,
          timeout: resolveToolTimeout(unknown, {}),
          heartbeat_after_ms: heartbeatAfterMs(unknown, {}),
          requested: undefined,
        },
      }),
    );
    expect(printed).toContain('resolved_from              the unknown row');
  });

  it('names the environment variables that were ignored, and only when there are any', () => {
    expect(text(report())).not.toContain('ignored');
    const spoiled = report({
      server: { ...report().server, ignored: ['HANDOFF_TOOL_TIMEOUT_MS'] },
    });
    expect(text(spoiled)).toContain('ignored                    HANDOFF_TOOL_TIMEOUT_MS');
  });
});

describe('the channel line', () => {
  it('reports a registration with the app version and the session it was given', () => {
    const printed = text(report());
    expect(printed).toContain('status                     reachable');
    expect(printed).toContain('app_version                1.0.0');
    expect(printed).toContain('session_ref                ses_2b9x4d7f');
  });

  it('reports an app that is not running as normal, not as a fault (SRV-14)', () => {
    const value = report({
      channel: { endpoint: '/home/g/.handoff/app.sock', status: 'unreachable', reason: 'ENOENT' },
    });
    expect(text(value)).toContain('status                     not reachable (ENOENT)');
    expect(text(value)).toContain('degrades to text mode');
    expect(value.problems).toEqual([]);
  });

  it('reports a refusal with the code of the error catalogue (FM-10, FM-11)', () => {
    for (const failure of ['CHANNEL_AUTH_FAILED', 'PROTOCOL_MISMATCH'] as const) {
      const value = report({
        channel: { endpoint: '/home/g/.handoff/app.sock', status: 'refused', failure },
      });
      expect(text(value)).toContain(`status                     refused (${failure})`);
    }
  });

  it('says why it did not even try when the token is unusable', () => {
    const value = report({
      channel: {
        endpoint: '/home/g/.handoff/app.sock',
        status: 'not_probed',
        reason: 'the token file is missing',
      },
    });
    expect(text(value)).toContain(
      'status                     not probed (the token file is missing)',
    );
  });
});

describe('the token line', () => {
  it('says nothing about the mode when it is exactly 0600', () => {
    expect(text(report())).toContain('mode                       0600');
  });

  it('marks a mode another user of the machine could read (§5.8)', () => {
    const value = report({ token: { ...OK_TOKEN, mode: '0644', loose: true } });
    expect(text(value)).toContain('mode                       0644 (wider than 0600)');
    // A loose mode is a warning, never a refusal: the property protected is the app's.
    expect(value.problems).toEqual([]);
  });

  it('prints the platform placeholder where there is no POSIX mode', () => {
    expect(text(report({ token: { ...OK_TOKEN, mode: '-' } }))).toContain(
      'mode                       -',
    );
  });
});

describe('the last lines', () => {
  it('are one problem each, so a pasted report ends with what to repair', () => {
    const value = report({ problems: ['the first thing', 'the second thing'] });
    const lines = renderDoctorReport(value);
    expect(lines.slice(-2)).toEqual(['problem: the first thing', 'problem: the second thing']);
  });

  it('are the all-clear when there is nothing to repair', () => {
    expect(renderDoctorReport(report()).at(-1)).toBe('doctor: nothing to repair');
  });
});

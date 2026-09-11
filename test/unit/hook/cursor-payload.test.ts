/**
 * What `handoff-mcp hook stop` does with the payload Cursor hands a stop hook (T-069).
 *
 * Cursor runs Claude Code's `Stop` hooks as its own (T-068), so on a machine with the Claude
 * Code adapter installed this subcommand is handed a Cursor payload at the end of a Cursor turn.
 * The shape below is the one the Cursor Agent CLI 2026.09.10-fd3934a builds for a `stop` hook
 * (read from its code, `docs/agent-facts.md`): no `stop_hook_active`, and an event name in
 * Cursor's spelling. The hook answers it neutrally and silently, before it reads the token or
 * opens anything — measured with the built bundle too — so a hook written for another agent
 * never blocks a Cursor turn, and never asks it to continue.
 */
import { describe, expect, it } from 'vitest';

import { parseHookInput, runHookStop } from '../../../src/hook/stop';

const CURSOR_STOP_PAYLOAD = {
  conversation_id: 'c-1',
  generation_id: 'g-1',
  model: 'auto',
  status: 'completed',
  loop_count: 0,
  input_tokens: 10,
  output_tokens: 2,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  session_id: 'c-1',
  hook_event_name: 'stop',
  cursor_version: '3.20.10',
  workspace_roots: ['/work/shop'],
  user_email: 'someone@example.com',
  transcript_path: '/tmp/transcript.jsonl',
};

describe('a Cursor stop payload', () => {
  it('is not a hook input this subcommand forwards, in either spelling of the event', () => {
    expect(parseHookInput(JSON.stringify(CURSOR_STOP_PAYLOAD))).toBeUndefined();
    expect(
      parseHookInput(JSON.stringify({ ...CURSOR_STOP_PAYLOAD, hook_event_name: 'Stop' })),
    ).toBeUndefined();
  });

  it('is answered neutrally before the token is read or anything is opened', async () => {
    const touched: string[] = [];
    const lines: string[] = [];
    const code = await runHookStop({
      out: (line) => lines.push(line),
      readInput: () =>
        Promise.resolve(JSON.stringify({ ...CURSOR_STOP_PAYLOAD, hook_event_name: 'Stop' })),
      token: () => {
        touched.push('token');
        return { ok: false, problem: 'missing' };
      },
      identity: () => {
        touched.push('identity');
        return Promise.resolve({ pid: 1, ppid: 0, ancestors: [] });
      },
      connect: () => {
        touched.push('connect');
        throw new Error('nothing may be opened for a payload the hook cannot read');
      },
      hardExit: () => {
        touched.push('hard exit');
      },
    });
    expect(code).toBe(0);
    expect(lines).toEqual([]);
    expect(touched).toEqual([]);
  });

  it('is refused for what it lacks: the same payload with stop_hook_active is read', () => {
    expect(
      parseHookInput(
        JSON.stringify({
          ...CURSOR_STOP_PAYLOAD,
          hook_event_name: 'Stop',
          stop_hook_active: false,
        }),
      )?.hook.session_id,
    ).toBe('c-1');
  });
});

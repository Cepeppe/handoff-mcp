/**
 * How the Cursor canary reads the duration of a call from the CLI's side (T-069).
 *
 * Cursor stamps a call itself — `startedAtMs` and `completedAtMs` on the completed `tool_call`
 * event, as strings, since they are 64-bit in its protocol (measured on the CLI
 * 2026.09.10-fd3934a) — and those are read first. The stamps of the `started` and `completed`
 * events are the fallback, for a completed event that carries none.
 */
import { describe, expect, it } from 'vitest';

import { toolCallDurationMs } from '../../canary/agents/cursor/scenario.ts';
import type { CanaryRun, TranscriptMessage } from '../../canary/runner.ts';

const SLEEP = {
  name: 'handoff-sleep_ms',
  args: { ms: 90_000 },
  providerIdentifier: 'handoff',
  toolName: 'sleep_ms',
};

function runOf(transcript: TranscriptMessage[]): CanaryRun {
  return {
    exitCode: 0,
    durationMs: 0,
    timedOut: false,
    stderr: '',
    transcript,
    observations: [],
    hookRecords: [],
    toolUses: [],
    toolResults: [],
    result: undefined,
    workspace: '',
  };
}

describe('the duration of a call as the CLI saw it', () => {
  it("is Cursor's own stamps on the completed event, which arrive as strings", () => {
    const run = runOf([
      {
        type: 'tool_call',
        subtype: 'completed',
        call_id: 'c',
        timestamp_ms: 9_000_000,
        tool_call: {
          mcpToolCall: {
            args: SLEEP,
            result: { error: { error: 'MCP error -32001: Request timed out' } },
          },
          startedAtMs: '1789123730324',
          completedAtMs: '1789123790330',
        },
      },
    ]);
    expect(toolCallDurationMs(run, 'sleep_ms')).toBe(60_006);
  });

  it('falls back to the stamps of the started and completed events', () => {
    const run = runOf([
      {
        type: 'tool_call',
        subtype: 'started',
        call_id: 'c',
        timestamp_ms: 1_000,
        tool_call: { mcpToolCall: { args: SLEEP } },
      },
      {
        type: 'tool_call',
        subtype: 'completed',
        call_id: 'c',
        timestamp_ms: 61_000,
        tool_call: { mcpToolCall: { args: SLEEP, result: { success: { content: [] } } } },
      },
    ]);
    expect(toolCallDurationMs(run, 'sleep_ms')).toBe(60_000);
  });

  it('is unknown with no stamps at all, and for a call of another tool', () => {
    const run = runOf([
      {
        type: 'tool_call',
        subtype: 'completed',
        call_id: 'c',
        tool_call: { mcpToolCall: { args: SLEEP, result: { success: { content: [] } } } },
      },
    ]);
    expect(toolCallDurationMs(run, 'sleep_ms')).toBeUndefined();
    expect(toolCallDurationMs(run, 'image_probe')).toBeUndefined();
  });
});

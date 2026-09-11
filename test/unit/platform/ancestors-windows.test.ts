/**
 * The Windows walk of T-069 (TECHNICAL-DESIGN §5.8, DD-22).
 *
 * DD-22 keeps Windows spawn-free, and `ancestors.test.ts` still pins that for every caller
 * that does not ask. A server an editor may have started asks: its session identity is
 * decided from the names in its chain (`src/adapters/editor.ts`), so it pays one PowerShell
 * query. The listing below is the shape that query prints, trimmed to the chain of the server
 * Cursor's editor started on the machine the rule was measured on, with Windows line ends.
 */
import { describe, expect, it } from 'vitest';

import {
  POWERSHELL_ARGS,
  POWERSHELL_COMMAND,
  WINDOWS_ANCESTOR_TIMEOUT_MS,
  resolveProcessIdentity,
  type CommandRunner,
} from '../../../src/platform/ancestors';

const LISTING = [
  '0 0 System Idle Process',
  '19248 19100 explorer.exe',
  '41452 19248 Cursor.exe',
  '28392 41452 Cursor.exe',
  '19916 28392 node.exe',
  '',
].join('\r\n');

function runner(output: string, calls: unknown[][] = []): CommandRunner {
  return (command, args, timeoutMs) => {
    calls.push([command, [...args], timeoutMs]);
    return Promise.resolve(output);
  };
}

describe('the Windows walk', () => {
  it('climbs the chain from one PowerShell query when a server asks for it', async () => {
    const calls: unknown[][] = [];
    const identity = await resolveProcessIdentity({
      platform: 'win32',
      pid: 19916,
      ppid: 28392,
      windowsChain: true,
      run: runner(LISTING, calls),
    });
    expect(identity).toEqual({
      pid: 19916,
      ppid: 28392,
      ancestors: [
        { pid: 28392, name: 'Cursor.exe' },
        { pid: 41452, name: 'Cursor.exe' },
        { pid: 19248, name: 'explorer.exe' },
      ],
    });
    expect(calls).toEqual([
      [POWERSHELL_COMMAND, [...POWERSHELL_ARGS], WINDOWS_ANCESTOR_TIMEOUT_MS],
    ]);
  });

  it('is pid and ppid alone when PowerShell fails or is killed by the cap', async () => {
    const identity = await resolveProcessIdentity({
      platform: 'win32',
      pid: 19916,
      ppid: 28392,
      windowsChain: true,
      run: () => Promise.reject(new Error('killed')),
    });
    expect(identity).toEqual({ pid: 19916, ppid: 28392, ancestors: [] });
  });

  it('takes the cap it is given', async () => {
    const calls: unknown[][] = [];
    await resolveProcessIdentity({
      platform: 'win32',
      pid: 19916,
      ppid: 28392,
      windowsChain: true,
      windowsTimeoutMs: 1234,
      run: runner(LISTING, calls),
    });
    expect(calls[0]?.[2]).toBe(1234);
  });

  it('spawns nothing unless it is asked to, so the hook stays spawn-free (DD-22)', async () => {
    const identity = await resolveProcessIdentity({
      platform: 'win32',
      pid: 19916,
      ppid: 28392,
      run: () => {
        throw new Error('nothing may be spawned on Windows unless asked');
      },
    });
    expect(identity).toEqual({ pid: 19916, ppid: 28392, ancestors: [] });
  });

  it('asks for the three columns ps prints, from a PowerShell that loads no profile', () => {
    expect(POWERSHELL_COMMAND).toBe('powershell.exe');
    expect(POWERSHELL_ARGS.slice(0, 2)).toEqual(['-NoProfile', '-NonInteractive']);
    expect(POWERSHELL_ARGS.at(-1)).toContain('Get-CimInstance Win32_Process');
    expect(POWERSHELL_ARGS.at(-1)).toContain('$($_.ProcessId) $($_.ParentProcessId) $($_.Name)');
  });

  it.runIf(process.platform === 'win32')(
    'walks the real chain on Windows, nearest parent first',
    async () => {
      const identity = await resolveProcessIdentity({ windowsChain: true });
      expect(identity.ancestors[0]?.pid).toBe(process.ppid);
      expect(identity.ancestors.every((ancestor) => ancestor.name !== '')).toBe(true);
    },
    20_000,
  );
});

/**
 * The ancestor chain (TECHNICAL-DESIGN §5.8, DD-22, SRV-17, SRV-19).
 *
 * `ps-macos.txt` is a `ps -axo pid=,ppid=,comm=` listing in the layout macOS prints —
 * right-aligned columns, the full executable path as the command — around the process tree
 * the design's own example uses (§6.4: node under node under zsh under iTerm2). It is
 * written by hand rather than captured, because the machine that runs this suite is a
 * Windows one; it carries the two shapes that break a naive parser, a command with spaces
 * in it and a chain that ends at `launchd`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  ANCESTOR_TIMEOUT_MS,
  PS_ARGS,
  PS_COMMAND,
  ancestorChain,
  parseProcStatus,
  parseProcessTable,
  resolveProcessIdentity,
  type CommandRunner,
} from '../../../src/platform/ancestors';

const PS_OUTPUT = readFileSync(fileURLToPath(new URL('./ps-macos.txt', import.meta.url)), 'utf8');

/** The chain of the server process of the fixture, nearest parent first. */
const CHAIN = [
  { pid: 48190, name: 'node' },
  { pid: 9120, name: 'zsh' },
  { pid: 9100, name: 'iTerm2' },
  { pid: 1, name: 'launchd' },
];

describe('parsing a ps listing', () => {
  const table = parseProcessTable(PS_OUTPUT);

  it('reads every row of the fixture', () => {
    expect(table.size).toBe(8);
  });

  it('keeps the last segment of the command, as §6.4 prints it', () => {
    expect(table.get(9100)).toEqual({ ppid: 1, name: 'iTerm2' });
    expect(table.get(48211)).toEqual({ ppid: 48190, name: 'node' });
  });

  it('takes a command with spaces in it whole', () => {
    expect(table.get(512)).toEqual({ ppid: 1, name: 'Helper Daemon' });
  });

  it('skips anything that is not two integers and a command', () => {
    const noise = parseProcessTable('  PID  PPID COMM\nps: some warning\n\n  7   1 /bin/sh\n');
    expect([...noise.keys()]).toEqual([7]);
  });
});

describe('walking the chain', () => {
  const table = parseProcessTable(PS_OUTPUT);

  it('starts at the parent and climbs to the root', () => {
    expect(ancestorChain(table, 48211)).toEqual(CHAIN);
  });

  it('never puts the process itself in its own chain', () => {
    expect(ancestorChain(table, 48211).some((entry) => entry.pid === 48211)).toBe(false);
  });

  it('is empty for a pid the table does not know', () => {
    expect(ancestorChain(table, 99999)).toEqual([]);
  });

  it('stops at the depth cap', () => {
    expect(ancestorChain(table, 48211, 2)).toEqual(CHAIN.slice(0, 2));
  });

  it('cannot loop on a table that contains a cycle', () => {
    const cycle = new Map([
      [5, { ppid: 6, name: 'a' }],
      [6, { ppid: 5, name: 'b' }],
    ]);
    expect(ancestorChain(cycle, 5)).toEqual([{ pid: 6, name: 'b' }]);
  });
});

describe('the identity this platform can state', () => {
  const runner = (output: string, calls: unknown[][] = []): CommandRunner => {
    return (command, args, timeoutMs) => {
      calls.push([command, [...args], timeoutMs]);
      return Promise.resolve(output);
    };
  };

  it('is one capped ps spawn on macOS', async () => {
    const calls: unknown[][] = [];
    const identity = await resolveProcessIdentity({
      platform: 'darwin',
      pid: 48211,
      ppid: 48190,
      run: runner(PS_OUTPUT, calls),
    });
    expect(identity).toEqual({ pid: 48211, ppid: 48190, ancestors: CHAIN });
    expect(calls).toEqual([[PS_COMMAND, [...PS_ARGS], ANCESTOR_TIMEOUT_MS]]);
  });

  it('is pid and ppid alone when ps fails or is killed by the cap', async () => {
    const identity = await resolveProcessIdentity({
      platform: 'darwin',
      pid: 48211,
      ppid: 48190,
      run: () => Promise.reject(new Error('killed')),
    });
    expect(identity).toEqual({ pid: 48211, ppid: 48190, ancestors: [] });
  });

  it('spawns nothing at all on Windows (DD-22)', async () => {
    const identity = await resolveProcessIdentity({
      platform: 'win32',
      pid: 4821,
      ppid: 4819,
      run: () => {
        throw new Error('nothing may be spawned on Windows');
      },
    });
    expect(identity).toEqual({ pid: 4821, ppid: 4819, ancestors: [] });
  });

  it('walks /proc on Linux', async () => {
    const status = (name: string, ppid: number): string =>
      `Name:\t${name}\nState:\tS (sleeping)\nTgid:\t1\nPPid:\t${String(ppid)}\n`;
    const files: Record<string, string> = {
      '/proc/300/status': status('node', 200),
      '/proc/200/status': status('bash', 100),
      '/proc/100/status': status('systemd', 0),
    };
    const identity = await resolveProcessIdentity({
      platform: 'linux',
      pid: 300,
      ppid: 200,
      readFile: (path) => {
        const found = files[path];
        if (found === undefined) throw new Error(`ENOENT ${path}`);
        return found;
      },
    });
    expect(identity).toEqual({
      pid: 300,
      ppid: 200,
      ancestors: [
        { pid: 200, name: 'bash' },
        { pid: 100, name: 'systemd' },
      ],
    });
  });

  it('is pid and ppid alone when /proc is not there', async () => {
    const identity = await resolveProcessIdentity({
      platform: 'linux',
      pid: 300,
      ppid: 200,
      readFile: () => {
        throw new Error('ENOENT');
      },
    });
    expect(identity).toEqual({ pid: 300, ppid: 200, ancestors: [] });
  });

  it('answers on the real platform, whichever it is, without throwing', async () => {
    const identity = await resolveProcessIdentity();
    expect(identity.pid).toBe(process.pid);
    expect(identity.ppid).toBe(process.ppid);
    for (const ancestor of identity.ancestors) {
      expect(ancestor.pid).toBeGreaterThan(0);
      expect(ancestor.name.length).toBeGreaterThan(0);
    }
    if (process.platform === 'win32') expect(identity.ancestors).toEqual([]);
  });
});

describe('parsing /proc/<pid>/status', () => {
  it('takes the name and the parent', () => {
    expect(parseProcStatus('Name:\tnode\nUmask:\t0022\nPPid:\t42\n')).toEqual({
      ppid: 42,
      name: 'node',
    });
  });

  it('gives up on anything that does not carry both', () => {
    expect(parseProcStatus('Name:\tnode\n')).toBeUndefined();
    expect(parseProcStatus('PPid:\t42\n')).toBeUndefined();
    expect(parseProcStatus('')).toBeUndefined();
  });
});

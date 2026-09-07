import { describe, expect, it } from 'vitest';

import { HELP_TEXT, parseArgs, run, VERSION, type CliStreams, type Command } from '../../src/main';

/** Collects what the CLI writes to stderr and returns it with the exit code. */
function invoke(argv: readonly string[]): { code: number; err: string[] } {
  const err: string[] = [];
  const streams: CliStreams = { err: (line) => err.push(line) };
  return { code: run(argv, streams), err };
}

describe('parseArgs', () => {
  it('serves by default when no argument is given', () => {
    expect(parseArgs([])).toEqual({ kind: 'command', command: 'serve' });
  });

  it.each<[string[], Command]>([
    [['serve'], 'serve'],
    [['hook', 'stop'], 'hook-stop'],
    [['validate', 'spec.json'], 'validate'],
    [['runbooks', 'search', '--where', 'a', '--goal', 'b'], 'runbooks-search'],
    [['doctor'], 'doctor'],
  ])('routes %j', (argv, command) => {
    expect(parseArgs(argv)).toEqual({ kind: 'command', command });
  });

  it.each<[string]>([['-h'], ['--help']])('recognises %s', (flag) => {
    expect(parseArgs([flag])).toEqual({ kind: 'help' });
  });

  it.each<[string]>([['-V'], ['--version']])('recognises %s', (flag) => {
    expect(parseArgs([flag])).toEqual({ kind: 'version' });
  });

  it.each<[string[], string]>([
    [['nonsense'], 'unknown command: nonsense'],
    [['hook'], 'hook needs an event: stop'],
    [['hook', 'start'], 'unknown hook event: start'],
    [['validate'], 'validate needs a spec file'],
    [['runbooks'], 'runbooks needs an action: search'],
    [['runbooks', 'list'], 'unknown runbooks action: list'],
  ])('rejects %j', (argv, message) => {
    expect(parseArgs(argv)).toEqual({ kind: 'usage-error', message });
  });
});

describe('run', () => {
  it('prints the help with the five subcommands and exits 0', () => {
    const { code, err } = invoke(['--help']);
    expect(code).toBe(0);
    expect(err).toEqual([HELP_TEXT]);
    for (const command of ['serve', 'hook stop', 'validate', 'runbooks search', 'doctor']) {
      expect(HELP_TEXT).toContain(command);
    }
  });

  it('prints the version and exits 0', () => {
    const { code, err } = invoke(['--version']);
    expect(code).toBe(0);
    expect(err).toEqual([VERSION]);
  });

  it.each<[string[], Command, string]>([
    [[], 'serve', 'T-017'],
    [['hook', 'stop'], 'hook-stop', 'T-021'],
    [['validate', 'spec.json'], 'validate', 'T-013'],
    [['runbooks', 'search'], 'runbooks-search', 'T-016'],
    [['doctor'], 'doctor', 'T-021'],
  ])('reports %j as not implemented yet', (argv, command, task) => {
    const { code, err } = invoke(argv);
    expect(code).toBe(1);
    expect(err).toEqual([`handoff-mcp: ${command} is not implemented (${task})`]);
  });

  it('exits 2 with the help on a usage error', () => {
    const { code, err } = invoke(['nonsense']);
    expect(code).toBe(2);
    expect(err).toEqual(['handoff-mcp: unknown command: nonsense', HELP_TEXT]);
  });
});

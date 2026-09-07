import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { HandoffErrorPayload } from '../../src/format';
import { HELP_TEXT, parseArgs, run, VERSION, type CliStreams, type Command } from '../../src/main';

const REPO = fileURLToPath(new URL('../../', import.meta.url));

/** Collects what the CLI writes, and serves the files the test declares. */
function invoke(
  argv: readonly string[],
  files: Readonly<Record<string, string>> = {},
): { code: number; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const streams: CliStreams = {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    readFile: (path) => {
      const content = files[path];
      if (content === undefined) throw new Error(`ENOENT: no such file or directory, open ${path}`);
      return content;
    },
  };
  return { code: run(argv, streams), out, err };
}

/** The spec of the acceptance criterion, read from the repository. */
const stripeWebhook = readFileSync(`${REPO}fixtures/specs/valid/stripe-webhook.json`, 'utf8');

function payload(line: string): HandoffErrorPayload {
  return JSON.parse(line) as HandoffErrorPayload;
}

describe('parseArgs', () => {
  it('serves by default when no argument is given', () => {
    expect(parseArgs([])).toEqual({ kind: 'command', command: 'serve' });
  });

  it.each<[string[], Command]>([
    [['serve'], 'serve'],
    [['hook', 'stop'], 'hook-stop'],
    [['runbooks', 'search', '--where', 'a', '--goal', 'b'], 'runbooks-search'],
    [['doctor'], 'doctor'],
  ])('routes %j', (argv, command) => {
    expect(parseArgs(argv)).toEqual({ kind: 'command', command });
  });

  it('routes validate with the file to validate', () => {
    expect(parseArgs(['validate', 'spec.json'])).toEqual({
      kind: 'command',
      command: 'validate',
      file: 'spec.json',
    });
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

describe('validate', () => {
  it('accepts the design example and exits 0 with one summary line', () => {
    const { code, out, err } = invoke(['validate', 'stripe.json'], {
      'stripe.json': stripeWebhook,
    });
    expect(err).toEqual([]);
    expect(out).toEqual([
      'stripe.json: valid handoff spec (spec_version 1, 4 steps, 2 values, 1 secret, verify present)',
    ]);
    expect(code).toBe(0);
  });

  it('prints the same JSON error the tool returns and exits 1', () => {
    const spec = JSON.stringify({ ...(JSON.parse(stripeWebhook) as object), goal: '   ' });
    const { code, out } = invoke(['validate', 'spec.json'], { 'spec.json': spec });
    expect(code).toBe(1);
    expect(out).toHaveLength(1);
    const { error } = payload(out[0] ?? '');
    expect(error.code).toBe('SPEC_INVALID');
    expect(error.problems).toEqual([
      { path: 'goal', problem: '`goal` is empty after trimming.', fix: 'Field goal is empty.' },
    ]);
  });

  it('reports a syntax error as a problem of the file, with the position but no content', () => {
    const { code, out } = invoke(['validate', 'broken.json'], {
      'broken.json': '{ "spec_version": 1, "goal": "unclosed" ',
    });
    expect(code).toBe(1);
    const { error } = payload(out[0] ?? '');
    expect(error.code).toBe('SPEC_INVALID');
    expect(error.problems[0]?.problem).toBe('The file is not valid JSON.');
    expect(error.problems[0]?.fix).not.toContain('unclosed');
  });

  it('exits 2 when the file cannot be read, and prints nothing on stdout', () => {
    const { code, out, err } = invoke(['validate', 'missing.json']);
    expect(code).toBe(2);
    expect(out).toEqual([]);
    expect(err[0]).toContain('cannot read missing.json');
  });
});

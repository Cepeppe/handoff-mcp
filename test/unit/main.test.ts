import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { HandoffErrorPayload } from '../../src/format';
import {
  HELP_TEXT,
  parseArgs,
  run,
  SUBCOMMAND_HELP,
  VERSION,
  type CliStreams,
  type Command,
} from '../../src/main';

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
  const code = run(argv, streams);
  if (typeof code !== 'number') {
    throw new Error(`${argv.join(' ')} answered asynchronously; use invokeAsync`);
  }
  return { code, out, err };
}

/** The same, for the two subcommands that talk to the app before they can answer. */
async function invokeAsync(
  argv: readonly string[],
): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    readFile: (path) => {
      throw new Error(`ENOENT: no such file or directory, open ${path}`);
    },
  });
  return { code, out, err };
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
    [['doctor'], 'doctor'],
  ])('routes %j', (argv, command) => {
    expect(parseArgs(argv)).toEqual({ kind: 'command', command });
  });

  it('routes runbooks search with its options, in either form', () => {
    expect(parseArgs(['runbooks', 'search', '--where', 'a', '--goal', 'b'])).toEqual({
      kind: 'command',
      command: 'runbooks-search',
      where: 'a',
      goal: 'b',
    });
    expect(parseArgs(['runbooks', 'search', '--goal=b', '--where=a', '--lang=en-GB'])).toEqual({
      kind: 'command',
      command: 'runbooks-search',
      where: 'a',
      goal: 'b',
      lang: 'en-GB',
    });
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
    [['runbooks', 'search'], 'runbooks search needs --where'],
    [['runbooks', 'search', '--where', 'a'], 'runbooks search needs --goal'],
    [['runbooks', 'search', '--where', 'a', '--goal'], '--goal needs a value'],
    [['runbooks', 'search', '--where', ' ', '--goal', 'b'], '--where is empty'],
    [['runbooks', 'search', '--where', 'a', '--goal', 'b', '--all'], 'unknown option: --all'],
    [['serve', 'now'], 'serve takes no argument: now'],
    [['hook', 'stop', 'now'], 'hook stop takes no argument: now'],
    [['doctor', '--verbose'], 'doctor takes no argument: --verbose'],
    [['validate', 'a.json', 'b.json'], 'validate takes one spec file: b.json'],
    [
      ['runbooks', 'search', '--where', 'a'.repeat(301), '--goal', 'b'],
      '--where is longer than 300 characters',
    ],
    [
      ['runbooks', 'search', '--where', 'a', '--goal', 'b', '--lang', 'english'],
      '--lang is not a BCP-47 language tag',
    ],
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

  it.each<[string[], Command]>([
    [['serve', '--help'], 'serve'],
    [['hook', '--help'], 'hook-stop'],
    [['hook', 'stop', '-h'], 'hook-stop'],
    [['validate', '--help'], 'validate'],
    [['runbooks', 'search', '--help'], 'runbooks-search'],
    [['runbooks', '--help'], 'runbooks-search'],
    [['doctor', '--help'], 'doctor'],
  ])('prints the help of one subcommand for %j', (argv, command) => {
    const { code, out, err } = invoke(argv);
    expect(code).toBe(0);
    expect(out).toEqual([]);
    expect(err).toEqual([SUBCOMMAND_HELP[command]]);
  });

  it('gives every subcommand a help that says what it prints and how it exits', () => {
    for (const [command, text] of Object.entries(SUBCOMMAND_HELP)) {
      expect(text, command).toContain('Usage:');
      expect(text, command).toMatch(/[Ee]xit/u);
    }
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

describe('runbooks search', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'handoff-cli-'));
    process.env['HANDOFF_HOME'] = home;
  });

  afterEach(() => {
    delete process.env['HANDOFF_HOME'];
    rmSync(home, { recursive: true, force: true });
  });

  /** Copies the published runbook fixtures into the temporary HANDOFF_HOME. */
  function installRunbooks(): void {
    const folder = join(home, 'runbooks');
    mkdirSync(folder);
    const source = `${REPO}fixtures/runbooks/valid`;
    for (const name of readdirSync(source)) {
      writeFileSync(join(folder, name), readFileSync(join(source, name), 'utf8'), 'utf8');
    }
  }

  function search(...argv: string[]): { code: number; out: string[]; err: string[] } {
    return invoke(['runbooks', 'search', ...argv]);
  }

  it('prints the same {"runbooks": [...]} the tool returns, and exits 0', () => {
    installRunbooks();
    const { code, out, err } = search(
      '--where',
      'Stripe Dashboard > Developers > Webhooks',
      '--goal',
      'Set up Stripe webhook for payment notifications',
      '--lang',
      'en',
    );

    expect(err).toEqual([]);
    expect(code).toBe(0);
    const result = JSON.parse(out.join('\n')) as {
      runbooks: { id: string; matched_words: string[]; values_to_fill: Record<string, unknown> }[];
    };
    expect(result.runbooks).toHaveLength(1);
    expect(result.runbooks[0]?.id).toBe('rb_2b9x4d7fkq');
    expect(result.runbooks[0]?.matched_words).toEqual(['stripe', 'webhook', 'payment']);
    expect(Object.keys(result.runbooks[0]?.values_to_fill ?? {})).toEqual([
      'endpoint_url',
      'events',
    ]);
  });

  it('prints an empty list when nothing matches, and when the folder is not there', () => {
    installRunbooks();
    expect(search('--where', 'Nowhere', '--goal', 'Nothing').out.join('\n')).toBe(
      '{\n  "runbooks": []\n}',
    );
    rmSync(join(home, 'runbooks'), { recursive: true });
    const { code, out } = search('--where', 'Nowhere', '--goal', 'Nothing');
    expect(code).toBe(0);
    expect(out.join('\n')).toBe('{\n  "runbooks": []\n}');
  });

  it('names a skipped file on stderr and still answers on stdout', () => {
    installRunbooks();
    writeFileSync(join(home, 'runbooks', 'broken.json'), '{ not json', 'utf8');

    const { code, out, err } = search(
      '--where',
      'Stripe Dashboard → Developers → Webhooks',
      '--goal',
      'Register the Stripe webhook',
    );
    expect(code).toBe(0);
    expect(err).toHaveLength(1);
    expect(err[0]).toContain('broken.json');
    expect((JSON.parse(out.join('\n')) as { runbooks: unknown[] }).runbooks).toHaveLength(1);
  });

  it('answers RUNBOOKS_UNREADABLE and exits 1 when the folder cannot be read', () => {
    writeFileSync(join(home, 'runbooks'), 'a file where the folder should be', 'utf8');

    const { code, out } = search('--where', 'a', '--goal', 'b');
    expect(code).toBe(1);
    expect(payload(out.join('\n')).error.code).toBe('RUNBOOKS_UNREADABLE');
  });
});

describe('hook stop and doctor, through the CLI', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'handoff-cli-'));
    process.env['HANDOFF_HOME'] = home;
  });

  afterEach(() => {
    delete process.env['HANDOFF_HOME'];
    delete process.env['HANDOFF_MCP_LOG'];
    rmSync(home, { recursive: true, force: true });
  });

  it('answers hook stop neutrally when there is no app, printing nothing at all', async () => {
    const { code, out, err } = await invokeAsync(['hook', 'stop']);
    expect(code).toBe(0);
    expect(out).toEqual([]);
    expect(err).toEqual([]);
  });

  it('answers doctor with the report on stdout, and 1 when the token is missing', async () => {
    const { code, out } = await invokeAsync(['doctor']);
    expect(code).toBe(1);
    expect(out[0]).toBe('server');
    expect(out.join('\n')).toContain('the channel token file is missing');
  });

  it('adds the diagnostics of HANDOFF_MCP_LOG=debug on stderr, and nothing at error', async () => {
    const quiet = await invokeAsync(['doctor']);
    expect(quiet.err.join('\n')).not.toContain('cli_command');

    process.env['HANDOFF_MCP_LOG'] = 'debug';
    const loud = await invokeAsync(['doctor']);
    expect(loud.err.join('\n')).toContain('handoff-mcp debug cli_command kind=doctor');
    expect(loud.err.join('\n')).toContain('handoff-mcp debug cli_exit code=1');
  });

  it('names an environment variable it had to ignore, at debug level', async () => {
    process.env['HANDOFF_MCP_LOG'] = 'debug';
    process.env['HANDOFF_TOOL_TIMEOUT_MS'] = 'half a minute';
    try {
      const { err } = await invokeAsync(['doctor']);
      expect(err.join('\n')).toContain('cli_env_ignored env_var=HANDOFF_TOOL_TIMEOUT_MS');
    } finally {
      delete process.env['HANDOFF_TOOL_TIMEOUT_MS'];
    }
  });
});

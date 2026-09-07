/**
 * The channel token file (TECHNICAL-DESIGN §5.8, SRV-07, FM-10).
 *
 * The file system is injected rather than staged in a temporary folder, because two of the
 * rules cannot be staged on this machine at all: a POSIX mode of `0644` does not exist on
 * Windows, and the warning must be absent there for the same reason.
 */
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { TokenFile } from '../../../src/platform/token';

const HOME = '/tmp/handoff-test';
const TOKEN = 'c0ffee11d0d0f00d1234567890abcdef00112233445566778899aabbccddeeff';

interface Harness {
  readonly file: TokenFile;
  readonly warnings: string[];
}

function harness(options: {
  content?: string | (() => never);
  mode?: number | undefined;
  platform?: NodeJS.Platform;
}): Harness {
  const warnings: string[] = [];
  const { content = TOKEN, mode, platform = 'linux' } = options;
  const file = new TokenFile({
    env: { HANDOFF_HOME: HOME },
    platform,
    warn: (line) => warnings.push(line),
    readFile: typeof content === 'function' ? content : () => content,
    mode: () => mode,
  });
  return { file, warnings };
}

function systemError(code: string): () => never {
  return () => {
    throw Object.assign(new Error(code), { code });
  };
}

describe('reading the token', () => {
  it('reads it from ~/.handoff/channel.token', () => {
    expect(harness({}).file.file).toBe(join(HOME, 'channel.token'));
  });

  it('accepts the 64 hex characters the installer writes, with its trailing newline', () => {
    expect(harness({ content: `${TOKEN}\n` }).file.read()).toEqual({ ok: true, token: TOKEN });
  });

  it('reads the file again at every attempt, so a repaired token is picked up', () => {
    let content = 'not a token';
    const file = new TokenFile({
      env: { HANDOFF_HOME: HOME },
      platform: 'linux',
      warn: () => undefined,
      readFile: () => content,
      mode: () => 0o600,
    });
    expect(file.read()).toEqual({ ok: false, problem: 'malformed' });
    content = TOKEN;
    expect(file.read()).toEqual({ ok: true, token: TOKEN });
  });

  it('tells a file that is not there from one that cannot be read', () => {
    expect(harness({ content: systemError('ENOENT') }).file.read()).toEqual({
      ok: false,
      problem: 'missing',
    });
    expect(harness({ content: systemError('ENOTDIR') }).file.read()).toEqual({
      ok: false,
      problem: 'missing',
    });
    expect(harness({ content: systemError('EACCES') }).file.read()).toEqual({
      ok: false,
      problem: 'unreadable',
    });
  });

  it('refuses anything that is not 64 lowercase hex characters', () => {
    for (const content of ['', TOKEN.toUpperCase(), TOKEN.slice(1), `${TOKEN}0`, `${TOKEN} x`]) {
      expect(harness({ content }).file.read(), content).toEqual({
        ok: false,
        problem: 'malformed',
      });
    }
  });
});

describe('the mode of the token file', () => {
  it('warns once, on stderr, and connects anyway when it is wider than 0600', () => {
    const { file, warnings } = harness({ mode: 0o644 });
    expect(file.read()).toEqual({ ok: true, token: TOKEN });
    expect(file.read()).toEqual({ ok: true, token: TOKEN });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(join(HOME, 'channel.token'));
    expect(warnings[0]).toContain('0644');
    expect(warnings[0]).toContain('chmod 600');
  });

  it('says nothing when the installer wrote it correctly', () => {
    const { file, warnings } = harness({ mode: 0o600 });
    expect(file.read()).toEqual({ ok: true, token: TOKEN });
    expect(warnings).toEqual([]);
  });

  it('says nothing when the mode cannot be read', () => {
    const { warnings, file } = harness({ mode: undefined });
    expect(file.read()).toEqual({ ok: true, token: TOKEN });
    expect(warnings).toEqual([]);
  });

  it('is not checked on Windows, which has no POSIX modes', () => {
    const { file, warnings } = harness({ mode: 0o666, platform: 'win32' });
    expect(file.read()).toEqual({ ok: true, token: TOKEN });
    expect(warnings).toEqual([]);
  });

  it('is not read at all when the token is unusable: there is nothing to warn about', () => {
    const { file, warnings } = harness({ content: 'nope', mode: 0o777 });
    expect(file.read()).toEqual({ ok: false, problem: 'malformed' });
    expect(warnings).toEqual([]);
  });
});

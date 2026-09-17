/**
 * The shared paths and the endpoint (TECHNICAL-DESIGN §4.1, §5.8, DD-26, FM-12).
 *
 * The app computes these names from the same inputs in Rust, so the expectations here are
 * **literal values** rather than a second implementation of the formula: a test that hashes
 * the same string with the same library agrees with any change, including a wrong one. The
 * three digests below were computed once and are the contract the app's listener (T-031)
 * has to reproduce.
 */
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  PIPE_PREFIX,
  SUN_PATH_MAX_BYTES,
  endpointTarget,
  exceedsSunPath,
  homeDir,
  pipeName,
  pipeSuffix,
  resolveEndpoint,
  runbooksDir,
  socketPath,
  socketPointerPath,
  tokenPath,
} from '../../../src/platform/paths';

const HOME = '/tmp/handoff-test';
const WINDOWS_HOME = 'C:\\tmp\\hh';

/** A Windows user, as the two variables the pipe name is derived from carry it. */
const WINDOWS_USER = { USERDOMAIN: 'ACME', USERNAME: 'Alice' } as const;

/** sha256("acme\alice"), first 16 hex digits. */
const PIPE_HASH = '367c2964b2feb41a';
/** sha256("acme\alice|/tmp/handoff-test"). */
const PIPE_HASH_WITH_HOME = '4ac5f1cdb665b4c9';
/** sha256("acme\alice|C:\tmp\hh"). */
const PIPE_HASH_WITH_WINDOWS_HOME = '0296fa15bf7a583f';

describe('the folder', () => {
  it('is HANDOFF_HOME when it is set', () => {
    expect(homeDir({ HANDOFF_HOME: HOME })).toBe(HOME);
  });

  it('holds the runbooks, the token, the socket and its pointer file', () => {
    const env = { HANDOFF_HOME: HOME };
    expect(runbooksDir(env)).toBe(join(HOME, 'runbooks'));
    expect(tokenPath(env)).toBe(join(HOME, 'channel.token'));
    expect(socketPath(env)).toBe(join(HOME, 'app.sock'));
    expect(socketPointerPath(env)).toBe(join(HOME, 'app.sock.path'));
  });
});

describe('the named pipe', () => {
  it('is derived from the lower-cased USERDOMAIN\\USERNAME', () => {
    expect(pipeSuffix('acme\\alice', undefined)).toBe(PIPE_HASH);
    expect(pipeName(WINDOWS_USER)).toBe(`${PIPE_PREFIX}${PIPE_HASH}`);
  });

  it('mixes HANDOFF_HOME in when it is set, so a test instance has its own pipe', () => {
    expect(pipeSuffix('acme\\alice', HOME)).toBe(PIPE_HASH_WITH_HOME);
    expect(pipeName({ ...WINDOWS_USER, HANDOFF_HOME: HOME })).toBe(
      `${PIPE_PREFIX}${PIPE_HASH_WITH_HOME}`,
    );
    expect(pipeName({ ...WINDOWS_USER, HANDOFF_HOME: WINDOWS_HOME })).toBe(
      `${PIPE_PREFIX}${PIPE_HASH_WITH_WINDOWS_HOME}`,
    );
  });

  it('is the same pipe whatever case the variables carry', () => {
    expect(pipeName({ USERDOMAIN: 'acme', USERNAME: 'alice' })).toBe(pipeName(WINDOWS_USER));
  });

  it('is a different pipe for a different user, which is what it is for', () => {
    expect(pipeName({ USERDOMAIN: 'ACME', USERNAME: 'other' })).not.toBe(pipeName(WINDOWS_USER));
  });

  it('takes sixteen hex digits and no more', () => {
    expect(pipeSuffix('acme\\alice', undefined)).toMatch(/^[0-9a-f]{16}$/u);
  });
});

describe('the sun_path limit', () => {
  it('is measured in bytes and not in characters', () => {
    const short = `/${'a'.repeat(SUN_PATH_MAX_BYTES - 1)}`;
    expect(short).toHaveLength(SUN_PATH_MAX_BYTES);
    expect(exceedsSunPath(short)).toBe(false);
    // The same number of characters, one of which costs two bytes.
    expect(exceedsSunPath(`é${short.slice(1)}`)).toBe(true);
  });

  it('is exceeded only above the limit', () => {
    expect(exceedsSunPath('a'.repeat(SUN_PATH_MAX_BYTES))).toBe(false);
    expect(exceedsSunPath('a'.repeat(SUN_PATH_MAX_BYTES + 1))).toBe(true);
  });
});

describe('the endpoint', () => {
  const longHome = `/tmp/${'d'.repeat(SUN_PATH_MAX_BYTES)}`;
  const refuse = (): string => {
    throw new Error('the pointer file must not be read');
  };

  it('is the named pipe on Windows, and no file is read', () => {
    const endpoint = resolveEndpoint({
      env: WINDOWS_USER,
      platform: 'win32',
      readFile: refuse,
    });
    expect(endpoint).toEqual({ kind: 'pipe', name: `${PIPE_PREFIX}${PIPE_HASH}` });
    expect(endpointTarget(endpoint)).toBe(`${PIPE_PREFIX}${PIPE_HASH}`);
  });

  it('is ~/.handoff/app.sock on macOS while the path fits', () => {
    const endpoint = resolveEndpoint({
      env: { HANDOFF_HOME: HOME },
      platform: 'darwin',
      readFile: refuse,
    });
    expect(endpoint).toEqual({ kind: 'unix', path: join(HOME, 'app.sock') });
  });

  it('follows the pointer file when the path does not fit', () => {
    const read: string[] = [];
    const endpoint = resolveEndpoint({
      env: { HANDOFF_HOME: longHome },
      platform: 'darwin',
      readFile: (path) => {
        read.push(path);
        return '/tmp/h/app.sock\n';
      },
    });
    expect(read).toEqual([join(longHome, 'app.sock.path')]);
    expect(endpoint).toEqual({ kind: 'unix', path: '/tmp/h/app.sock' });
  });

  it('keeps the long path when the pointer file is absent or empty', () => {
    const long = join(longHome, 'app.sock');
    expect(
      resolveEndpoint({
        env: { HANDOFF_HOME: longHome },
        platform: 'darwin',
        readFile: () => {
          throw Object.assign(new Error('no such file'), { code: 'ENOENT' });
        },
      }),
    ).toEqual({ kind: 'unix', path: long });

    expect(
      resolveEndpoint({
        env: { HANDOFF_HOME: longHome },
        platform: 'darwin',
        readFile: () => '  \n',
      }),
    ).toEqual({ kind: 'unix', path: long });
  });

  it('gives Linux the macOS shape, which is what CI runs the suite on', () => {
    expect(
      resolveEndpoint({ env: { HANDOFF_HOME: HOME }, platform: 'linux', readFile: refuse }),
    ).toEqual({ kind: 'unix', path: join(HOME, 'app.sock') });
  });
});

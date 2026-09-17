/**
 * The paths the server and the app share, and the endpoint they meet on (TECHNICAL-DESIGN
 * §4.1, §5.8, DD-26, FM-12).
 *
 * Everything here is derived from one folder, `~/.handoff/` (or `HANDOFF_HOME`), and every
 * value is computed rather than remembered: the endpoint and the token are resolved again
 * at every connection attempt, so an app that starts later, a repaired token or a pointer
 * file written after the server did are all picked up without a restart.
 *
 * The two peers compute these names independently and must land on the same string, so the
 * rules below are literal transcriptions of the design rather than conveniences:
 *
 * - **macOS and Linux.** `~/.handoff/app.sock`. A Unix socket path lives in a `sun_path` of
 *   104 bytes, and `HANDOFF_HOME` can be anywhere, so when the path does not fit the app
 *   writes the real one into `~/.handoff/app.sock.path` and the server reads it (FM-12).
 * - **Windows.** `\\.\pipe\handoff-<h>`, `h` being the first 16 hex digits of the SHA-256 of
 *   the lower-cased `USERDOMAIN\USERNAME`. The pipe namespace is machine-global, so the
 *   suffix is what keeps two users' apps apart. When `HANDOFF_HOME` is set — tests and the
 *   e2e isolation of implementation decision 4 — it is mixed in as `<user>|<home>`, so a test
 *   instance cannot land on the pipe of the app the owner is actually using.
 *
 * Linux is not a supported platform; it gets the macOS shape because the code is written
 * once and CI runs the unit tests on `ubuntu-latest`.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { homeDir, homeOverride, windowsUserKey, type EnvRecord } from '../config';

/** The folder under `~/.handoff/` that holds the runbook files (RUN-03a). */
export const RUNBOOKS_FOLDER_NAME = 'runbooks';

/** The per-installation channel token, written by the installer (SRV-07, INST-07). */
export const TOKEN_FILE_NAME = 'channel.token';

/** The Unix socket the app listens on (§4.1). */
export const SOCKET_FILE_NAME = 'app.sock';

/** Where the app writes the real socket path when the default one does not fit (FM-12). */
export const SOCKET_POINTER_FILE_NAME = 'app.sock.path';

/**
 * The size of `sun_path` on macOS, in bytes, as §5.8 states it. A path is measured in
 * UTF-8 bytes and not in characters: a home folder with an accented name spends two bytes
 * on that letter, exactly as the kernel counts it.
 */
export const SUN_PATH_MAX_BYTES = 104;

/** The prefix of the named pipe (§4.1). The suffix is the hash below. */
export const PIPE_PREFIX = '\\\\.\\pipe\\handoff-';

/** How many hex digits of the digest name the pipe (§4.1: the first 16). */
export const PIPE_SUFFIX_LENGTH = 16;

/** `~/.handoff`, or `HANDOFF_HOME` when it is set (§4.1, §5.12). */
export { homeDir } from '../config';

/** `~/.handoff/runbooks/`, the single root the reader is configured with (§12.3). */
export function runbooksDir(env?: EnvRecord): string {
  return join(homeDir(env), RUNBOOKS_FOLDER_NAME);
}

/** `~/.handoff/channel.token`, read at every connection attempt (§5.8). */
export function tokenPath(env?: EnvRecord): string {
  return join(homeDir(env), TOKEN_FILE_NAME);
}

/** `~/.handoff/app.sock`: where the app listens when the path fits in `sun_path`. */
export function socketPath(env?: EnvRecord): string {
  return join(homeDir(env), SOCKET_FILE_NAME);
}

/** `~/.handoff/app.sock.path`: the pointer file of FM-12. */
export function socketPointerPath(env?: EnvRecord): string {
  return join(homeDir(env), SOCKET_POINTER_FILE_NAME);
}

/**
 * The 16 hex digits that name the pipe. `home` is the value of `HANDOFF_HOME` when it is
 * set and `undefined` otherwise, which is the difference between the design's rule and the
 * test isolation of implementation decision 4 — and the only difference: the digest is over
 * `<user>` or `<user>|<home>`, with nothing else added and nothing else lower-cased.
 */
export function pipeSuffix(userKey: string, home: string | undefined): string {
  const material = home === undefined ? userKey : `${userKey}|${home}`;
  return createHash('sha256').update(material, 'utf8').digest('hex').slice(0, PIPE_SUFFIX_LENGTH);
}

/** `\\.\pipe\handoff-<h>` for the user this process runs as (§4.1, §5.8, DD-26). */
export function pipeName(env?: EnvRecord): string {
  return PIPE_PREFIX + pipeSuffix(windowsUserKey(env), homeOverride(env));
}

/** A named pipe on Windows, a Unix socket everywhere else. */
export type Endpoint =
  | { readonly kind: 'pipe'; readonly name: string }
  | { readonly kind: 'unix'; readonly path: string };

/** What `net.connect` is given, whichever shape the endpoint has. */
export function endpointTarget(endpoint: Endpoint): string {
  return endpoint.kind === 'pipe' ? endpoint.name : endpoint.path;
}

/** True when the default socket path is too long for `sun_path` and FM-12 applies. */
export function exceedsSunPath(path: string): boolean {
  return Buffer.byteLength(path, 'utf8') > SUN_PATH_MAX_BYTES;
}

/** Everything the resolution touches, injected so a test does not need a real file. */
export interface EndpointOptions {
  readonly env?: EnvRecord;
  readonly platform?: NodeJS.Platform;
  readonly readFile?: (path: string) => string;
}

const readFileUtf8 = (path: string): string => readFileSync(path, 'utf8');

/**
 * The endpoint to connect to, resolved from scratch (§5.8).
 *
 * On Windows the name is a pure computation. On POSIX the answer is the default path
 * unless it does not fit, and then the pointer file the app wrote. A pointer file that is
 * missing, unreadable or empty leaves the long path in place: the connection then fails
 * and the backoff of §5.3 tries again, which is the right outcome — an app that has not
 * written the pointer file is an app that is not listening yet.
 */
export function resolveEndpoint(options: EndpointOptions = {}): Endpoint {
  const { env, platform = process.platform, readFile = readFileUtf8 } = options;

  if (platform === 'win32') return { kind: 'pipe', name: pipeName(env) };

  const path = socketPath(env);
  if (!exceedsSunPath(path)) return { kind: 'unix', path };

  try {
    const pointed = readFile(socketPointerPath(env)).trim();
    if (pointed !== '') return { kind: 'unix', path: pointed };
  } catch {
    // The app has not written it, or cannot be read: the long path is the honest answer.
  }
  return { kind: 'unix', path };
}

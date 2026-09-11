/**
 * The project folder an editor's client names as a root (T-072, TECHNICAL-DESIGN §5.8).
 *
 * VS Code starts its servers in the user's home folder and names the window's workspace only
 * as the roots of its MCP client (measured against 1.137.0, `docs/agent-facts.md`), so for a
 * session keyed on the editor whose environment named no folder, `serve` sets
 * `projectDirFromRoots` and the server asks `roots/list` once the handshake is over. What is
 * pinned here is when it asks, which answer it takes, and that nothing a client can do — no
 * roots, an error, silence — costs the session more than its folder.
 *
 * Everything runs over the SDK's in-memory transport, with a client that declares roots or
 * does not, and answers or does not.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';

import { readConfig } from '../../../src/config';
import { createLogger } from '../../../src/log';
import { NullChannel } from '../../../src/mcp/port';
import { createServer, ROOTS_TIMEOUT_MS } from '../../../src/mcp/server';
import { RunbookStore } from '../../../src/runbooks';

const SHOP = join(tmpdir(), 'handoff-roots-shop');
const BLOG = join(tmpdir(), 'handoff-roots-blog');

type Roots = { uri: string; name?: string }[];

interface Handshake {
  /** What `onInitialized` was handed as the workspace. */
  readonly workspace: string | undefined;
  /** How many times the client was asked for its roots. */
  readonly asked: number;
  /** From the start of the handshake to `onInitialized`, in milliseconds. */
  readonly tookMs: number;
}

/** Runs one handshake between the server and a client shaped as the case says. */
async function handshake(options: {
  readonly projectDirFromRoots: boolean;
  readonly declareRoots: boolean;
  readonly answer?: () => Promise<{ roots: Roots }>;
  readonly rootsTimeoutMs?: number;
}): Promise<Handshake> {
  let asked = 0;
  let done: (workspace: string | undefined) => void = () => undefined;
  const initialized = new Promise<string | undefined>((resolve) => {
    done = resolve;
  });

  const server = createServer({
    config: readConfig({}, join(tmpdir(), 'handoff-roots-home')),
    version: '0.1.0-test',
    channel: NullChannel,
    runbooks: new RunbookStore([join(tmpdir(), 'handoff-roots-absent')], {
      warn: () => undefined,
    }),
    logger: createLogger('error', () => undefined),
    projectDirFromRoots: options.projectDirFromRoots,
    ...(options.rootsTimeoutMs === undefined ? {} : { rootsTimeoutMs: options.rootsTimeoutMs }),
    onInitialized: (_row, _client, workspace) => {
      done(workspace);
    },
  });
  const client = new Client(
    { name: 'Visual Studio Code', version: '1.137.0' },
    { capabilities: options.declareRoots ? { roots: { listChanged: true } } : {} },
  );
  if (options.declareRoots) {
    client.setRequestHandler(ListRootsRequestSchema, () => {
      asked += 1;
      return options.answer === undefined ? { roots: [] } : options.answer();
    });
  }

  const started = Date.now();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const workspace = await initialized;
  const tookMs = Date.now() - started;
  await client.close();
  await server.close();
  return { workspace, asked, tookMs };
}

describe('an editor session whose environment named no folder', () => {
  it("registers with the first root of the editor's client", async () => {
    const result = await handshake({
      projectDirFromRoots: true,
      declareRoots: true,
      answer: () =>
        Promise.resolve({
          roots: [
            { uri: pathToFileURL(SHOP).href, name: 'shop' },
            { uri: pathToFileURL(BLOG).href, name: 'blog' },
          ],
        }),
    });
    expect(result.workspace).toBe(SHOP);
    expect(result.asked).toBe(1);
  });

  it('registers with no folder when the window has none open, which is an empty list', async () => {
    const result = await handshake({ projectDirFromRoots: true, declareRoots: true });
    expect(result.workspace).toBeUndefined();
    expect(result.asked).toBe(1);
  });

  it('registers with no folder when the client refuses the request', async () => {
    const result = await handshake({
      projectDirFromRoots: true,
      declareRoots: true,
      answer: () => Promise.reject(new Error('no roots today')),
    });
    expect(result.workspace).toBeUndefined();
  });

  it('registers with no folder, and without waiting for ever, when the client never answers', async () => {
    const result = await handshake({
      projectDirFromRoots: true,
      declareRoots: true,
      answer: () => new Promise<{ roots: Roots }>(() => undefined),
      rootsTimeoutMs: 100,
    });
    expect(result.workspace).toBeUndefined();
    expect(result.tookMs).toBeLessThan(5_000);
  });

  it('does not ask a client that declares no roots', async () => {
    const result = await handshake({ projectDirFromRoots: true, declareRoots: false });
    expect(result.workspace).toBeUndefined();
    expect(result.asked).toBe(0);
  });
});

describe('every other session', () => {
  it('is never asked, whatever the client declares', async () => {
    const result = await handshake({
      projectDirFromRoots: false,
      declareRoots: true,
      answer: () => Promise.resolve({ roots: [{ uri: pathToFileURL(SHOP).href }] }),
    });
    expect(result.workspace).toBeUndefined();
    expect(result.asked).toBe(0);
  });
});

describe('the bound', () => {
  it('is short enough that a silent client costs a session seconds, not its registration', () => {
    expect(ROOTS_TIMEOUT_MS).toBeGreaterThan(0);
    expect(ROOTS_TIMEOUT_MS).toBeLessThanOrEqual(5_000);
  });
});

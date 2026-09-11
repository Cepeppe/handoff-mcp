/**
 * The session identity of a session an editor started (T-069, TECHNICAL-DESIGN §5.6, R-12).
 *
 * The first two chains are the shapes measured on 2026-09-11 (`docs/agent-facts.md`): the
 * server Cursor 3.20.10's editor starts sits under the extension host, a `Cursor.exe` whose
 * parent is the `Cursor.exe` that `VSCODE_PID` names, and the one its CLI starts sits under the
 * CLI's own `node.exe`. The others are the shapes the rule exists to keep on `parent_pid`: a
 * `claude.exe` that Claude Code's VS Code extension starts for each chat, the `kilo serve` of
 * Kilo Code's extension, a CLI agent in an editor terminal and a launcher. The macOS names are
 * Electron's helper names.
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  EDITOR_SESSION_IDENTITY,
  PARENT_PID_SESSION_IDENTITY,
  editorHost,
  isEditorExecutable,
  resolveSessionIdentity,
  workspaceFromRoots,
} from '../../../src/adapters';

/** Cursor's main process: the one `VSCODE_PID` names. */
const CURSOR = { pid: 41452, name: 'Cursor.exe' };

/** The chain of the server Cursor's editor started, nearest parent first (measured). */
const CURSOR_EDITOR_CHAIN = [
  { pid: 28392, name: 'Cursor.exe' },
  CURSOR,
  { pid: 19248, name: 'explorer.exe' },
];

/** The chain of the server Cursor's CLI started (measured): its parent is the CLI itself. */
const CURSOR_CLI_CHAIN = [
  { pid: 6480, name: 'node.exe' },
  { pid: 32244, name: 'pwsh.exe' },
  { pid: 29920, name: 'WindowsTerminal.exe' },
];

/** VS Code's main process, for the agents that run inside it. */
const CODE = { pid: 7000, name: 'Code.exe' };

describe('a session the editor itself started', () => {
  it('is keyed on the editor, and names the process VSCODE_PID points at', () => {
    expect(resolveSessionIdentity(CURSOR_EDITOR_CHAIN, CURSOR.pid)).toEqual({
      kind: EDITOR_SESSION_IDENTITY,
      editor: CURSOR,
    });
  });

  it('is recognised under the helper name Electron gives the extension host on macOS', () => {
    const chain = [
      { pid: 501, name: 'Cursor Helper (Plugin)' },
      { pid: 500, name: 'Cursor' },
      { pid: 1, name: 'launchd' },
    ];
    expect(editorHost(chain, 500)).toEqual({ pid: 500, name: 'Cursor' });
  });

  it('is recognised when the main process started the server with nothing in between', () => {
    expect(editorHost([CURSOR, { pid: 19248, name: 'explorer.exe' }], CURSOR.pid)).toEqual(CURSOR);
  });
});

describe('a session that keeps the parent_pid key', () => {
  it('is the CLI, whose environment names no editor', () => {
    expect(resolveSessionIdentity(CURSOR_CLI_CHAIN, undefined)).toEqual({
      kind: PARENT_PID_SESSION_IDENTITY,
      editor: undefined,
    });
  });

  it('is a CLI agent in an editor terminal, even if the pointer reached it: a shell sits between', () => {
    const chain = [
      { pid: 6480, name: 'node.exe' },
      { pid: 6400, name: 'pwsh.exe' },
      { pid: 28500, name: 'Cursor.exe' },
      CURSOR,
    ];
    expect(resolveSessionIdentity(chain, CURSOR.pid).kind).toBe(PARENT_PID_SESSION_IDENTITY);
  });

  it("is a chat of Claude Code's VS Code extension, whose own process sits between", () => {
    const chain = [{ pid: 9100, name: 'claude.exe' }, { pid: 7100, name: 'Code.exe' }, CODE];
    expect(editorHost(chain, CODE.pid)).toBeUndefined();
  });

  it("is Kilo Code's extension, whose kilo serve sits between", () => {
    const chain = [{ pid: 9200, name: 'kilo.exe' }, { pid: 7100, name: 'Code.exe' }, CODE];
    expect(editorHost(chain, CODE.pid)).toBeUndefined();
  });

  it('is a server started through a launcher, which the rule cannot tell from a shell', () => {
    const chain = [{ pid: 9300, name: 'cmd.exe' }, { pid: 28392, name: 'Cursor.exe' }, CURSOR];
    expect(editorHost(chain, CURSOR.pid)).toBeUndefined();
  });

  it('is a session whose pointer names no process of its chain', () => {
    expect(editorHost(CURSOR_EDITOR_CHAIN, 12345)).toBeUndefined();
  });

  it('is a session with no chain, which is what an unwalked or failed Windows walk leaves', () => {
    expect(resolveSessionIdentity([], CURSOR.pid).kind).toBe(PARENT_PID_SESSION_IDENTITY);
  });
});

describe("the editor's own executable", () => {
  it('is the same program, whatever the case or the Windows extension', () => {
    expect(isEditorExecutable('Cursor.exe', 'Cursor.exe')).toBe(true);
    expect(isEditorExecutable('cursor.EXE', 'Cursor.exe')).toBe(true);
    expect(isEditorExecutable('Cursor', 'Cursor.exe')).toBe(true);
  });

  it('includes the helpers Electron runs child processes under on macOS', () => {
    expect(isEditorExecutable('Cursor Helper (Plugin)', 'Cursor')).toBe(true);
    expect(isEditorExecutable('Code Helper (Renderer)', 'Code')).toBe(true);
  });

  it('is nothing else, not even a name that starts the same way', () => {
    expect(isEditorExecutable('Code.exe', 'Cursor.exe')).toBe(false);
    expect(isEditorExecutable('CursorX.exe', 'Cursor.exe')).toBe(false);
    expect(isEditorExecutable('claude.exe', 'Code.exe')).toBe(false);
    expect(isEditorExecutable('Cursor.exe', '')).toBe(false);
  });
});

describe('the folder a client names as its first root (T-072)', () => {
  /** Absolute on whichever platform runs the suite, and the URI a client would send for it. */
  const SHOP = resolve('/work', 'shop');
  const BLOG = resolve('/work', 'blog');
  const uri = (folder: string): string => pathToFileURL(folder).href;

  it("is the first file: root, the window's main folder", () => {
    expect(workspaceFromRoots([{ uri: uri(SHOP) }, { uri: uri(BLOG) }])).toBe(SHOP);
  });

  it('passes over a root of another scheme and a URI that does not parse', () => {
    expect(
      workspaceFromRoots([
        { uri: 'vscode-remote://ssh-remote+box/home/g/shop' },
        { uri: 'not a uri' },
        { uri: uri(BLOG) },
      ]),
    ).toBe(BLOG);
  });

  it('is nothing for a window with no folder open, which VS Code answers with no roots', () => {
    expect(workspaceFromRoots([])).toBeUndefined();
    expect(workspaceFromRoots([{ uri: 'untitled:Untitled-1' }])).toBeUndefined();
  });

  it.runIf(process.platform === 'win32')(
    'reads the drive letter VS Code percent-encodes on Windows (measured, 1.137.0)',
    () => {
      expect(workspaceFromRoots([{ uri: 'file:///c%3A/Users/g/dev/shop' }])).toBe(
        'c:\\Users\\g\\dev\\shop',
      );
    },
  );
});

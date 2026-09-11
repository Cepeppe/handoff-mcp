/**
 * Session identity inside an editor (T-069; TECHNICAL-DESIGN §5.6 "per-agent code … session
 * identity inside editors", §5.8, §14 R-12; ADPT-02).
 *
 * A CLI agent starts this server itself, so the server's parent is the agent and the app keys
 * the session on it (`parent_pid`, SRV-17). An editor is different: its own extension host
 * starts the server, once per window, for whichever chat of the window then uses it, so the
 * parent is a process of the editor and the app has to match the chain at the editor level
 * (`ancestor_chain:editor`). This module decides which of the two a session is, from what the
 * process chain and the environment show, and never from the agent id: one agent can arrive
 * with or without an editor above it (Cursor's editor and its CLI share the `cursor` row, and
 * Kilo Code's CLI and its VS Code extension share one id too).
 *
 * The rule, measured against Cursor 3.20.10 and its CLI on Windows (`docs/agent-facts.md`):
 *
 * 1. **The environment names the editor.** Editors of the VS Code family set `VSCODE_PID` to
 *    the id of their main process, and their extension host hands it on to what it starts. It
 *    is a pointer and never a key on its own.
 * 2. **The chain confirms it.** The process it names must be one of the server's ancestors,
 *    and every process between the server and it must run the editor's own executable: the
 *    extension host is `Cursor.exe` under `Cursor.exe` on Windows, and on macOS Electron names
 *    it `Cursor Helper (Plugin)` under `Cursor`. So a process of another program in between —
 *    the `claude.exe` Claude Code's VS Code extension starts for each chat, the `kilo serve`
 *    of Kilo Code's extension, the shell of an editor terminal running any CLI agent, a
 *    `cmd.exe` launcher — keeps the session on `parent_pid`.
 *
 * Anything short of both is `parent_pid`, the key every session had before this module. The
 * failure directions are not symmetric: a wrong "editor" would widen a key that was precise,
 * while a wrong "parent" leaves a session exactly where it always was (PRIN-10).
 *
 * An editor also knows which folder a window has open, and says so in one of two ways: Cursor
 * in `WORKSPACE_FOLDER_PATHS` (`src/config.ts`), VS Code only as the MCP roots of its client
 * (T-072). `workspaceFromRoots` reads the second; `serve` asks for it only for a session this
 * module keyed on the editor and whose environment named no folder.
 */
import { fileURLToPath } from 'node:url';

import type { ProcessAncestor } from '../platform';

/** The key of a CLI agent's session: the server's parent (SRV-17). */
export const PARENT_PID_SESSION_IDENTITY = 'parent_pid';

/** The key of a session an editor started: the chain, matched at the editor (R-12). */
export const EDITOR_SESSION_IDENTITY = 'ancestor_chain:editor';

export type SessionIdentityKind =
  typeof PARENT_PID_SESSION_IDENTITY | typeof EDITOR_SESSION_IDENTITY;

/** The editor that started the server: its main process, the one `VSCODE_PID` names. */
export interface EditorProcess {
  readonly pid: number;
  readonly name: string;
}

/** How the app should key this session, and the editor behind it when there is one. */
export interface SessionIdentity {
  readonly kind: SessionIdentityKind;
  /** Set exactly when `kind` is `ancestor_chain:editor`. */
  readonly editor: EditorProcess | undefined;
}

/** A process name in lower case and without the Windows extension. */
function executableName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\.exe$/u, '');
}

/**
 * Whether `name` is the editor's own executable: the same program, or one of the helper
 * programs Electron runs a child process under on macOS (`Cursor Helper (Plugin)` beside
 * `Cursor`, `Code Helper (Plugin)` beside `Code`).
 */
export function isEditorExecutable(name: string, editorName: string): boolean {
  const editor = executableName(editorName);
  if (editor === '') return false;
  const own = executableName(name);
  return own === editor || own.startsWith(`${editor} helper`);
}

/**
 * The editor that started this server, or `undefined`: the ancestor `editorPid` names, when
 * every process below it in the chain runs the editor's own executable.
 */
export function editorHost(
  ancestors: readonly ProcessAncestor[],
  editorPid: number | undefined,
): EditorProcess | undefined {
  if (editorPid === undefined) return undefined;
  const index = ancestors.findIndex((ancestor) => ancestor.pid === editorPid);
  const editor = ancestors[index];
  if (index === -1 || editor === undefined) return undefined;
  const between = ancestors.slice(0, index);
  if (!between.every((ancestor) => isEditorExecutable(ancestor.name, editor.name))) {
    return undefined;
  }
  return { pid: editor.pid, name: editor.name };
}

/**
 * The session identity of §5.6 for this session, from its ancestor chain and the
 * `VSCODE_PID` of its environment (`Config.editorPid`).
 */
export function resolveSessionIdentity(
  ancestors: readonly ProcessAncestor[],
  editorPid: number | undefined,
): SessionIdentity {
  const editor = editorHost(ancestors, editorPid);
  return editor === undefined
    ? { kind: PARENT_PID_SESSION_IDENTITY, editor: undefined }
    : { kind: EDITOR_SESSION_IDENTITY, editor };
}

/** One root of an MCP client's `roots/list` answer, as far as this module reads it. */
export interface ClientRoot {
  readonly uri: string;
}

/**
 * The folder of the first `file:` root a client names, or `undefined` (T-072).
 *
 * VS Code starts its servers in the user's home folder and puts the window's workspace in no
 * variable: it names it only as the roots of its MCP client, one per workspace folder, as
 * `file:` URIs (`file:///c%3A/…` on Windows), and answers an empty list for a window with no
 * folder open (measured against VS Code 1.137.0, `docs/agent-facts.md`). The first root is the
 * window's main folder, as the first folder of `WORKSPACE_FOLDER_PATHS` is Cursor's. A root of
 * another scheme names no folder on this machine and is passed over, and so is a URI that does
 * not parse.
 */
export function workspaceFromRoots(roots: readonly ClientRoot[]): string | undefined {
  for (const root of roots) {
    let url: URL;
    try {
      url = new URL(root.uri);
    } catch {
      continue;
    }
    if (url.protocol !== 'file:') continue;
    try {
      return fileURLToPath(url);
    } catch {
      // A file URI with a host, or with an encoded separator, names nothing this process opens.
    }
  }
  return undefined;
}

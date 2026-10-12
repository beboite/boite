/*
 * What a shell with Boite's integration says about itself, read from the
 * escape sequences the core's scripts add (`packages/core/src/terminal-integration.ts`):
 * OSC 133 marks a prompt (A), its input (B), the command running (C) and its
 * end with a status (D;<code>); OSC 633 P carries the working directory. A
 * shell without it may still report its directory with OSC 7, as zsh and fish
 * do on many systems.
 */

import type { TerminalShell } from '@boite/contracts';

export type ShellMark =
  | { kind: 'prompt' }
  | { kind: 'input' }
  | { kind: 'run' }
  | { kind: 'done'; exit: number | null };

/** The payload of an OSC 133 sequence, `D;1` say, or null for a mark this screen does not use. */
export function parsePromptMark(data: string): ShellMark | null {
  const [mark, code] = data.split(';');
  switch (mark) {
    case 'A': return { kind: 'prompt' };
    case 'B': return { kind: 'input' };
    case 'C': return { kind: 'run' };
    case 'D': {
      const exit = code === undefined || code === '' ? null : Number(code);
      return { kind: 'done', exit: exit !== null && Number.isFinite(exit) ? exit : null };
    }
    default: return null;
  }
}

/** The directory of an OSC 633 `P;Cwd=<path>` property, or null for another property. */
export function parseCwdProperty(data: string): string | null {
  if (!data.startsWith('P;Cwd=')) return null;
  const path = data.slice('P;Cwd='.length);
  return path.length > 0 ? path : null;
}

/** The directory of an OSC 7 `file://host/path` report, or null when it does not read as one. */
export function parseFileUrl(data: string): string | null {
  if (!data.startsWith('file://')) return null;
  try {
    const raw = new URL(data).pathname;
    let path: string;
    try {
      path = decodeURIComponent(raw);
    } catch {
      // A literal `%` the shell did not encode, `/tmp/100%`: the path as it came.
      path = raw;
    }
    // `file:///C:/Users` is a Windows path: the leading slash is the URL's, not the drive's.
    return /^\/[A-Za-z]:/.test(path) ? path.slice(1) : path;
  } catch {
    return null;
  }
}

/** The last part of a path, Windows or POSIX: what a tab shows. A root stays whole. */
export function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  if (trimmed.length === 0) return path;
  if (/^[A-Za-z]:$/.test(trimmed)) return `${trimmed}\\`;
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return cut === -1 ? trimmed : trimmed.slice(cut + 1);
}

/**
 * The keys that empty the line being typed, so a command picked from the
 * history replaces it instead of joining it. PSReadLine's Windows mode
 * deletes to the start with Ctrl+Home after End; readline and PSReadLine's
 * Emacs mode with Ctrl+E then Ctrl+U; cmd with Escape.
 */
export function clearLineKeys(shell: TerminalShell | null, windows: boolean): string {
  if (shell?.kind === 'cmd') return '\x1b';
  if (shell?.kind === 'powershell' && windows) return '\x1b[F\x1b[1;5H';
  return '\x05\x15';
}

/**
 * Commands that match every word of the query, in any order and case, best
 * first: those that start with the query, then the rest in history order.
 */
export function filterCommands(commands: readonly string[], query: string, max = 200): string[] {
  const words = query.toLowerCase().split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) return commands.slice(0, max);
  const start = query.trim().toLowerCase();
  const first: string[] = [];
  const rest: string[] = [];
  for (const command of commands) {
    const text = command.toLowerCase();
    if (!words.every((word) => text.includes(word))) continue;
    (text.startsWith(start) ? first : rest).push(command);
    if (first.length >= max) break;
  }
  return [...first, ...rest].slice(0, max);
}

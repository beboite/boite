import type { MessagePart } from '@boite/contracts';
import { describeTool, fileName } from './tool-summary';

/**
 * The files one answer made or changed, for the card at its end. Read from
 * what the agents already report: the diff documents Claude and ACP agents
 * attach, a Codex patch's list of changes, and a write or edit call's path
 * when neither is there. A call that failed or was denied changed nothing.
 */

export interface TurnFile {
  /** The path as the agent named it, absolute or not. */
  path: string;
  /** What `files.read` takes: relative to the thread's directory, `/` separators. Null outside it. */
  relative: string | null;
  /** The absolute path when it can be known, what "show in folder" hands the OS. */
  absolute: string | null;
  name: string;
  /** The folder it sits in, relative to the thread's directory when inside it. */
  folder: string;
  change: 'created' | 'changed' | 'deleted';
}

function isAbsolute(path: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('/') || path.startsWith('\\\\');
}

/** `C:\a\b` and `c:/a/b/` compare equal; so does a POSIX path with itself. */
function normal(path: string): string {
  const slashed = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[a-zA-Z]:\//.test(slashed) ? slashed[0]!.toLowerCase() + slashed.slice(1) : slashed;
}

function join(root: string, path: string): string {
  const separator = root.includes('\\') ? '\\' : '/';
  return `${root.replace(/[\\/]+$/, '')}${separator}${path.replace(/[\\/]/g, separator)}`;
}

/** Relative to `cwd` with `/`, or null when the path leaves it. */
export function relativeTo(cwd: string, path: string): string | null {
  if (!isAbsolute(path)) {
    const clean = path.replace(/\\/g, '/').replace(/^\.\//, '');
    return clean.split('/').includes('..') ? null : clean;
  }
  const root = normal(cwd);
  const full = normal(path);
  // Windows paths compare without case; the drive letter was lowered above.
  const windows = /^[a-z]:\//.test(root);
  const inside = windows ? full.toLowerCase().startsWith(`${root.toLowerCase()}/`) : full.startsWith(`${root}/`);
  return inside ? full.slice(root.length + 1) : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Every `(path, change)` one tool call reports, in the order it reports them. */
function touched(part: Extract<MessagePart, { type: 'tool' }>): { path: string; change: TurnFile['change'] }[] {
  const diffs = (part.documents ?? []).flatMap((document) =>
    document.kind === 'diff' ? [{ path: document.path, change: document.oldText === '' ? ('created' as const) : ('changed' as const) }] : []
  );
  if (diffs.length > 0) return diffs;
  const fields = record(part.input);
  const changes = fields?.['changes'];
  if (Array.isArray(changes)) {
    return changes.flatMap((entry) => {
      const change = record(entry);
      const path = change?.['path'];
      if (typeof path !== 'string' || path.length === 0) return [];
      const kind = record(change?.['kind'])?.['type'] ?? change?.['kind'];
      return [{ path, change: kind === 'add' ? ('created' as const) : kind === 'delete' ? ('deleted' as const) : ('changed' as const) }];
    });
  }
  const described = describeTool(part.name, part.input);
  if ((described.family === 'write' || described.family === 'edit') && described.subject && fields?.['grantRoot'] === undefined) {
    return [{ path: described.subject, change: described.family === 'write' ? 'created' : 'changed' }];
  }
  return [];
}

export function turnFiles(parts: readonly MessagePart[], cwd: string): TurnFile[] {
  const byPath = new Map<string, TurnFile>();
  for (const part of parts) {
    if (part.type !== 'tool' || part.status !== 'done') continue;
    for (const { path, change } of touched(part)) {
      const relative = relativeTo(cwd, path);
      const key = relative ?? normal(path);
      const before = byPath.get(key);
      // Made then edited is still new; changed then deleted is gone.
      const merged = before?.change === 'created' && change === 'changed' ? 'created' : change;
      const folderOf = relative ?? path;
      const cut = Math.max(folderOf.lastIndexOf('/'), folderOf.lastIndexOf('\\'));
      byPath.delete(key);
      byPath.set(key, {
        path,
        relative,
        absolute: isAbsolute(path) ? path : relative !== null ? join(cwd, relative) : null,
        name: fileName(path),
        folder: cut > 0 ? folderOf.slice(0, cut) : '',
        change: merged
      });
    }
  }
  return [...byPath.values()];
}

import type { Message, MessagePart, ToolDocument, Turn } from '@boite/contracts';
import { describeTool, fileName } from './tool-summary';
import { diffCounts, diffRows } from './diff';

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

/** Aggregate full turns only for the messages being drawn, without repeatedly copying their parts. */
export function visibleTurnFiles(messages: readonly Message[], turns: readonly Turn[], visible: ReadonlySet<string>, cwd: string): Map<string, { files: TurnFile[]; diffs: TurnDiff[]; cwd: string }> {
  const result = new Map<string, { files: TurnFile[]; diffs: TurnDiff[]; cwd: string }>();
  // A turn still running shows no card: its parts are not read at all, so a part arriving reads nothing again.
  const finished = turns.filter(turn => visible.has(turn.id) && turn.status !== 'running' && turn.status !== 'queued');
  if (finished.length === 0) return result;
  const wanted = new Set(finished.map(turn => turn.id));
  const parts = new Map<string, MessagePart[]>();
  for (const message of messages) {
    if (message.role !== 'assistant' || !wanted.has(message.turnId)) continue;
    const own = parts.get(message.turnId) ?? [];
    for (const part of message.parts) own.push(part);
    parts.set(message.turnId, own);
  }
  for (const turn of finished) {
    const own = parts.get(turn.id) ?? [];
    const files = turnFiles(own, cwd);
    if (files.length) result.set(turn.id, { files, diffs: turnDiffs(own), cwd });
  }
  return result;
}

export type TurnFileNode =
  | { kind: 'file'; key: string; name: string; file: TurnFile }
  | { kind: 'folder'; key: string; name: string; count: number; children: TurnFileNode[] };

/** Collapse single-folder chains so deep paths take one row. Keep outside paths absolute. */
export function turnFileTree(files: readonly TurnFile[]): TurnFileNode[] {
  const roots: TurnFileNode[] = [];
  for (const file of files) {
    let children = roots;
    let key = file.relative === null ? 'outside:' : 'inside:';
    const folders = file.relative === null ? [file.folder] : file.folder.split('/');
    for (const name of folders.filter(Boolean)) {
      key += `${name}/`;
      let folder = children.find((node) => node.kind === 'folder' && node.key === key);
      if (!folder || folder.kind !== 'folder') {
        folder = { kind: 'folder', key, name, count: 0, children: [] };
        children.push(folder);
      }
      folder.count++;
      children = folder.children;
    }
    children.push({ kind: 'file', key: file.path, name: file.name, file });
  }
  function compact(nodes: TurnFileNode[]): TurnFileNode[] {
    return nodes.map((node): TurnFileNode => {
      if (node.kind === 'file') return node;
      let folder = node;
      while (folder.children.length === 1 && folder.children[0]?.kind === 'folder') {
        const child = folder.children[0];
        folder = { ...child, name: `${folder.name}/${child.name}` };
      }
      return { ...folder, children: compact(folder.children) };
    }).sort((a, b) => a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'folder' ? -1 : 1);
  }
  return compact(roots);
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

/** One file's identity in an answer: relative to the thread's directory when inside it, else its absolute form. */
function fileKey(cwd: string, path: string): string {
  return relativeTo(cwd, path) ?? normal(path);
}

export function turnFiles(parts: readonly MessagePart[], cwd: string): TurnFile[] {
  const byPath = new Map<string, TurnFile>();
  for (const part of parts) {
    if (part.type !== 'tool' || part.status !== 'done') continue;
    for (const { path, change } of touched(part)) {
      const relative = relativeTo(cwd, path);
      const key = fileKey(cwd, path);
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

export type TurnDiff = Extract<ToolDocument, { kind: 'diff' }>;

/**
 * Every change one answer drew as a diff, call after call in the order they
 * ran: an edit made twice to one file shows both, which is what happened.
 */
export function turnDiffs(parts: readonly MessagePart[]): TurnDiff[] {
  return parts.flatMap((part) =>
    part.type === 'tool' && part.status === 'done'
      ? (part.documents ?? []).filter((document): document is TurnDiff => document.kind === 'diff')
      : []
  );
}

export interface LineCounts {
  added: number;
  removed: number;
}

/**
 * Lines added and removed, per file and in all, from the answer's own diffs,
 * keyed as `turnFiles` keys its rows: in `C:\w`, `src/a.ts` and `C:\w\src\a.ts`
 * are one file. A file with no diff document (a shell `rm`, a write the tool
 * did not draw) has no entry: its row shows no count rather than a false zero.
 */
export function turnLineCounts(diffs: readonly TurnDiff[], cwd: string): { total: LineCounts; byPath: Map<string, LineCounts> } {
  const byPath = new Map<string, LineCounts>();
  const total = { added: 0, removed: 0 };
  for (const doc of diffs) {
    const { added, removed } = diffCounts(diffRows(doc.oldText, doc.newText));
    const key = fileKey(cwd, doc.path);
    const seen = byPath.get(key) ?? { added: 0, removed: 0 };
    byPath.set(key, { added: seen.added + added, removed: seen.removed + removed });
    total.added += added;
    total.removed += removed;
  }
  return { total, byPath };
}

export function countsOf(counts: Map<string, LineCounts>, file: TurnFile): LineCounts | null {
  return counts.get(file.relative ?? normal(file.path)) ?? null;
}

/*
 * Short words for the companion's panel: what an agent wants to do, which
 * thread it is. Pure apart from the catalog, so it is tested in either language.
 */
import type { PermissionRequest, ThreadSummary } from '@boite/contracts';
import { fill, strings } from '../strings';

export interface RequestText {
  /** "Wants to run", "Wants to edit"... */
  verb: string;
  /** What the action is on (a command, a file, a URL), shown as code. Empty when unknown. */
  target: string;
}

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

/** The last two pieces of a path, to keep the line short. */
export function shortPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length <= 2 ? parts.join('/') : `…/${parts.slice(-2).join('/')}`;
}

export function describePermission(request: Pick<PermissionRequest, 'toolName' | 'input'>): RequestText {
  const input = (request.input && typeof request.input === 'object' ? request.input : {}) as Record<string, unknown>;
  const file = text(input.file_path) || text(input.path) || text(input.notebook_path);
  const verbs = strings.companion.verbs;
  switch (request.toolName) {
    case 'Bash':
    case 'PowerShell':
      return { verb: verbs.run, target: text(input.command) };
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return { verb: verbs.edit, target: file && shortPath(file) };
    case 'Write':
      return { verb: verbs.write, target: file && shortPath(file) };
    case 'Read':
      return { verb: verbs.read, target: file && shortPath(file) };
    case 'WebFetch':
      return { verb: verbs.open, target: text(input.url) };
    case 'WebSearch':
      return { verb: verbs.search, target: text(input.query) };
    default:
      return { verb: fill(verbs.use, { tool: request.toolName }), target: file ? shortPath(file) : '' };
  }
}

/** A thread's title and project, even for a thread no longer listed. */
export function threadLabel(threads: Pick<ThreadSummary, 'id' | 'title' | 'projectId'>[], projects: Map<string, string>, id: string): { title: string; project: string } {
  const thread = threads.find((entry) => entry.id === id);
  if (!thread) return { title: strings.companion.archivedThread, project: '' };
  return { title: thread.title || strings.companion.untitled, project: (thread.projectId && projects.get(thread.projectId)) || '' };
}

export function count(n: number, one: string, many: string): string {
  return n === 1 ? one : fill(many, { count: String(n) });
}

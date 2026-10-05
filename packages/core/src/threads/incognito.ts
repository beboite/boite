import { mkdirSync, rmSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import type { Project, RpcParams, ThreadId, ThreadSummary } from '@boite/contracts';
import type { Core } from '../core.ts';
import { removeDir } from '../fs-retry.ts';
import { messageOf, refused } from '../errors.ts';

/** True when `threads.create` asked for an incognito thread it may make: in the drafts, in a folder of the core's choosing. */
export function checkIncognito(params: RpcParams<'threads.create'>, project: Project, placed: boolean): boolean {
  if (params.incognito !== true) return false;
  if (project.kind !== 'drafts') {
    throw refused('an incognito conversation starts in the drafts project only', { projectId: project.id, field: 'incognito', expected: 'the drafts project' });
  }
  if (placed || (params.cwd !== undefined && params.cwd.length > 0)) {
    throw refused('incognito and cwd exclude each other: an incognito conversation works in a folder the core makes', { field: 'cwd', expected: 'absent with incognito' });
  }
  return true;
}

/**
 * `threads.remove` on an incognito family whose work has stopped. Nothing to
 * undo: the history leaves the journal now, events included, and the folder
 * the agent worked in goes with it.
 */
export async function eraseIncognito(core: Core, root: ThreadSummary, ids: ThreadId[]): Promise<void> {
  core.journal.deleteThreads(ids);
  for (const id of ids) core.bus.emit('thread.removed', { threadId: id, undoable: false });
  await eraseIncognitoFolder(core.dataDir, root.cwd, message => core.log('warn', message));
  if (root.projectId !== null && core.journal.getProject(root.projectId)) core.projects.announce(root.projectId);
}

/**
 * Incognito conversations work under the core's own data directory, never in
 * the drafts folder the user browses: nothing they leave there outlives them.
 * One folder per thread, named after its id.
 */
export function incognitoRoot(dataDir: string): string {
  return join(dataDir, 'incognito');
}

export function makeIncognitoFolder(dataDir: string, threadId: string): string {
  const path = join(incognitoRoot(dataDir), threadId);
  try {
    mkdirSync(path, { recursive: true });
  } catch (error) {
    throw refused(`the incognito conversation's folder cannot be made: ${messageOf(error)}`, { path });
  }
  return path;
}

/** True for a folder this module made: the only kind an erase may touch. */
function insideRoot(dataDir: string, path: string): boolean {
  const inner = relative(incognitoRoot(dataDir), path);
  return inner.length > 0 && !inner.startsWith('..') && !isAbsolute(inner);
}

/** One conversation's folder, after its processes stopped. A path outside the root is left alone. */
export async function eraseIncognitoFolder(dataDir: string, path: string, log: (message: string) => void): Promise<void> {
  if (insideRoot(dataDir, path)) await removeDir(path, log);
}

/**
 * Every incognito folder at once. At startup nothing runs yet, so a folder
 * still held is one a dead core's agent kept: it is logged and left, and the
 * next start tries again.
 */
export function eraseIncognitoRoot(dataDir: string, log: (message: string) => void): void {
  try {
    rmSync(incognitoRoot(dataDir), { recursive: true, force: true });
  } catch (error) {
    log(`could not erase the incognito folders in ${incognitoRoot(dataDir)}: ${messageOf(error)}`);
  }
}

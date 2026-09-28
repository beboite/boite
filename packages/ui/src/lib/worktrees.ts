import type { WorktreeEntry } from '@boite/contracts';

/** A thread that is not archived works there: no removal, forced or not. */
export function heldByLive(entry: WorktreeEntry): boolean {
  return entry.threadId !== null && !entry.threadArchived;
}

/** What the sweep takes: nothing to lose and nobody working there. A vanished folder only loses its registration. */
export function sweepable(entry: WorktreeEntry): boolean {
  return !heldByLive(entry) && !entry.dirty && !entry.unmerged;
}

/** The last part of a worktree's path, whichever separator the host uses. */
export function folderName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

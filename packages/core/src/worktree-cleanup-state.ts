import type { ProjectId, ThreadId, ThreadSummary, ThreadWorktreeRemoval } from '@boite/contracts';
import type { Journal } from './journal.ts';

/** The project policy: absent or true removes settled worktrees, false keeps them. */
export const autoRemoveWorktreesKey = (projectId: ProjectId | string): string => `project-auto-remove-worktrees:${projectId}`;
/** What the core removed under a thread, kept for the thread's lifetime. */
export const worktreeRemovalKey = (threadId: ThreadId | string): string => `worktree-removed:${threadId}`;

/**
 * The removal while the thread still names the removed folder. A thread moved
 * since then works elsewhere, and its old worktree is no longer its business.
 */
export function worktreeRemovalOf(journal: Journal, thread: Pick<ThreadSummary, 'id' | 'cwd'>): ThreadWorktreeRemoval | null {
  const removal = journal.getSetting(worktreeRemovalKey(thread.id)) as ThreadWorktreeRemoval | undefined;
  return removal !== undefined && removal.path === thread.cwd ? removal : null;
}

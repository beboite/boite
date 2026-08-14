/**
 * The delay between a thread being closed and its worktree being given back.
 *
 * Closing used to be the destructive step it never looked like. The X on a
 * sidebar row killed the process, dropped the row and deleted the checkout in
 * one go, so a misclick was final: the undo brought the row back, the directory
 * it named was gone, and every launch from then on answered `spawn failed: this
 * directory is not there`. The confirm dialog is not an answer to that: it is
 * off by default, and a dialog answered by reflex is the misclick.
 *
 * So the removal waits. Nothing else about closing changes: the process still
 * dies immediately and the thread still leaves the sidebar. What waits is the
 * one part that cannot be taken back, and restoring the thread inside the
 * window cancels it outright.
 *
 * The bookkeeping is here, away from the close path, because it is the answer
 * to "can this thread still be brought back", and that is worth a test that
 * mounts nothing.
 */

/**
 * How long a closed thread's worktree is kept.
 *
 * Long enough to notice the mistake and reach for the undo, short enough that a
 * session of ordinary closes does not leave a pile of checkouts on disk. What
 * is kept is empty by definition, since a worktree holding work refuses to be
 * removed at all, at the end of the wait as much as at the start.
 */
export const WORKTREE_GRACE_MS = 10 * 60_000;

const pending = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Gives the worktree back later, unless the thread comes back first.
 *
 * The work is passed in rather than done here: what "release" means belongs to
 * the close path, and this module is the clock.
 */
export function releaseAfterGrace(
  threadId: string,
  release: () => unknown,
  delayMs: number = WORKTREE_GRACE_MS,
) {
  // A thread closed, restored and closed again would otherwise leave the first
  // timer armed, and it fires on a thread that is now open.
  cancelRelease(threadId);
  pending.set(
    threadId,
    setTimeout(() => {
      pending.delete(threadId);
      void release();
    }, delayMs),
  );
}

/** Whether this thread still had a worktree waiting, and stopped it going. */
export function cancelRelease(threadId: string): boolean {
  const timer = pending.get(threadId);
  if (timer === undefined) return false;
  clearTimeout(timer);
  pending.delete(threadId);
  return true;
}

/** How many worktrees are waiting out their grace. Diagnostics and tests. */
export function pendingReleases(): number {
  return pending.size;
}

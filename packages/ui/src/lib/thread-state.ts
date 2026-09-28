import type { ThreadSummary } from '@boite/contracts';

/**
 * What a thread row says in place of its time: the agent works, needs the
 * user, failed, finished something not read yet, waits for a slot, or ended
 * its turn with work still running in the background (a monitor, a shell).
 * Null for a thread at rest the user has seen, which shows when it was last
 * used.
 */
export type ThreadState = 'working' | 'waiting' | 'error' | 'done' | 'queued' | 'monitoring' | 'background';

export function threadState(thread: Pick<ThreadSummary, 'status' | 'unread' | 'backgroundWork'>): ThreadState | null {
  switch (thread.status) {
    case 'running':
      return 'working';
    case 'waiting':
      return 'waiting';
    case 'error':
      return 'error';
    case 'queued':
      return 'queued';
    case 'idle': {
      const kinds = thread.backgroundWork?.kinds ?? [];
      // Not finished while the agent still watches or runs something, read or not.
      if (kinds.length > 0) return kinds.every(kind => kind === 'monitor') ? 'monitoring' : 'background';
      return thread.unread ? 'done' : null;
    }
  }
}

/** What a folded project says for the threads it hides, most urgent first: the user's turn, a failure, work, then news. */
const ROLLUP_ORDER: ThreadState[] = ['waiting', 'error', 'working', 'monitoring', 'background', 'done'];

/** The most urgent state among a project's threads and how many threads are in it; null when every one is at rest. */
export function projectRollup(threads: readonly Pick<ThreadSummary, 'status' | 'unread' | 'backgroundWork'>[]): { kind: ThreadState; count: number } | null {
  const states = threads.map(threadState);
  for (const kind of ROLLUP_ORDER) {
    const count = states.filter(state => state === kind).length;
    if (count > 0) return { kind, count };
  }
  return null;
}

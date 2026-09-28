import type { ThreadSummary } from '@boite/contracts';

/**
 * What a thread row says in place of its time: the agent works, needs the
 * user, failed, finished something not read yet, or waits for a slot. Null
 * for a thread at rest the user has seen, which shows when it was last used.
 */
export type ThreadState = 'working' | 'waiting' | 'error' | 'done' | 'queued';

export function threadState(thread: Pick<ThreadSummary, 'status' | 'unread'>): ThreadState | null {
  switch (thread.status) {
    case 'running':
      return 'working';
    case 'waiting':
      return 'waiting';
    case 'error':
      return 'error';
    case 'queued':
      return 'queued';
    case 'idle':
      return thread.unread ? 'done' : null;
  }
}

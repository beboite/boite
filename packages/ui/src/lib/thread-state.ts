import type { ThreadSummary } from '@boite/contracts';

/**
 * What a thread row says in place of its time: the agent works, needs the
 * user, failed, finished something not read yet, waits for a slot, ended its
 * turn waiting on the agents it delegated to, or ended it with work still
 * running in the background (a monitor, a shell). Null for a thread at rest
 * the user has seen, which shows when it was last used.
 */
export type ThreadState = 'working' | 'waiting' | 'error' | 'done' | 'queued' | 'delegating' | 'monitoring' | 'background';

type StateFields = Pick<ThreadSummary, 'status' | 'unread' | 'backgroundWork' | 'openQuestions'>;

/**
 * The thread waits on the user: a card that stopped its turn, or a question
 * the agent asked without stopping (`boite ask`), which leaves the status at
 * `running` or `idle`.
 */
export function needsUser(thread: Pick<ThreadSummary, 'status' | 'openQuestions'>): boolean {
  return thread.status === 'waiting' || (thread.openQuestions ?? 0) > 0;
}

/** `delegated`: how many of the thread's delegated agents still have a turn under way. */
export function threadState(thread: StateFields, delegated = 0): ThreadState | null {
  if (needsUser(thread)) return 'waiting';
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
      // The parent's turn ended, its work did not: its result comes back with the sub-agents'.
      if (delegated > 0) return 'delegating';
      const kinds = thread.backgroundWork?.kinds ?? [];
      // Not finished while the agent still watches or runs something, read or not.
      if (kinds.length > 0) return kinds.every(kind => kind === 'monitor') ? 'monitoring' : 'background';
      return thread.unread ? 'done' : null;
    }
  }
}

/** What a folded project says for the threads it hides, most urgent first: the user's turn, a failure, work, work waiting for a slot, then news. */
const ROLLUP_ORDER: ThreadState[] = ['waiting', 'error', 'working', 'delegating', 'monitoring', 'background', 'queued', 'done'];

/**
 * The most urgent state among a project's threads and how many threads are in
 * it; null when every one is at rest. `delegated` counts a thread's working
 * delegated agents, as `threadState` takes it.
 */
export function projectRollup<T extends StateFields>(threads: readonly T[], delegated: (thread: T) => number = () => 0): { kind: ThreadState; count: number } | null {
  const states = threads.map(thread => threadState(thread, delegated(thread)));
  for (const kind of ROLLUP_ORDER) {
    const count = states.filter(state => state === kind).length;
    if (count > 0) return { kind, count };
  }
  return null;
}

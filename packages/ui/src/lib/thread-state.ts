import type { ThreadStatus, ThreadSummary, WorkflowStatus, WorkflowStepStatus } from '@boite/contracts';
import { strings } from './strings';

/**
 * What a thread row says in place of its time: the agent works, needs the
 * user, failed, finished something not read yet, waits for a slot, ended its
 * turn waiting on the agents it delegated to, or ended it with work still
 * running in the background (a monitor, a shell), or watching a pull request
 * that will wake it. A delegated agent whose
 * background work ended without waking it is `interrupted`. Null for a thread
 * at rest the user has seen, which shows when it was last used.
 */
export type ThreadState = 'working' | 'waiting' | 'error' | 'interrupted' | 'done' | 'queued' | 'delegating' | 'monitoring' | 'background' | 'watching';

type StateFields = Pick<ThreadSummary, 'status' | 'unread' | 'backgroundWork' | 'openQuestions'> & Partial<Pick<ThreadSummary, 'backgroundWait' | 'pullRequestWatches'>>;

/**
 * The thread waits on the user: a card that stopped its turn, or a question
 * the agent asked without stopping (`boite ask`), which leaves the status at
 * `running` or `idle`.
 */
export function needsUser(thread: Pick<ThreadSummary, 'status' | 'openQuestions'>): boolean {
  return thread.status === 'waiting' || (thread.openQuestions ?? 0) > 0;
}

/** What an agent's picture shows for the thread it works in: waiting on the user, at work while queued or running, else at rest. */
export function avatarStatus(status: ThreadStatus | undefined): 'running' | 'waiting' | 'idle' {
  return status === 'waiting' ? 'waiting' : status === 'running' || status === 'queued' ? 'running' : 'idle';
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
      const wait = thread.backgroundWait;
      if (wait?.state === 'interrupted') return 'interrupted';
      const kinds = thread.backgroundWork?.kinds ?? [];
      // Not finished while the agent still watches or runs something, read or not.
      if (kinds.length > 0) return kinds.every(kind => kind === 'monitor') ? 'monitoring' : 'background';
      // The work ended a moment ago and its wake turn has not started yet.
      if (wait?.state === 'waiting') return 'background';
      // A pull request it watches will wake it: not done yet, read or not.
      if ((thread.pullRequestWatches?.length ?? 0) > 0) return 'watching';
      return thread.unread ? 'done' : null;
    }
  }
}

/** What a folded project says for the threads it hides, most urgent first: the user's turn, a failure, work, work waiting for a slot, then news. */
const ROLLUP_ORDER: ThreadState[] = ['waiting', 'error', 'interrupted', 'working', 'delegating', 'monitoring', 'background', 'watching', 'queued', 'done'];

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

/** The hue a status mark draws, shared by threads, agents, workflow runs and their steps. */
export type StatusTone = 'running' | 'waiting' | 'queued' | 'error' | 'done' | 'stopped' | 'skipped' | 'paused' | 'unread' | 'idle';
export type StatusMarkProps = { tone: StatusTone; label: string };

/** A thread's mark: an idle thread with news to read shows it, the rest show their status. */
export function threadTone(status: ThreadStatus, unread = false): StatusMarkProps {
  if (status === 'idle' && unread) return { tone: 'unread', label: strings.sidebar.unread };
  return { tone: status, label: strings.threadStatus[status] };
}

/** A run's mark, or a step's: a failure draws a thread's error, a step waiting for its turn an idle ring. */
export function workflowTone(status: WorkflowStatus | WorkflowStepStatus, run = false): StatusMarkProps {
  const label = run ? strings.workflow.status[status as WorkflowStatus] : strings.workflow.stepStatus[status as WorkflowStepStatus];
  return { tone: status === 'failed' ? 'error' : status === 'waiting' ? 'idle' : status, label };
}

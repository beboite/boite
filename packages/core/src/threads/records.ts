import type { ThreadId, ThreadStatus, ThreadSummary } from '@boite/contracts';
import type { Core } from '../core.ts';

// The thread row as every part of the store writes it: one event, the row, and the clients told.

export function setThreadStatus(core: Core, threadId: ThreadId, status: ThreadStatus): void {
  const thread = core.journal.getThread(threadId);
  if (thread === null || thread.status === status) return;
  saveThread(core, { ...thread, status }, 'thread.status');
}

export function saveThread(core: Core, thread: ThreadSummary, eventType: string): ThreadSummary {
  const next: ThreadSummary = { ...thread, updatedAt: Date.now() };
  core.journal.append({ type: eventType, threadId: next.id, version: 1, payload: next }, () => {
    core.journal.putThread(next);
  });
  const summary = withLoad(core, next);
  core.bus.emit('thread.updated', summary);
  return summary;
}

/** The row as a client sees it: the stored summary plus what only lives in memory. */
export function withLoad(core: Core, thread: ThreadSummary): ThreadSummary {
  const busy = thread.status === 'running' || thread.status === 'waiting';
  const tasks = core.threads?.agentState.background.get(thread.id) ?? [];
  return {
    ...thread,
    load: core.procs.loadOf(thread.id),
    runningSince: busy ? core.journal.runningSince(thread.id) : null,
    progress: busy ? core.threads?.progress?.get(thread.id) ?? null : null,
    backgroundWork: tasks.length === 0 ? null : { kinds: tasks.map(task => task.kind), since: Math.min(...tasks.map(task => task.startedAt)) },
    pendingMove: core.threads?.moves?.pendingOf(thread.id) ?? null,
    pendingAnswers: [...(core.threads?.deferred?.deferredAnswers.get(thread.id) ?? [])],
  };
}

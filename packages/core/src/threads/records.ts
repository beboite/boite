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

export function withLoad(core: Core, thread: ThreadSummary): ThreadSummary {
  return { ...thread, load: core.procs.loadOf(thread.id) };
}

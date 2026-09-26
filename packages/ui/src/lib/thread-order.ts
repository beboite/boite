import type { ThreadSummary } from '@boite/contracts';

/** A thread that waits on the user first, then the ones at work, then the rest. */
const LIVE: Record<ThreadSummary['status'], number> = { waiting: 0, running: 1, queued: 2, error: 3, idle: 4 };

/** When the user last spoke in it. `updatedAt` moves on every event, so ordering by it makes rows jitter. */
export function lastActivity(thread: Pick<ThreadSummary, 'lastUserMessageAt' | 'createdAt'>): number {
  return thread.lastUserMessageAt ?? thread.createdAt;
}

/** The sidebar's order, in both views: pinned threads, then live ones, then the last message. */
export function compareThreads(
  a: Pick<ThreadSummary, 'pinned' | 'status' | 'lastUserMessageAt' | 'createdAt'>,
  b: Pick<ThreadSummary, 'pinned' | 'status' | 'lastUserMessageAt' | 'createdAt'>
): number {
  return Number(b.pinned) - Number(a.pinned) || LIVE[a.status] - LIVE[b.status] || lastActivity(b) - lastActivity(a);
}

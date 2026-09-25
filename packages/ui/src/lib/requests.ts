import type { RequestId, ThreadId } from '@boite/contracts';

/** What the permission and question cards share: an id, the thread asking, and when it asked. */
interface Request {
  id: RequestId;
  threadId: ThreadId;
  createdAt: number;
}

/**
 * The requests of one thread, or of none. The same object comes back when there
 * was nothing to drop, so a filter that changes nothing re-renders nothing.
 */
export function requestsOf<T extends { threadId: ThreadId }>(
  records: Record<RequestId, T>,
  keep: (threadId: ThreadId) => boolean
): Record<RequestId, T> {
  const kept: Record<RequestId, T> = {};
  let dropped = false;
  for (const [id, record] of Object.entries(records)) {
    if (keep(record.threadId)) kept[id] = record;
    else dropped = true;
  }
  return dropped ? kept : records;
}

/**
 * What a list of requests speaks for: every thread (`reload()`), one thread
 * (`open()`), or nothing but itself, which is one event arriving.
 */
export type RequestScope = ThreadId | 'all' | 'one';

/** True while `scope` says nothing about this request, so it is kept as it is. */
function outside(request: { threadId: ThreadId }, scope: RequestScope): boolean {
  if (scope === 'one') return true;
  if (scope === 'all') return false;
  return request.threadId !== scope;
}

/**
 * `permission.requested` reaches a subscribed socket once and is gone. A page
 * that loads while a turn waits gets the same request from `permissions.list`,
 * so both paths land here and the same id never makes a second card. Questions
 * go through the same rebuild for the same reasons.
 *
 * `scope` is what the list the caller holds speaks for. A list is the core's
 * whole answer about it, empty included, so an id the core no longer carries
 * was settled where this client could not hear it and its card must stop
 * offering the button. An event carries one request and speaks for nothing
 * else, so it comes in as `'one'` and drops nothing.
 */
export function mergeRequests<T extends Request>(
  pending: readonly T[],
  records: Record<RequestId, T>,
  requests: readonly T[],
  scope: RequestScope
): { pending: T[]; records: Record<RequestId, T> } {
  const byId = new Map(pending.filter((request) => outside(request, scope)).map((request) => [request.id, request] as const));
  for (const request of requests) byId.set(request.id, request);
  return {
    pending: [...byId.values()].sort((a, b) => a.createdAt - b.createdAt),
    records: { ...records, ...Object.fromEntries(requests.map((request) => [request.id, request] as const)) }
  };
}

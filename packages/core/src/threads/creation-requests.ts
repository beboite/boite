import type { RpcParams, ThreadId, ThreadSummary } from '@boite/contracts';
import { invalidParams, refused } from '../errors.ts';

/** How long a creation's request id answers with the thread it made: well past a reconnect. */
const RECEIPT_MS = 60 * 60_000;
/** Receipts kept at most; the oldest leaves first. */
const RECEIPT_LIMIT = 512;
const REQUEST_ID_MAX = 128;

type Receipt = { expiresAt: number; key: string; created: Promise<ThreadId> };

/**
 * `threads.create` under a `clientRequestId`. A client that lost the answer
 * with its connection asks again under the same id and gets the conversation
 * the first call made, not a second one: a conversation queued on a device
 * while its machine was away starts once however often the link drops on the
 * way. Kept in memory, so a core restart forgets them.
 */
export class CreationRequests {
  private readonly receipts = new Map<string, Receipt>();

  async once(params: RpcParams<'threads.create'>, create: () => Promise<ThreadSummary>, lookup: (threadId: ThreadId) => ThreadSummary | null): Promise<ThreadSummary> {
    const id = params.clientRequestId;
    if (id === undefined) return create();
    if (typeof id !== 'string' || id.length === 0 || id.length > REQUEST_ID_MAX) {
      throw invalidParams(`clientRequestId must be a string of 1 to ${REQUEST_ID_MAX} characters`, { field: 'clientRequestId', expected: `1 to ${REQUEST_ID_MAX} characters` });
    }
    // Everything that shapes the conversation: a repeat that differs is another request, refused.
    const key = JSON.stringify([params.projectId, params.providerId, params.accountId, params.title ?? null, params.cwd ?? null,
      params.model ?? null, params.effort ?? null, params.speed ?? null, params.permissionMode ?? 'default', params.worktree ?? null,
      params.incognito === true, params.context ?? null]);
    const now = Date.now();
    for (const [stale, receipt] of this.receipts) if (receipt.expiresAt <= now) this.receipts.delete(stale);
    const previous = this.receipts.get(id);
    if (previous) {
      if (previous.key !== key) throw refused('clientRequestId was already used for another conversation', { field: 'clientRequestId', expected: 'a new id for a different conversation' });
      const threadId = await previous.created;
      const thread = lookup(threadId);
      if (thread === null) throw refused('the conversation this request started was deleted since', { field: 'clientRequestId', threadId, reason: 'deleted' });
      return thread;
    }
    const made = create();
    const receipt: Receipt = { expiresAt: now + RECEIPT_MS, key, created: made.then(thread => thread.id) };
    this.receipts.set(id, receipt);
    while (this.receipts.size > RECEIPT_LIMIT) this.receipts.delete(this.receipts.keys().next().value!);
    // A creation that failed made nothing: the same id may try again.
    receipt.created.catch(() => { if (this.receipts.get(id) === receipt) this.receipts.delete(id); });
    return made;
  }
}

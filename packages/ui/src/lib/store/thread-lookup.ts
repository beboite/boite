import type { Message, Thread, ThreadId, ThreadSummary } from '@boite/contracts';
import { lastIndexById } from '../thread-rows';

/**
 * The thread rows by id, for what an event looks up: a load sample is one
 * `get` instead of a `find` through the `$state` proxy over every row. Built
 * again when the list is replaced or grew behind it.
 */
export class RowIndex {
  #rows = new Map<ThreadId, ThreadSummary>();
  #indexed: ThreadSummary[] | null = null;
  #length = 0;

  of(rows: ThreadSummary[], threadId: ThreadId): ThreadSummary | undefined {
    if (rows !== this.#indexed || rows.length !== this.#length) {
      this.#rows.clear();
      for (const row of rows) this.#rows.set(row.id, row);
      this.#indexed = rows;
      this.#length = rows.length;
    }
    const row = this.#rows.get(threadId);
    return row?.id === threadId ? row : undefined;
  }

  /** Appends `summary` and follows the push instead of building the index again. */
  push(rows: ThreadSummary[], summary: ThreadSummary): void {
    rows.push(summary);
    if (rows !== this.#indexed || rows.length !== this.#length + 1) return;
    this.#rows.set(summary.id, rows[rows.length - 1]!);
    this.#length = rows.length;
  }
}


/**
 * Each copy of thread `threadId` this client holds, once: the open thread, the
 * delegated one and pages a press preloaded. Usually one or none, so no Set and
 * no array of every candidate is built per delta.
 */
export function threadCopies(threadId: ThreadId, open: Thread | null | undefined, delegated: Thread | null | undefined, pages: Iterable<Thread | null | undefined>): Thread[] {
  const held: Thread[] = [];
  if (open && open.id === threadId) held.push(open);
  if (delegated && delegated.id === threadId && delegated !== open) held.push(delegated);
  for (const page of pages) if (page && page.id === threadId && !held.includes(page)) held.push(page);
  return held;
}

/** The message `messageId` in each copy, once. */
export function messageCopies(copies: Thread[], messageId: string): Message[] {
  const messages: Message[] = [];
  for (const thread of copies) {
    const message = thread.messages[lastIndexById(thread.messages, messageId)];
    if (message && !messages.includes(message)) messages.push(message);
  }
  return messages;
}

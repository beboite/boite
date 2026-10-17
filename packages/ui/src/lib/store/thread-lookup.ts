import type { Message, Thread, ThreadId, ThreadSummary } from '@boite/contracts';
import { lastIndexById } from '../thread-rows';

/**
 * Where each thread row sits, by id, for what an event looks up: a load sample
 * is one `get` and one read instead of a `find` through the `$state` proxy over
 * every row. It holds positions, not rows, and checks the id it reads there, so
 * a row another writer replaced in place (`restoreThread`) is the one returned.
 * Built again when the list is replaced, grew or moved behind it; an id it does
 * not hold costs the `find` it replaced.
 */
export class RowIndex {
  #at = new Map<ThreadId, number>();
  #indexed: ThreadSummary[] | null = null;
  #length = 0;

  of(rows: ThreadSummary[], threadId: ThreadId): ThreadSummary | undefined {
    if (rows !== this.#indexed || rows.length !== this.#length) this.#build(rows);
    const at = this.#at.get(threadId);
    const row = at === undefined ? undefined : rows[at];
    if (row?.id === threadId) return row;
    const found = rows.find(held => held.id === threadId);
    if (found) this.#build(rows);
    return found;
  }

  /** Appends `summary` and follows the push instead of building the index again. */
  push(rows: ThreadSummary[], summary: ThreadSummary): void {
    rows.push(summary);
    if (rows !== this.#indexed || rows.length !== this.#length + 1) return;
    this.#at.set(summary.id, rows.length - 1);
    this.#length = rows.length;
  }

  #build(rows: ThreadSummary[]): void {
    this.#at.clear();
    rows.forEach((row, at) => this.#at.set(row.id, at));
    this.#indexed = rows;
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

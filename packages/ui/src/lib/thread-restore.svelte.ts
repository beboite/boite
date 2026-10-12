import type { ThreadId, ThreadSummary } from '@boite/contracts';
import { restoreThread } from './archive';
import { errorText } from './errors';
import type { Store } from './store.svelte';
import { deleteThread } from './thread-removal';

/**
 * Restore and Delete for archived threads, as a done row, the notice under a
 * done conversation and the Settings list run them: one at a time, every
 * button that would ask again waiting for the one under way. A failure goes
 * to the owning machine's banner, unless that machine reconnected meanwhile.
 */
export class ThreadRestore {
  restoring = $state<ThreadId | null>(null);
  deleting = $state<ThreadId | null>(null);
  readonly busy = $derived(this.restoring !== null || this.deleting !== null);

  /** The restored summary, or null when refused, failed or answered by a client since replaced. */
  async restore(store: Store, threadId: ThreadId): Promise<ThreadSummary | null> {
    if (this.busy) return null;
    const current = sameClient(store);
    this.restoring = threadId;
    try {
      const summary = await restoreThread(store, threadId);
      return current() ? summary : null;
    } catch (error) {
      if (current()) store.error = errorText(error);
      return null;
    } finally {
      this.restoring = null;
    }
  }

  /**
   * `keepLock` holds the lock on success for a row that stays until its list
   * reloads, so a second pick cannot ask the core again and raise an error.
   */
  async remove(store: Store, thread: ThreadSummary, keepLock = false): Promise<boolean> {
    if (this.busy) return false;
    const current = sameClient(store);
    this.deleting = thread.id;
    let removed = false;
    try {
      removed = await deleteThread(store, thread);
    } catch (error) {
      if (current()) store.error = errorText(error);
    } finally {
      if (!removed || !keepLock) this.deleting = null;
    }
    return removed;
  }

  /** Forgets a restore or delete still on its way, for a list rebuilt from a new connection. */
  reset() {
    this.restoring = null;
    this.deleting = null;
  }
}

function sameClient(store: Store): () => boolean {
  const client = store.client;
  const generation = store.clientGeneration;
  return () => store.client === client && store.clientGeneration === generation;
}

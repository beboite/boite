import { tick } from 'svelte';
import type { ThreadId, ThreadStatus, ThreadSummary } from '@boite/contracts';
import { confirm } from './confirm.svelte';
import { focusComposer } from './focus';
import { strings } from './strings';
import type { Store } from './store.svelte';

const LIVE: ThreadStatus[] = ['running', 'queued', 'waiting'];

/**
 * Whether putting this thread away would cut work short: its own turn, a
 * sub-thread still working, or a card waiting for an answer. Archiving stops
 * all of it, and a restore brings none of it back.
 */
export function archiveInterrupts(store: Store, threadId: ThreadId): boolean {
  const thread = store.threads.find((t) => t.id === threadId) ?? (store.openThread?.id === threadId ? store.openThread : null);
  if (thread && LIVE.includes(thread.status)) return true;
  if (store.threads.some((t) => t.parentThreadId === threadId && !t.archived && LIVE.includes(t.status))) return true;
  return store.pendingPermissions.some((r) => r.threadId === threadId) || store.pendingQuestions.some((q) => q.threadId === threadId);
}

/**
 * The one way the UI archives a thread (row menu, title menu, palette). A thread
 * with live work asks first in the app's own dialog; an idle one goes at once,
 * since Settings, General, Archived threads brings it back. The keyboard lands
 * in the composer afterwards, never on the page, where Escape stops a turn.
 */
export async function archiveThread(store: Store, threadId: ThreadId): Promise<boolean> {
  if (archiveInterrupts(store, threadId)) {
    const ok = await confirm.ask({
      title: strings.sidebar.archiveTitle,
      body: strings.sidebar.archiveBody,
      confirmLabel: strings.sidebar.archive,
      cancelLabel: strings.common.cancel,
      danger: true
    });
    if (!ok) return false;
  }
  await store.archive(threadId);
  await tick();
  focusComposer();
  return true;
}

/** The archived threads of this machine, read when asked for and never at startup. */
export async function archivedThreads(store: Store): Promise<ThreadSummary[]> {
  const client = store.client;
  if (!client) return [];
  const all = await client.call('threads.list', { includeArchived: true });
  return all.filter((t) => t.archived && !t.parentThreadId).sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Takes a thread out of the archive; its row comes back in the sidebar. */
export async function restoreThread(store: Store, threadId: ThreadId): Promise<ThreadSummary> {
  const client = store.client;
  if (!client) throw new Error(strings.connection.unavailable);
  const summary = await client.call('threads.archive', { threadId, archived: false });
  const index = store.threads.findIndex((t) => t.id === summary.id);
  if (index >= 0) store.threads[index] = summary;
  else store.threads.push(summary);
  return summary;
}

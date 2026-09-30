import { tick } from 'svelte';
import { closed } from './archive-history';
import type { ProjectId, ThreadId, ThreadStatus, ThreadSummary } from '@boite/contracts';
import { confirm } from './confirm.svelte';
import { focusComposer } from './focus';
import { fill, strings } from './strings';
import { undo } from './undo.svelte';
import { workspace } from './workspace.svelte';
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
 * since the archived threads list in Settings brings it back. Archived, the
 * keyboard lands in the composer; cancelled, the dialog gives it back to what
 * had it. Never on the page, where Escape stops a turn.
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
  const title = (store.threads.find((t) => t.id === threadId) ?? store.openThread)?.title ?? '';
  const wasOpen = store.openThread?.id === threadId;
  await store.archive(threadId);
  // Refused, the row is still there and the banner says why: nothing to take back.
  if (store.threads.some((t) => t.id === threadId)) return false;
  const entry = { store, threadId, undoId: 0 };
  closed.push(entry);
  // The way back for a few seconds; the archived list in Settings keeps it after.
  undo.offer(fill(strings.sidebar.archivedToast, { title }), async () => {
    await restoreThread(store, threadId);
    // The thread that was on screen comes back on screen.
    if (wasOpen) await workspace.select(store, threadId);
  });
  entry.undoId = undo.current?.id ?? 0;
  await tick();
  focusComposer();
  return true;
}

/**
 * Brings back the thread archived last and opens it, like a browser reopens
 * the tab just closed. Those archived from this window come first, newest
 * first, skipping one already restored elsewhere; past them, or after a
 * reload, the machine's most recently archived thread. False when there is
 * none.
 */
export async function reopenLastArchived(store: Store): Promise<boolean> {
  let target: { store: Store; threadId: ThreadId } | undefined;
  while ((target = closed.pop())) {
    const summary = target.store.threads.find((t) => t.id === target!.threadId);
    if (!summary || summary.archived) break;
  }
  if (!target) {
    const [newest] = await archivedThreads(store);
    if (!newest) return false;
    target = { store, threadId: newest.id };
  }
  try {
    await restoreThread(target.store, target.threadId);
  } catch (error) {
    target.store.error = error instanceof Error ? error.message : String(error);
    return false;
  }
  await workspace.select(target.store, target.threadId);
  return true;
}

/** The archived threads of this machine, or of one project, read when asked for and never at startup. */
export async function archivedThreads(store: Store, projectId?: ProjectId): Promise<ThreadSummary[]> {
  const client = store.client;
  if (!client) return [];
  const all = await client.call('threads.list', projectId ? { projectId, includeArchived: true } : { includeArchived: true });
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

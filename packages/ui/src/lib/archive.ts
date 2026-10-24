import { errorText } from './errors';
import { tick } from 'svelte';
import { closed, forgetArchivedThread } from './archive-history';
import type { ProjectId, ThreadId, ThreadSummary } from '@boite/contracts';
import { focusComposer } from './focus';
import { fill, strings } from './strings';
import { undo } from './undo.svelte';
import { workspace } from './workspace.svelte';
import type { Store } from './store.svelte';
import { projectThread } from './thread-rows';

/**
 * The one way the UI archives a thread (row menu, title menu, palette). It goes
 * at once, live work included: the Undo toast, then the archived threads list
 * in Settings, bring the conversation back, not the work that was stopped.
 * Archived, the keyboard lands in the composer.
 */
export async function archiveThread(store: Store, threadId: ThreadId, options: { done?: boolean } = {}): Promise<boolean> {
  const title = (store.threads.find((t) => t.id === threadId) ?? store.openThread)?.title ?? '';
  const wasOpen = store.openThread?.id === threadId;
  await store.archive(threadId, options.done === true);
  // Refused, the row is still there and the banner says why: nothing to take back.
  if (store.threads.some((t) => t.id === threadId)) return false;
  const entry = { store, threadId, undoId: 0 };
  closed.push(entry);
  // The way back for a few seconds; the archived list in Settings keeps it after.
  undo.offer(fill(options.done ? strings.sidebar.doneToast : strings.sidebar.archivedToast, { title }), async () => {
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
 * the tab just closed. "Last" is the core's archive time, so a thread put away
 * from another computer, the phone or an agent counts as much as one archived
 * in this window; an automatic archive after a merged PR does not, nobody
 * closed it. The machines this window archived on are asked too, and the
 * newest of them wins. False when there is none.
 */
export async function reopenLastArchived(store: Store): Promise<boolean> {
  const owners = [...new Set([store, ...closed.map((entry) => entry.store)])].map((owner) => {
    const client = owner.client;
    const generation = owner.clientGeneration;
    return { owner, current: () => owner.client === client && owner.clientGeneration === generation };
  });
  // A machine that cannot answer has nothing to bring back; the active one's
  // failure is shown only when no other machine had a thread either.
  let failure: unknown;
  const lists = await Promise.all(owners.map(async ({ owner, current }) => {
    const threads = await archivedThreads(owner).catch((error: unknown) => {
      if (owner === store && current()) failure = error;
      return [];
    });
    return current() ? threads.filter((thread) => !thread.archiveReason).map((thread) => ({ store: owner, thread })) : [];
  }));
  // Two archives in the same millisecond: the one made later in this window wins.
  const order = (c: Archived) => closed.findLastIndex((entry) => entry.store === c.store && entry.threadId === c.thread.id);
  const newer = (a: Archived, b: Archived) =>
    archivedTime(a.thread) !== archivedTime(b.thread) ? archivedTime(a.thread) > archivedTime(b.thread) : order(a) > order(b);
  let target: Archived | undefined;
  for (const candidate of lists.flat()) if (!target || newer(candidate, target)) target = candidate;
  if (!target) {
    if (failure !== undefined && owners[0]!.current()) store.error = errorText(failure);
    return false;
  }
  const { store: owner, thread } = target;
  const current = owners.find((entry) => entry.owner === owner)!.current;
  try {
    await restoreThread(owner, thread.id);
    if (!current()) return false;
    // Back in the sidebar, its Undo toast and its place in this window's history go.
    forgetArchivedThread(owner, thread.id);
    await workspace.select(owner, thread.id);
    return true;
  } catch (error) {
    if (current()) owner.error = errorText(error);
    return false;
  }
}

type Archived = { store: Store; thread: ThreadSummary };

/** When a thread was put away; a thread archived by an older core only has its last change. */
export function archivedTime(thread: ThreadSummary): number {
  return thread.archivedAt ?? thread.updatedAt;
}

/** The archived threads of this machine, or of one project, newest archived first, read when asked for and never at startup. */
export async function archivedThreads(store: Store, projectId?: ProjectId): Promise<ThreadSummary[]> {
  const client = store.client;
  if (!client) return [];
  const all = await client.call('threads.list', projectId ? { projectId, includeArchived: true } : { includeArchived: true });
  const parents = new Map([...store.threads, ...all].map(thread => [thread.id, thread]));
  return all.filter(t => t.archived && !t.incognito && (projectId === undefined || t.projectId === projectId)
    && (!t.parentThreadId || projectThread(t, parents.get(t.parentThreadId)))).sort((a, b) => archivedTime(b) - archivedTime(a));
}

/** Takes a thread out of the archive; its row comes back in the sidebar. */
export async function restoreThread(store: Store, threadId: ThreadId): Promise<ThreadSummary> {
  const client = store.client;
  const clientGeneration = store.clientGeneration;
  if (!client) throw new Error(strings.connection.unavailable);
  const summary = await client.call('threads.archive', { threadId, archived: false });
  if (store.client !== client || store.clientGeneration !== clientGeneration) throw new Error(strings.connection.unavailable);
  const index = store.threads.findIndex((t) => t.id === summary.id);
  if (index >= 0) store.threads[index] = summary;
  else store.threads.push(summary);
  return summary;
}

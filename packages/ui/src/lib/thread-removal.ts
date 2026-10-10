import { tick } from 'svelte';
import type { ThreadSummary } from '@boite/contracts';
import { focusComposer } from './focus';
import { fill, strings } from './strings';
import type { Store } from './store.svelte';
import { undo } from './undo.svelte';
import { workspace } from './workspace.svelte';
import { confirm } from './confirm.svelte';

export function canDeleteThread(thread: ThreadSummary): boolean {
  return !thread.parentThreadId && !thread.agentSessionId;
}

/** Every deletion entry point requires the conversation's exact name; undo remains available. */
export async function deleteThread(store: Store, thread: ThreadSummary): Promise<boolean> {
  if (!canDeleteThread(thread)) return false;
  const name = thread.title.trim() ? thread.title : strings.usage.untitled;
  if (!await confirm.ask({
    title: fill(strings.sidebar.deleteTitle, { title: name }),
    body: strings.sidebar.deleteBody,
    confirmLabel: strings.sidebar.delete,
    cancelLabel: strings.common.cancel,
    danger: true,
    requiredText: name,
    inputLabel: strings.sidebar.deleteName,
  })) return false;
  if (!(await store.removeThread(thread.id))) return false;
  // An incognito conversation is erased by the core: there is nothing to bring back.
  if (thread.incognito) { await tick(); focusComposer(); return true; }
  undo.offer(fill(strings.sidebar.deletedToast, { title: thread.title }), async () => {
    if (!(await store.restoreDeletedThread(thread.id))) throw new Error(store.error ?? strings.connection.unavailable);
    await workspace.select(store, thread.id);
  }, { session: store.core ? { store, startedAt: store.core.startedAt } : undefined });
  await tick();
  focusComposer();
  return true;
}

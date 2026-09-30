import { tick } from 'svelte';
import type { ThreadSummary } from '@boite/contracts';
import { confirm } from './confirm.svelte';
import { focusComposer } from './focus';
import { fill, strings } from './strings';
import type { Store } from './store.svelte';
import { undo } from './undo.svelte';
import { workspace } from './workspace.svelte';

export function canDeleteThread(store: Store, thread: ThreadSummary): boolean {
  return store.owner && !thread.parentThreadId && !thread.agentSessionId;
}

/** Every delete entry uses the same confirmation, including idle and archived threads. */
export async function deleteThread(store: Store, thread: ThreadSummary): Promise<boolean> {
  if (!canDeleteThread(store, thread)) return false;
  const ok = await confirm.ask({
    title: strings.sidebar.deleteTitle,
    body: fill(strings.sidebar.deleteBody, { title: thread.title }),
    confirmLabel: strings.sidebar.delete,
    cancelLabel: strings.common.cancel,
    danger: true,
  });
  if (!ok || !(await store.removeThread(thread.id))) return false;
  undo.offer(fill(strings.sidebar.deletedToast, { title: thread.title }), async () => {
    if (!(await store.restoreDeletedThread(thread.id))) throw new Error(store.error ?? strings.connection.unavailable);
    await workspace.select(store, thread.id);
  }, { persistent: true, session: store.core ? { store, startedAt: store.core.startedAt } : undefined });
  await tick();
  focusComposer();
  return true;
}

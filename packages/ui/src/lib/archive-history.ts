import type { ThreadId } from '@boite/contracts';
import type { Store } from './store.svelte';
import { undo } from './undo.svelte';

/** Archives made in this window, newest last. */
export const closed: { store: Store; threadId: ThreadId; undoId: number }[] = [];

/** A deleted conversation cannot be restored by the toast or Ctrl+Shift+T. */
export function forgetArchivedThread(store: Store, threadId: ThreadId): void {
  for (let i = closed.length - 1; i >= 0; i--) {
    const entry = closed[i]!;
    if (entry.store !== store || entry.threadId !== threadId) continue;
    if (undo.current?.id === entry.undoId) undo.dismiss();
    closed.splice(i, 1);
  }
}

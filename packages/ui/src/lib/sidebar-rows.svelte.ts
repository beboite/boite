import type { ThreadId } from '@boite/contracts';
import type { Store } from './store.svelte';

/**
 * The thread rows the sidebar draws, top to bottom, folded projects left out:
 * what Alt+1 to Alt+9 count. The sidebar writes it, the key reads it, so the
 * Nth key is always the Nth row the user sees.
 */
class SidebarRows {
  list = $state.raw<{ store: Store; threadId: ThreadId }[]>([]);
}

export const sidebarRows = new SidebarRows();

import type { Store } from './store.svelte';

/**
 * Asks for the page below a window `threads.get` cut around a reading
 * position once the reader is within `reach` pixels of its bottom. The store
 * refuses a second call while one is in flight, and a window at the end has
 * no cursor to ask with.
 */
export function pullNewer(store: Store, box: HTMLElement, reach: number): void {
  if ((store.messagesAfter ?? null) === null || store.loadingNewer) return;
  if (box.scrollHeight - box.scrollTop - box.clientHeight > reach) return;
  void store.loadNewer();
}

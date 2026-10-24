import type { Store } from './store.svelte';
import { rightPanel } from './right-panel.svelte';

/**
 * Brings the Window tab forward when an agent opens a window in the
 * conversation with `boite window watch`, as the Device tab does for a device.
 * A window already watched when the conversation opens does not pull the panel
 * out; neither does the watch closing, which leaves the tab on its empty state.
 */
export function watchWindows(store: Store, threadId: string): () => void {
  const client = store.client;
  if (!client) return () => {};
  const panel = rightPanel.for(store.threadKey(threadId));
  // The watch last announced, by window and opening time. Nothing is asked up
  // front: `windows.list` enumerates the machine's windows, and only a change
  // brings the tab forward anyway.
  let known: string | null = null;
  const name = (watch: { windowId: string; openedAt: number } | null) => (watch ? `${watch.windowId}:${watch.openedAt}` : null);
  const off = client.on('windows.changed', (event) => {
    if (event.threadId !== threadId) return;
    const before = known;
    known = name(event.watch);
    if (known === null || known === before) return;
    const tab = panel.surfaces.find((surface) => surface.kind === 'window');
    if (tab) panel.activate(tab.id);
    else panel.open('window');
  });
  return off;
}

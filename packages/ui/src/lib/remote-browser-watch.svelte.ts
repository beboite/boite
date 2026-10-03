import { SvelteSet } from 'svelte/reactivity';
import type { Store } from './store.svelte';
import { rightPanel } from './right-panel.svelte';

/** The conversations, by thread key, whose agent browser tab the PC shares right now. */
export const remoteLive = new SvelteSet<string>();
/** Shown once per shared tab: a panel the user closed stays closed until the next one. */
const shown = new Set<string>();

/**
 * A paired device shows the PC's browser tab of the open conversation when the
 * agent has one, the way the desktop shows it: nothing to open by hand. The
 * view appears with the tab and goes away with it.
 */
export function watchRemoteBrowser(store: Store, threadId: string): () => void {
  const client = store.client;
  if (!client) return () => {};
  const key = store.threadKey(threadId), panel = rightPanel.for(key);
  let stopped = false, retry: ReturnType<typeof setTimeout> | undefined;
  const set = (live: boolean) => {
    if (stopped) return;
    const tabs = panel.surfaces.filter(surface => surface.kind === 'browser');
    if (!live) {
      remoteLive.delete(key); shown.delete(key);
      for (const tab of tabs) panel.close(tab.id);
      return;
    }
    remoteLive.add(key);
    if (shown.has(key)) return;
    shown.add(key);
    if (tabs[0]) panel.activate(tabs[0].id); else panel.open('browser');
  };
  const off = client.on('browser.remoteChanged', event => { if (event.threadId === threadId) set(event.live); });
  // The subscription to a just-opened conversation may still be on its way.
  const ask = (attempt: number) => {
    void client.call('browser.remoteStatus', { threadId }).then(({ live }) => set(live), () => {
      if (!stopped && attempt < 4) retry = setTimeout(() => ask(attempt + 1), 1000);
    });
  };
  ask(0);
  return () => { stopped = true; clearTimeout(retry); off(); remoteLive.delete(key); };
}

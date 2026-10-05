import type { Store } from './store.svelte';
import { rightPanel } from './right-panel.svelte';

/**
 * Brings the Agent browser tab forward when the agent opens a page in the
 * conversation, on every client, the way `device-watch.ts` does for devices.
 * Tabs already open when the conversation opens do not pull the panel out:
 * only a tab the client had not seen before does. The view stays covered
 * until the user shows it (`AgentBrowserSurface.svelte`).
 */
export function watchAgentBrowser(store: Store, threadId: string): () => void {
  const client = store.client;
  if (!client) return () => {};
  const panel = rightPanel.for(store.threadKey(threadId));
  let known: Set<string> | null = null, stopped = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const off = client.on('browser.remoteChanged', (event) => {
    if (event.threadId !== threadId) return;
    const before = known ?? new Set<string>();
    known = new Set(event.tabs.map((tab) => tab.tabId));
    if (!event.live || !event.tabs.some((tab) => !before.has(tab.tabId))) return;
    const tab = panel.surfaces.find((surface) => surface.kind === 'agent-browser');
    if (tab) panel.activate(tab.id);
    else panel.open('agent-browser');
  });
  // The subscription to a conversation just opened may still be on its way.
  const ask = (attempt: number) => {
    void client.call('browser.remoteStatus', { threadId }).then(
      ({ tabs }) => { known ??= new Set(tabs.map((tab) => tab.tabId)); },
      () => { if (!stopped && attempt < 4) retry = setTimeout(() => ask(attempt + 1), 1000); }
    );
  };
  ask(0);
  return () => { stopped = true; clearTimeout(retry); off(); };
}

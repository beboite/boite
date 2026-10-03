import type { Store } from './store.svelte';
import { rightPanel } from './right-panel.svelte';
import { browserBridge } from './browser-bridge';
import { experimentOn } from './experiments.svelte';

type Client = NonNullable<Store['client']>;

/** Well inside the core's 35 seconds, so one late renewal does not drop the desktop. */
export const REMOTE_READY_MS = 20000;

/**
 * A desktop that shares its browser tells the core so, and shows a
 * conversation's browser tab when a paired phone asks: someone away from the
 * PC cannot open the conversation or the tab there themselves.
 */
export function shareBrowserOnRequest(store: Store): () => void {
  const client = store.client;
  if (!experimentOn('remote-browser') || !client || !store.owner || !browserBridge.protocol || !/Windows/.test(navigator.userAgent)) return () => {};
  const ready = (enabled: boolean) => { void client.call('browser.remoteReady', { enabled }).catch(() => {}); };
  ready(true);
  const timer = setInterval(() => ready(true), REMOTE_READY_MS);
  const off = client.on('browser.remoteOpenRequested', ({ threadId }) => { void showRemoteBrowser(store, client, threadId); });
  return () => { clearInterval(timer); off(); ready(false); };
}

/** Opens the conversation, then its browser tab: the one on screen, another one it has, or a new one. */
export async function showRemoteBrowser(store: Store, client: Client, threadId: string): Promise<void> {
  if (store.client !== client) return;
  if (store.openThread?.id !== threadId) await store.open(threadId);
  if (store.client !== client || store.openThread?.id !== threadId) return;
  const panel = rightPanel.for(store.threadKey(threadId));
  const existing = panel.active?.kind === 'browser' ? panel.active : panel.surfaces.find(surface => surface.kind === 'browser');
  if (existing) panel.activate(existing.id);
  else panel.open('browser');
}

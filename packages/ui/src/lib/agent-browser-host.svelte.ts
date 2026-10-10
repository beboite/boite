import { untrack } from 'svelte';
import type { Store } from './store.svelte';
import { workspace } from './workspace.svelte';
import { browserBridge } from './browser-bridge';
import type { BrowserHostRelay, HostBridge, HostClient } from './browser-host';

/**
 * Whether this app hosts its own core's agent browser right now: the panel then
 * shows an agent tab's own webview (`AgentBrowserSurface.svelte`) instead of
 * its frames. Only the Windows desktop app can, on the core it started.
 */
export const agentHost = $state({ active: false });

/** Whether this app can host the agent browser of `store`'s core at all. */
export function canHostAgentBrowser(store: Pick<Store, 'localCore' | 'owner'>): boolean {
  return store.localCore && store.owner && typeof browserBridge.events === 'function' && 'relay' in browserBridge && typeof browserBridge.setCookies === 'function' && /Windows/.test(navigator.userAgent);
}

/** Hosts until the returned stop runs: a reconnect makes a new relay, the core having dropped the last. */
export function hostAgentBrowser(store: Store): () => void {
  const client = store.client;
  if (!client || !canHostAgentBrowser(store)) return () => {};
  let stopped = false, relay: BrowserHostRelay | null = null;
  // Loaded on the one app that hosts: the entry chunk every phone downloads stays without it.
  void import('./browser-host').then(async ({ BrowserHostRelay }) => {
    if (stopped) return;
    relay = new BrowserHostRelay(client as unknown as HostClient, browserBridge as unknown as HostBridge);
    await relay.start();
    if (!stopped) agentHost.active = true;
  }).catch(cause => {
    console.warn(`[browser] this app could not host the agent browser: ${cause instanceof Error ? cause.message : String(cause)}`);
  });
  return () => { stopped = true; agentHost.active = false; relay?.stop(); };
}

/**
 * Called once while the app's root component starts: the agent's tabs of this
 * computer's own core open as webviews of this app, again after a reconnect.
 */
export function hostLocalAgentBrowser(): void {
  $effect(() => {
    const local = workspace.machines.find((machine) => machine.store.localCore)?.store;
    if (!local?.client || local.connection !== 'ready' || !canHostAgentBrowser(local)) return;
    return untrack(() => hostAgentBrowser(local));
  });
}

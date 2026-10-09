/**
 * Whether this window lends the panel's browser to its computer's agents, and
 * the call that starts the loan. The loan itself (`desktop-browser-host.svelte.ts`)
 * loads only in the owner's Windows shell, so a browser tab or a phone never
 * downloads it.
 */
import type { Store } from './store.svelte';
import { browserBridge } from './browser-bridge';

/**
 * Whether this window lends its browser: the owner's Windows shell on the core
 * it started. Only WebView2 answers DevTools calls, and a core on another
 * machine has agents that could never see this screen.
 */
export function lendsBrowser(store: Pick<Store, 'owner' | 'localCore'>): boolean {
  return store.owner && store.localCore && !!browserBridge.protocol && /Windows/.test(navigator.userAgent);
}

/**
 * Lends the panel's browser to the core this window started, while it is
 * connected; for an `$effect`, which reruns on a reconnection and ends the
 * previous loan through the returned function.
 */
export function lendLocalBrowser(machines: readonly { store: Store }[]): (() => void) | undefined {
  const local = machines.find((machine) => machine.store.localCore)?.store;
  void local?.connection;
  if (!local || local.client?.state !== 'ready' || !lendsBrowser(local)) return;
  let ended = false, stop: (() => void) | undefined;
  void import('./desktop-browser-host.svelte').then(({ lendDesktopBrowser }) => { if (!ended) stop = lendDesktopBrowser(local); }, () => {});
  return () => { ended = true; stop?.(); };
}

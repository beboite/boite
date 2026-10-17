import { gatewayDashboardReachable, isLoopbackHost } from '@boite/contracts';
import type { Store } from './store.svelte';

type Where = Pick<Store, 'localCore' | 'endpointUrl'>;

/**
 * Whether this client runs on the core's machine: the desktop app on the core
 * it started, or a page reaching its core at a loopback address. A phone or
 * another computer does not, whatever the core's settings say.
 */
export function besideCore(store: Partial<Where>): boolean {
  if (store.localCore) return true;
  const url = store.endpointUrl ?? (typeof location === 'undefined' ? undefined : location.href);
  if (!url) return false;
  try { return isLoopbackHost(new URL(url).hostname); } catch { return false; }
}

/** The gateway dashboard this client can open, or null: a loopback dashboard answers only beside the core. */
export function gatewayDashboard(store: Partial<Where> & Pick<Store, 'settings'>): string | null {
  const url = store.settings?.subscriptionProxy?.dashboardUrl;
  return url && gatewayDashboardReachable(url, besideCore(store)) ? url : null;
}

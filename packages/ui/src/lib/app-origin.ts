import { APP_ORIGIN, withoutTrailingSlashes } from '@boite/contracts';

/** An override as the browser writes origins, or nothing for one the cores would refuse: https, no path, query or credentials. */
function named(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const url = new URL(withoutTrailingSlashes(value.trim()));
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

/**
 * The phone app's own address: a page no machine serves (`APP_ORIGIN`, or the
 * one `VITE_BOITE_APP_ORIGIN` names at build time). There, the app opens on
 * nothing but its way in, and every machine it reaches comes from the group it
 * was added to.
 */
export const appOrigin: string = (import.meta.env.DEV ? named((globalThis as { __BOITE_APP_ORIGIN__?: string }).__BOITE_APP_ORIGIN__) : undefined)
  // A development build only: the end to end tests serve the app at an address of their own, set before the page loads.
  ?? named(import.meta.env.VITE_BOITE_APP_ORIGIN) ?? APP_ORIGIN;

/** Whether this page is the phone app's, served by no machine. */
export function appPage(): boolean {
  return typeof window !== 'undefined' && window.__TAURI_INTERNALS__ === undefined && window.location.origin === appOrigin;
}

/**
 * Whether an HTTPS page may open a socket to this machine's address: an https
 * one, or plain http on this device itself, which browsers let through as the
 * only http they trust. Any other http socket is blocked as mixed content
 * before it leaves, so the app turns that address down instead of failing.
 */
export function reachableFromApp(address: string): boolean {
  try {
    const url = new URL(address);
    if (url.protocol === 'https:') return true;
    if (url.protocol !== 'http:') return false;
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host);
  } catch {
    return false;
  }
}

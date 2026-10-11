import { APP_ORIGIN } from '@boite/contracts';

/**
 * The phone app's own address: a page no machine serves (`APP_ORIGIN`, or the
 * one `VITE_BOITE_APP_ORIGIN` names at build time). There, the app opens on
 * nothing but its way in, and every machine it reaches comes from the group it
 * was added to.
 */
export const appOrigin: string = (import.meta.env.DEV ? (globalThis as { __BOITE_APP_ORIGIN__?: string }).__BOITE_APP_ORIGIN__ : undefined)
  // A development build only: the end to end tests serve the app at an address of their own, set before the page loads.
  || (import.meta.env.VITE_BOITE_APP_ORIGIN as string | undefined)?.replace(/\/$/, '') || APP_ORIGIN;

/** Whether this page is the phone app's, served by no machine. */
export function appPage(): boolean {
  return typeof window !== 'undefined' && window.__TAURI_INTERNALS__ === undefined && window.location.origin === appOrigin;
}

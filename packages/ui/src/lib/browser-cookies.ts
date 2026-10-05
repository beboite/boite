import { BROWSER_COOKIES_MAX, browserCookiesError, type BrowserCookie } from '@boite/contracts';
import { browserBridge } from './browser-bridge';
import type { Store } from './store.svelte';

/**
 * The cookies of a desktop profile, as the agent browser takes them. The
 * desktop's browser lists them in DevTools form; one the contract would refuse
 * (an oversized value, a path that is not one) is left out rather than failing
 * the whole copy, and a session cookie keeps no expiry date.
 */
export function agentCookies(raw: unknown[]): BrowserCookie[] {
  const cookies: BrowserCookie[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const from = entry as Record<string, unknown>;
    const cookie: BrowserCookie = {
      name: String(from.name ?? ''), value: String(from.value ?? ''), domain: String(from.domain ?? ''), path: String(from.path ?? '/'),
      ...(typeof from.secure === 'boolean' ? { secure: from.secure } : {}),
      ...(typeof from.httpOnly === 'boolean' ? { httpOnly: from.httpOnly } : {}),
      ...(from.sameSite === 'Strict' || from.sameSite === 'Lax' || from.sameSite === 'None' ? { sameSite: from.sameSite } : {}),
      ...(from.session !== true && typeof from.expires === 'number' && from.expires > 0 ? { expires: from.expires } : {}),
    };
    if (browserCookiesError([cookie]) === null) cookies.push(cookie);
    if (cookies.length === BROWSER_COOKIES_MAX) break;
  }
  return cookies;
}

/** Whether this client holds browser profiles whose sign-ins it can read: the Windows shell. */
export function canCopySignIns(): boolean {
  return typeof browserBridge.cookies === 'function';
}

/**
 * Copies one desktop profile's sign-ins into the same profile of the agent
 * browser on `store`'s machine, through that machine's own client. Returns how
 * many cookies went; zero when the profile holds none.
 */
export async function copySignIns(profile: { id: string; name: string }, store: Store): Promise<number> {
  if (!browserBridge.cookies) throw new Error('reading sign-ins requires the Windows desktop app');
  const client = store.client;
  if (!client) throw new Error('that machine is not connected');
  const cookies = agentCookies(await browserBridge.cookies(profile.id));
  if (cookies.length === 0) return 0;
  return (await client.call('browser.importCookies', { profile, cookies })).imported;
}

import type { Cdp } from './cdp.ts';
import { readSavedCookies, writeSavedCookies } from './chromium.ts';

/** The desktop app takes at most 5000 cookies a call (`browser_set_cookies`). */
const HOSTED_COOKIES_BATCH = 1000;

/** A profile's browser connection and the folder its `boite-cookies.json` lives in; no folder, nothing kept. */
export interface CookieKeeper {
  profile: string;
  dir: string;
  cdp: Cdp;
  throwaway: boolean;
  /** What `boite-cookies.json` holds, so an unchanged set is not written again. */
  saved?: string;
}

type Log = (message: string) => void;
const reason = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * The core keeps each profile's cookies itself. A browser writes its own
 * late and, on Windows and macOS, lost them when it closed a minute after
 * its last tab; one without an expiry date is never written by it at all.
 * Saved a second after a page moves (a sign-in ends on one), every 30
 * seconds while a tab is open, when a tab closes and before the process
 * ends; restored at start. A core killed outright loses at most that.
 */
export async function saveCookies(keeper: CookieKeeper, log: Log): Promise<void> {
  if (keeper.throwaway || !keeper.dir || !keeper.cdp.open) return;
  try {
    const { cookies } = await keeper.cdp.send<{ cookies: Record<string, unknown>[] }>('Storage.getCookies', {}, undefined, 5000);
    const held = JSON.stringify(cookies);
    if (held === keeper.saved) return;
    writeSavedCookies(keeper.dir, cookies);
    keeper.saved = held;
  } catch (error) {
    log(`the cookies of browser profile ${keeper.profile} could not be saved: ${reason(error)}`);
  }
}

/**
 * Hands the desktop app's webviews the saved cookies they lack: a sign-in made
 * while the app was closed, or a session cookie the app dropped when it quit.
 * One the app already holds is its own, newer, and stays.
 */
export async function restoreMissingCookies(keeper: CookieKeeper, log: Log): Promise<void> {
  const saved = readSavedCookies(keeper.dir);
  if (!saved.length) return;
  const key = (cookie: Record<string, unknown>) => `${String(cookie.name)}\n${String(cookie.domain)}\n${String(cookie.path ?? '/')}`;
  try {
    const { cookies: held } = await keeper.cdp.send<{ cookies: Record<string, unknown>[] }>('Storage.getCookies', {}, undefined, 5000);
    const have = new Set(held.map(key));
    const missing = saved.filter(cookie => !have.has(key(cookie)));
    for (let at = 0; at < missing.length; at += HOSTED_COOKIES_BATCH) {
      await keeper.cdp.send('Storage.setCookies', { cookies: missing.slice(at, at + HOSTED_COOKIES_BATCH) }, undefined, 10_000);
    }
  } catch (error) {
    log(`the saved cookies of browser profile ${keeper.profile} were not handed to the desktop app: ${reason(error)}`);
  }
}

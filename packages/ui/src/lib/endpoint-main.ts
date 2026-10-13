// Owns the chosen startup machine and how it relates to the page or desktop shell.
import { parseGroupRelayUrl, withoutTrailingSlashes } from '@boite/contracts';
import { readEnvironments, type StoredEnvironment } from './endpoint-env';
import { opens, storeEndpoint, clearStoredEndpoint } from './endpoint-storage';

export const MAIN_STORAGE_KEY = 'boite.main';

/**
 * The machine the owner chose to open on at every start. `local` is the app's
 * own core: the one the shell starts, whose port changes at every start, or
 * in a browser the one that serves the page. Any other is a machine this
 * device holds a key for, named by its address and, when the group brought
 * it, by what it is in that group: its address may change, the machine stays
 * the one chosen.
 */
export type MainMachine = { local: true } | { url: string; coreId?: string; groupId?: string };

/**
 * The desktop app always opens on the machine shown last: it starts its own
 * core and the owner switches machines from the sidebar. A choice an earlier
 * version saved there counts for nothing.
 */
export function readMainMachine(): MainMachine | null {
  if (insideTauri()) return null;
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(MAIN_STORAGE_KEY) ?? 'null');
    if (typeof parsed !== 'object' || parsed === null) return null;
    const shape = parsed as Record<string, unknown>;
    if (shape['local'] === true) return { local: true };
    if (typeof shape['url'] !== 'string') return null;
    const member = typeof shape['coreId'] === 'string' && typeof shape['groupId'] === 'string' ? { coreId: shape['coreId'], groupId: shape['groupId'] } : {};
    return { url: withoutTrailingSlashes(shape['url']), ...member };
  } catch {
    return null;
  }
}

/** With null, a start opens again on the machine shown last. */
export function storeMainMachine(main: MainMachine | null): void {
  try {
    if (main === null) window.localStorage.removeItem(MAIN_STORAGE_KEY);
    else window.localStorage.setItem(MAIN_STORAGE_KEY, JSON.stringify(main));
  } catch {
    /* a browser that refuses storage still runs for this session */
  }
}

/** The key this device holds for the chosen machine: at its address, or wherever the group has brought that machine since. */
function mainEnvironment(main: MainMachine): StoredEnvironment | undefined {
  if ('local' in main) return undefined;
  const keyed = readEnvironments().filter(opens);
  return keyed.find((env) => env.url === main.url)
    ?? (main.coreId === undefined ? undefined : keyed.find((env) => env.coreId === main.coreId && env.groupId === main.groupId));
}

/**
 * Makes the machine the owner chose the one this start opens on, whichever
 * machine was shown last. A choice this device holds no key for any more, a
 * machine removed or dropped by its group, changes nothing: the start opens
 * where the last one ended, and the choice counts again once that machine is
 * back.
 */
export function openOnMainMachine(): void {
  const main = readMainMachine();
  if (main === null) return;
  // With no stored core, a start falls back on the app's own: the shell's, or the origin of the page.
  // In a browser that machine may need the key held for it, a phone's page being served by the machine it paired with.
  const env = 'local' in main ? readEnvironments().find((entry) => opens(entry) && servesThisPage(entry.url)) : mainEnvironment(main);
  if (env) storeEndpoint(env);
  else if ('local' in main) clearStoredEndpoint();
}

export function insideTauri(): boolean {
  return window.__TAURI_INTERNALS__ !== undefined;
}

/**
 * Whether a core at this address served the page, the only core a
 * notification's `?thread=` link can mean. A machine reached through this
 * page's core (`groupRelayUrl`) shares its origin and is not it.
 */
export function servesThisPage(url: string): boolean {
  if (parseGroupRelayUrl(url) !== null) return false;
  try { return new URL(url).origin === window.location.origin; } catch { return false; }
}

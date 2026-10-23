// Resolves the core for this page and preserves the public endpoint API.
import { errorText } from './errors';
import { GRANT_QUERY_PARAM, PAIR_QUERY_PARAM, parseGroupRelayUrl, withoutTrailingSlashes, type DeviceHello } from '@boite/contracts';
import { appPage } from './app-origin';
import { heldDeviceKey } from './device-key';

import { setDropped } from './endpoint-dropped';
import { readEnvironments } from './endpoint-env';
import { insideTauri } from './endpoint-main';
import { readStoredEndpoint, brought, signsOf, isEndpoint, type Endpoint } from './endpoint-storage';

export { DROPPED_STORAGE_KEY, keepDropped, isDropped, droppedSince, isMemberDropped } from './endpoint-dropped';
export { ENVIRONMENTS_STORAGE_KEY, defaultEnvironmentLabel, readEnvironments, storeEnvironments, refreshLocalEnvironment, upsertEnvironment, forgetGroupOf, rememberSession, rememberDevice, removeEnvironment, removeBrought, type StoredEnvironment } from './endpoint-env';
export { MAIN_STORAGE_KEY, readMainMachine, storeMainMachine, openOnMainMachine, insideTauri, servesThisPage, type MainMachine } from './endpoint-main';
export { ENDPOINT_STORAGE_KEY, readStoredEndpoint, storeEndpoint, clearStoredEndpoint, opens, type Endpoint } from './endpoint-storage';

export const CORE_QUERY_PARAM = 'core';

/**
 * A pairing link pasted by hand: the core it names and the grant inside it.
 * The core's own link is `<origin>/?grant=`, and a `core` parameter names a
 * core other than the origin. Null when there is no http(s) URL or no grant.
 */
export function parsePairingLink(text: string): { url: string; grant: string } | null {
  let link: URL;
  try {
    link = new URL(text.trim());
  } catch {
    return null;
  }
  if (link.protocol !== 'http:' && link.protocol !== 'https:') return null;
  const grant = link.searchParams.get(GRANT_QUERY_PARAM);
  if (!grant) return null;
  const core = link.searchParams.get(CORE_QUERY_PARAM);
  return { url: withoutTrailingSlashes(core ?? `${link.origin}${link.pathname}`), grant };
}

/**
 * The core's own pairing link carries a grant alone, on a page it serves
 * itself, so an absent `core` parameter means the origin of this page. A
 * `token` is the other form, a UI opened by hand on a token one already holds.
 * A `core` with neither reopens a core this device already holds a key for,
 * with that key. Nothing is stored here: see `Endpoint.fromLink`.
 */
function takeFromQuery(): Endpoint | null {
  const params = new URLSearchParams(window.location.search);
  const core = params.get(CORE_QUERY_PARAM);
  const token = params.get(PAIR_QUERY_PARAM);
  const grant = params.get(GRANT_QUERY_PARAM);
  if (!core && !token && !grant) return null;

  const url = withoutTrailingSlashes(core ?? window.location.origin);
  // A token this device already holds for that core says nothing new: the core is reopened as it is known.
  const held = heldFor(url);
  const known = grant ? null : !token ? knownEndpoint(url) : held.keys.includes(token) ? { url, token, paired: true } : null;
  // What the group brought stays marked whatever the link looks like. Only a grant, once the owner said yes, makes it the owner's.
  const endpoint: Endpoint = known
    ? { ...known, ...held.marks, fromLink: true }
    : { url, token: token ?? '', ...(grant ? { grant } : held.marks), fromLink: true };

  params.delete(CORE_QUERY_PARAM);
  params.delete(PAIR_QUERY_PARAM);
  params.delete(GRANT_QUERY_PARAM);
  const query = params.toString();
  const stripped = `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`;
  window.history.replaceState(null, '', stripped);

  return endpoint;
}

/** Whether the address bar still carries a link to a core: a pairing link, a token or a `?core=`. Read before the link is taken. */
export function opensFromLink(): boolean {
  const params = new URLSearchParams(window.location.search);
  return [CORE_QUERY_PARAM, PAIR_QUERY_PARAM, GRANT_QUERY_PARAM].some((name) => params.get(name));
}

/** The core a `?core=` link names, with or without a key of its own, read before the link is taken. */
export function linkedCore(): string | null {
  const core = new URLSearchParams(window.location.search).get(CORE_QUERY_PARAM);
  return core ? withoutTrailingSlashes(core) : null;
}

/**
 * What a tapped notification put in the address: `?thread=`, and `?member=`
 * when another machine of the group sent it through this page's core
 * (`member`, since `?core=` is a pairing link's address of a core). Taken off
 * at once, so a reload during the boot does not jump there again.
 */
export function takeNotificationTarget(): { thread: string | null; member: string | null; key: string | null; limits: boolean } {
  const query = new URLSearchParams(window.location.search);
  const thread = query.get('thread');
  const member = query.get('member');
  const key = query.get('key');
  const limits = query.get('limits') === '1';
  if (thread !== null || member !== null || key !== null || query.has('limits')) {
    const url = new URL(window.location.href);
    url.searchParams.delete('thread');
    url.searchParams.delete('member');
    url.searchParams.delete('key');
    url.searchParams.delete('limits');
    window.history.replaceState(window.history.state, '', url);
  }
  // A limit alert names a machine and no thread.
  const memberId = (thread || limits) && member !== null && /^[0-9a-f]{64}$/.test(member) ? member : null;
  // `key` is a page notice's machine and thread (`openNotification`), for a machine with no group id.
  return { thread: thread || null, member: memberId, key: thread && memberId === null && key && key.length <= 600 ? key : null, limits };
}

/**
 * A path the core answers on its own HTTP server (`/file/...`, `/view/...`),
 * as an address of the core at `endpointUrl`. Joined, not resolved: a core
 * reached through a relay route answers under that route's path.
 */
export function coreHref(endpointUrl: string, path: string): string {
  return `${withoutTrailingSlashes(endpointUrl)}${path}`;
}

/**
 * For a machine reached through another member's relay route, what opens the
 * way on that member: this device's signature for it, or the key this device
 * keeps for it, where it keeps it. Null for an address that is no relay, or a
 * member it holds nothing for.
 */
export function relayKeyFor(url: string): string | DeviceHello | null {
  const relay = parseGroupRelayUrl(url);
  if (relay === null) return null;
  const stored = readStoredEndpoint();
  const held = [stored?.url === relay.member ? stored : undefined, readEnvironments().find((env) => env.url === relay.member)].filter((place) => place !== undefined);
  const signs = held.find((place) => place.signs !== undefined)?.signs;
  const hello = signs === undefined ? undefined : heldDeviceKey()?.hello(signs);
  if (hello !== undefined) return hello;
  return held.find((place) => place.token !== '')?.token ?? null;
}

let shellRefusal: string | null = null;

/**
 * Why the shell gave no endpoint the last time it was asked: its own sentence
 * (the core exited and what it printed, a start past its timeout), or null
 * once it gave one.
 */
export function shellEndpointError(): string | null {
  return shellRefusal;
}

export async function fromTauri(): Promise<Endpoint | null> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const result: unknown = await invoke('core_endpoint');
    shellRefusal = isEndpoint(result) ? null : 'the shell answered with no core address';
    return isEndpoint(result) ? { url: withoutTrailingSlashes(result.url), token: result.token, local: true } : null;
  } catch (error) {
    shellRefusal = errorText(error);
    return null;
  }
}

/** What the local core does before it serves, as the shell reads it from `core.starting.json`. */
export interface ShellStarting { phase: string; startedAt: number; bytes: number }

/** The long work the shell's core announced before serving, or null: none, or a shell without the command. */
export async function shellStarting(): Promise<ShellStarting | null> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const result = await invoke<ShellStarting | null>('core_starting');
    return result !== null && typeof result === 'object' && typeof result.phase === 'string' ? result : null;
  } catch {
    return null;
  }
}

function fromOrigin(): Endpoint | null {
  // The phone app's page is no machine's: nothing to connect to until a machine is added.
  if (appPage()) return null;
  const protocol = window.location.protocol;
  if (protocol !== 'http:' && protocol !== 'https:') return null;
  return { url: withoutTrailingSlashes(window.location.origin), token: '' };
}

/** The stored core or a remembered one at this address, with the key this device holds for it. */
/**
 * What this device holds for a core, in both places a key is saved: the keys,
 * and the group's marks if either place has them. A machine the group brought
 * is one wherever its key sits.
 */
function heldFor(url: string): { keys: string[]; marks: { coreId?: string; groupId?: string } } {
  const stored = readStoredEndpoint();
  const places = [stored?.url === url ? stored : undefined, readEnvironments().find((env) => env.url === url)].filter((place) => place !== undefined);
  const marked = places.find((place) => place.coreId !== undefined);
  return { keys: places.map((place) => place.token), marks: marked === undefined ? {} : brought(marked) };
}

function knownEndpoint(url: string): Endpoint | null {
  const stored = readStoredEndpoint();
  if (stored?.url === url) return stored;
  const remembered = readEnvironments().find((env) => env.url === url);
  return remembered ? { url, token: remembered.token, ...(remembered.paired ? { paired: true } : {}), ...brought(remembered), ...signsOf(remembered) } : null;
}

/**
 * A link on this page's own origin, or naming a core this device already
 * holds a key for, goes through. Any other core could be anyone's: a crafted
 * `?core=` would otherwise point this UI at a stranger who then sees every
 * prompt typed here, so the user is asked first, and a missing asker refuses.
 */
/** The machine this device's key signs for at `url`, when its key is what opens it there. */
export function signsFor(url: string): string | undefined {
  const stored = readStoredEndpoint();
  if (stored?.url === withoutTrailingSlashes(url) && stored.signs !== undefined) return stored.signs;
  return readEnvironments().find((env) => env.url === withoutTrailingSlashes(url))?.signs;
}

/** Addresses of the machines of this device's group, as its members last listed them: a link to one asks nothing. */
export const GROUP_ADDRESSES_STORAGE_KEY = 'boite.group.addresses';

export function rememberGroupAddresses(addresses: readonly string[]): void {
  try { window.localStorage.setItem(GROUP_ADDRESSES_STORAGE_KEY, JSON.stringify([...new Set(addresses.map(withoutTrailingSlashes))].slice(0, 256))); } catch { /* storage refused */ }
}

function isGroupAddress(url: string): boolean {
  try {
    const list: unknown = JSON.parse(window.localStorage.getItem(GROUP_ADDRESSES_STORAGE_KEY) ?? '[]');
    return Array.isArray(list) && list.includes(url);
  } catch {
    return false;
  }
}

async function followLink(endpoint: Endpoint, approve?: (url: string) => Promise<boolean>): Promise<boolean> {
  // A machine of this device's own group is no stranger: its key already opens it.
  const known = endpoint.url === withoutTrailingSlashes(window.location.origin) || knownEndpoint(endpoint.url) !== null || isGroupAddress(endpoint.url);
  // A link that carries a key of its own, a grant or a token, turns a machine the group brought into
  // the owner's, out of the group's hands. A machine the group removed can make such a link itself: the owner is asked.
  const held = heldFor(endpoint.url);
  const promotes = held.marks.coreId !== undefined && (endpoint.grant !== undefined || !held.keys.includes(endpoint.token));
  if (known && !promotes) return true;
  if (approve === undefined || !(await approve(endpoint.url))) return false;
  // The owner said yes to that address: what the group dropped there before is past.
  setDropped(endpoint.url, null);
  return true;
}

/**
 * Where the core is, in order: a pairing link, then in the Tauri shell a core
 * this app was paired with and otherwise the one the shell started, then what
 * was stored by an earlier pairing, then the origin that served this page. A
 * link to an unknown core counts only once `approve` says yes.
 */
export async function resolveEndpoint(
  preferLocal = false,
  approve?: (url: string) => Promise<boolean>
): Promise<Endpoint | null> {
  const linked = takeFromQuery();
  if (linked && (await followLink(linked, approve))) return linked;

  if (insideTauri()) {
    const stored = readStoredEndpoint();
    if (stored?.paired && !preferLocal) return stored;
    return await fromTauri();
  }

  const stored = readStoredEndpoint();
  if (stored) return stored;

  return fromOrigin();
}

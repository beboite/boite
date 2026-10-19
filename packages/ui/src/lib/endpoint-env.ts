// Owns remembered environments and updates to the keys a device holds for them.
import { withoutTrailingSlashes } from '@boite/contracts';
import { droppedAddresses, memberKey, setDropped, setMark } from './endpoint-dropped';
import { brought, signsOf, readStoredEndpoint, storeEndpoint, clearStoredEndpoint, rawStoredUrl, type Endpoint } from './endpoint-storage';

/**
 * A remembered core: one pairing or manual connection this device keeps, so
 * switching back needs no new link. The token is the session key the link
 * became, useless anywhere but on its own core, and dead once revoked there.
 * The key is the normalised URL: one entry per core, never two.
 */
export interface StoredEnvironment {
  url: string;
  label: string;
  token: string;
  paired: boolean;
  /** Set when the group connected this core: its id in the roster, so it is found again offline and dropped when it leaves. */
  coreId?: string;
  /** The group that connected it. */
  groupId?: string;
  /** Which admission of that machine the group listed then. */
  epoch?: number;
  /** This device's key opens it, signed for this machine id; `token` is empty. */
  signs?: string;
  /**
   * The group that machine last said it is in, over that key: a reload knows
   * it before the machine answers, and the group's word that it left still
   * counts when the machine was removed before it said it again.
   */
  signedGroup?: string;
}

export const ENVIRONMENTS_STORAGE_KEY = 'boite.envs';

/** The host part of the URL, port included; the raw URL when it parses as nothing. */
export function defaultEnvironmentLabel(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function isEnvironment(value: unknown): value is StoredEnvironment {
  if (typeof value !== 'object' || value === null) return false;
  const shape = value as Record<string, unknown>;
  return (
    typeof shape['url'] === 'string' &&
    typeof shape['label'] === 'string' &&
    typeof shape['token'] === 'string' &&
    typeof shape['paired'] === 'boolean'
  );
}

/**
 * Every remembered core, oldest first. A device that paired before this list
 * existed seeds one entry from its stored endpoint, so nothing is lost.
 */
export function readEnvironments(): StoredEnvironment[] {
  let list: StoredEnvironment[] = [];
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(ENVIRONMENTS_STORAGE_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      const dropped = droppedAddresses();
      if (Array.isArray(parsed)) list = parsed.filter(isEnvironment).filter((env) => dropped[env.url] === undefined);
    }
  } catch {
    list = [];
  }
  if (list.length > 0) return list;
  // A list that was written, even emptied, is the list: an entry taken out of it must not come
  // back from the stored endpoint, without what the list knew of where it came from.
  if (raw !== null) return [];
  const stored = readStoredEndpoint();
  if (!stored?.paired) return [];
  const seeded: StoredEnvironment = {
    url: stored.url,
    label: defaultEnvironmentLabel(stored.url),
    token: stored.token,
    paired: true,
    ...brought(stored),
    ...signsOf(stored)
  };
  storeEnvironments([seeded]);
  return [seeded];
}

export function storeEnvironments(envs: StoredEnvironment[]): void {
  try {
    window.localStorage.setItem(ENVIRONMENTS_STORAGE_KEY, JSON.stringify(envs));
  } catch {
    /* a browser that refuses storage still runs for this session */
  }
}

/** The shell discovers its local endpoint on every start; its random port is not a machine identity. */
export function refreshLocalEnvironment(local: Endpoint): StoredEnvironment[] {
  const list = readEnvironments().filter(entry => {
    if (entry.url === withoutTrailingSlashes(local.url)) return false;
    let host: string;
    try { host = new URL(entry.url).hostname; } catch { return true; }
    const generated = !entry.paired && entry.label === 'This computer';
    return !(generated && ['localhost', '127.0.0.1', '[::1]'].includes(host));
  });
  storeEnvironments(list);
  return list;
}

/** Adds the core or refreshes its key, keeping an existing label unless a new one is given. */
export function upsertEnvironment(entry: {
  url: string;
  token: string;
  paired: boolean;
  label?: string;
  coreId?: string;
  groupId?: string;
  epoch?: number;
  signs?: string;
}): StoredEnvironment[] {
  const url = withoutTrailingSlashes(entry.url);
  const list = readEnvironments();
  const at = list.findIndex((env) => env.url === url);
  const label = entry.label ?? list[at]?.label ?? defaultEnvironmentLabel(url);
  const next: StoredEnvironment = {
    url, label, token: entry.token, paired: entry.paired,
    ...brought({ coreId: entry.coreId ?? list[at]?.coreId, groupId: entry.groupId ?? list[at]?.groupId, epoch: entry.epoch ?? list[at]?.epoch }),
    // A key written for that address replaces the device key's word; an empty one keeps it.
    ...signsOf({ signs: entry.signs ?? (entry.token === '' ? list[at]?.signs : undefined) })
  };
  // What the machine said of its group holds as long as the same key opens the same machine.
  if (next.signs !== undefined && next.signs === list[at]?.signs && list[at]?.signedGroup !== undefined) next.signedGroup = list[at].signedGroup;
  if (at === -1) {
    list.push(next);
  } else {
    list[at] = next;
  }
  storeEnvironments(list);
  return list;
}

/** Keeps the group a machine this device's key opens said it is in (`signedGroup`); null forgets it. */
export function rememberSignedGroup(url: string, groupId: string | null): void {
  const at = withoutTrailingSlashes(url);
  const list = readEnvironments();
  const entry = list.find((env) => env.url === at);
  if (entry === undefined || entry.signs === undefined || (entry.signedGroup ?? null) === groupId) return;
  if (groupId === null) delete entry.signedGroup;
  else entry.signedGroup = groupId;
  storeEnvironments(list);
}

/** The machine was paired by hand since: it is no longer the group's to drop. */
export function forgetGroupOf(url: string): StoredEnvironment[] {
  setDropped(url, null);
  const list = readEnvironments().map((env) => (env.url === withoutTrailingSlashes(url) ? { url: env.url, label: env.label, token: env.token, paired: env.paired } : env));
  storeEnvironments(list);
  return list;
}

/**
 * Keeps the key a core handed back for a grant or a ticket. A grant is a
 * pairing made by hand: whatever group brought this machine before has no say
 * over it any more, so the mark that lets a group drop it goes.
 */
export function rememberSession(endpoint: Endpoint, token: string): StoredEnvironment[] {
  // A new key for that address, and for that machine when the group brings it: whatever was dropped before is past.
  setDropped(endpoint.url, null);
  if (endpoint.grant === undefined && endpoint.coreId !== undefined && endpoint.groupId !== undefined) setMark(memberKey(endpoint.groupId, endpoint.coreId), null);
  if (endpoint.grant !== undefined) forgetGroupOf(endpoint.url);
  return upsertEnvironment({ url: endpoint.url, token, paired: true, ...brought(endpoint) });
}

/**
 * This device's key now opens the machine at `url`, signed for `coreId`: an
 * admission by a grant, or a key handed over by a device paired the older
 * way. Whatever the group's marks said of that address is past.
 */
export function rememberDevice(url: string, coreId: string): StoredEnvironment[] {
  setDropped(url, null);
  const list = readEnvironments().map((env) => (env.url === withoutTrailingSlashes(url)
    ? { url: env.url, label: env.label, token: '', paired: true, signs: coreId, ...(env.signs === coreId && env.signedGroup !== undefined ? { signedGroup: env.signedGroup } : {}) }
    : env));
  storeEnvironments(list);
  const updated = upsertEnvironment({ url, token: '', paired: true, signs: coreId });
  const stored = readStoredEndpoint();
  if (stored?.url === withoutTrailingSlashes(url)) storeEndpoint({ url: stored.url, token: '', paired: true, signs: coreId });
  return updated;
}

/**
 * Forgets the core. Its key stays valid there until revoked; it just opens
 * nothing from here. With `token`, only the entry that still holds that key
 * goes: another window may have paired the machine anew since.
 */
export function removeEnvironment(url: string, token?: string): StoredEnvironment[] {
  const all = readEnvironments();
  const list = all.filter((env) => env.url !== withoutTrailingSlashes(url) || (token !== undefined && env.token !== token));
  storeEnvironments(list);
  // The same key may be the one the window opens on next time: it goes too, or the
  // next start would send it to the address it was just forgotten at.
  const stored = readStoredEndpoint();
  if (stored?.url === withoutTrailingSlashes(url) && all.some((env) => !list.includes(env) && env.token === stored.token)) clearStoredEndpoint();
  return list;
}

/**
 * Forgets a machine the group brought, when the saved entry is still the one
 * the group brought: paired by hand since, in this window or another, the
 * entry is the owner's and stays. `dropped` says the group dropped the
 * machine, and which admission of it: its address is then marked for every
 * window. Without it the machine only moved, and nothing is marked.
 */
export function removeBrought(url: string, machine: { coreId: string; groupId?: string }, dropped?: number): StoredEnvironment[] {
  const { coreId, groupId } = machine;
  // The machine is marked whatever is saved for this address: another window may hold it under another one.
  if (dropped !== undefined && groupId !== undefined) setMark(memberKey(groupId, coreId), dropped);
  const saved = readEnvironments().find((env) => env.url === withoutTrailingSlashes(url));
  const stored = readStoredEndpoint();
  // Something saved must say the group brought that machine there. An address a member merely gave, and
  // that was only tried, is not one to touch: a key the owner holds for whoever really sits there stays.
  const mine = saved?.coreId === coreId || (stored?.url === withoutTrailingSlashes(url) && stored.coreId === coreId);
  if (!mine || (saved !== undefined && saved.coreId !== coreId)) return readEnvironments();
  if (dropped === undefined) return removeEnvironment(url, saved?.token);
  // The address is marked first: a key another window left for that machine, in the list or as the core
  // it opens on, is not read again either.
  setDropped(url, dropped);
  if (rawStoredUrl() === withoutTrailingSlashes(url)) clearStoredEndpoint();
  return readEnvironments();
}

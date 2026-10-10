import { GRANT_QUERY_PARAM, PAIR_QUERY_PARAM, parseGroupRelayUrl } from '@boite/contracts';

export interface Endpoint {
  url: string;
  token: string;
  /**
   * A one-time pairing grant from the link that opened this page. Never
   * stored: it is spent on the first hello, and the session token that comes
   * back is what gets stored in its place.
   */
  grant?: string;
  /** A group ticket, spent like a grant: another machine of the core's group vouched for this client. */
  ticket?: string;
  /** The group member this endpoint is, when the group led here. */
  coreId?: string;
  /** The group that led here: only a member of that group can later say this machine left it. */
  groupId?: string;
  /** Which admission of that machine the group listed when it led here. */
  epoch?: number;
  /**
   * The token is the session key a pairing link became, not a core token. In
   * the shell this is what lets a stored endpoint win over the core the shell
   * started itself: the user paired this app with a core somewhere else.
   */
  paired?: boolean;
  /** The core the shell started on this computer, the one a native folder picker can name paths for. */
  local?: boolean;
  /**
   * Taken from the address this page was opened on. Nothing about it is
   * stored until the core has answered a hello, so a link that leads nowhere,
   * or somewhere the user refused, leaves the stored core as it was.
   */
  fromLink?: boolean;
}

export const ENDPOINT_STORAGE_KEY = 'boite.core';
export const CORE_QUERY_PARAM = 'core';

function normalise(url: string): string {
  return url.replace(/\/+$/, '');
}

function isEndpoint(value: unknown): value is Endpoint {
  if (typeof value !== 'object' || value === null) return false;
  const shape = value as Record<string, unknown>;
  return typeof shape['url'] === 'string' && typeof shape['token'] === 'string';
}

export const DROPPED_STORAGE_KEY = 'boite.group.dropped';
const DROPPED_MAX = 256;
/** Machines remembered as dropped. A removal is never forgotten to make room: past this, nothing a group brings is reached by itself. */
const DROPPED_MEMBERS_MAX = 2048;

interface Dropped { at: number; epoch: number }

/** What this window knows was dropped: what it read or wrote, less what it cleared itself. */
const known = new Map<string, Dropped>();

/** Address to when the group dropped the machine there, and which admission of it that was. */
function droppedAddresses(): Record<string, Dropped> {
  try {
    const raw = window.localStorage.getItem(DROPPED_STORAGE_KEY);
    // Storage emptied: nothing is left for this window to put back.
    if (raw === null) known.clear();
    const parsed: unknown = JSON.parse(raw ?? '{}');
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed as Record<string, Partial<Dropped> | null>)
      .filter((entry): entry is [string, Dropped] => typeof entry[1]?.at === 'number' && typeof entry[1].epoch === 'number'));
  } catch {
    return {};
  }
}

function writeDropped(marks: Record<string, Dropped>): void {
  const entries = Object.entries(marks);
  // Addresses make room for newer ones: what was saved for an old one is long gone. Machines do not.
  const members = entries.filter(([key]) => key.startsWith('member ')).slice(0, DROPPED_MEMBERS_MAX);
  const addresses = entries.filter(([key]) => !key.startsWith('member ')).slice(-DROPPED_MAX);
  try {
    window.localStorage.setItem(DROPPED_STORAGE_KEY, JSON.stringify(Object.fromEntries([...members, ...addresses])));
  } catch {
    /* a browser that refuses storage still runs for this session */
  }
}

/**
 * Windows share the record without a lock: two that write at the same instant
 * each start from what they had read, and the later one erases or lowers what
 * the other recorded. A window that hears the record change puts back what it
 * knew. A lower admission is raised again. A machine's mark that went is
 * restored: when a later admission cleared it, that admission is past the mark
 * anyway. An address that went stays gone, since a pairing made by hand clears
 * it and putting it back would hide that machine.
 */
export function keepDropped(): void {
  const now = droppedAddresses();
  const back: Record<string, Dropped> = {};
  for (const [key, was] of known) {
    const mark = now[key];
    if (mark === undefined && !key.startsWith('member ')) known.delete(key);
    else if (mark === undefined || mark.epoch < was.epoch) back[key] = { at: Math.max(was.at, mark?.at ?? 0), epoch: was.epoch };
  }
  for (const [key, mark] of Object.entries({ ...now, ...back })) known.set(key, mark);
  if (Object.keys(back).length > 0) writeDropped({ ...now, ...back });
}

/**
 * The addresses of machines a group brought and then dropped, shared by every
 * window. Nothing saved for one is read again, whichever window left it and
 * wherever it sits, and no ticket is asked for it on the word of a member that
 * still lists the admission that was dropped. It ends when a new key is
 * issued for that address: by a pairing made by hand, or by the group having
 * admitted the machine again.
 */
function setDropped(url: string, epoch: number | null): void {
  setMark(normalise(url), epoch);
}

/** The same machine under every address it gives: a drop heard for one of them holds for the others. */
function memberKey(groupId: string, coreId: string): string {
  return `member ${groupId} ${coreId}`;
}

function setMark(target: string, epoch: number | null): void {
  const { [target]: was, ...rest } = droppedAddresses();
  if (epoch === null) {
    known.delete(target);
    if (was !== undefined) writeDropped(rest);
    return;
  }
  // A window that knew an older admission must not lower what another one recorded: the highest admission dropped stays.
  const mark = { at: Date.now(), epoch: Math.max(was?.epoch ?? epoch, known.get(target)?.epoch ?? epoch, epoch) };
  known.set(target, mark);
  writeDropped({ ...rest, [target]: mark });
}

/**
 * Whether the group dropped the machine at this address and nothing brought it
 * back. With `epoch`, the admission a member lists for it now: a later one
 * than the one dropped means the machine was admitted again, and is not dropped.
 */
export function isDropped(url: string, epoch?: number): boolean {
  const mark = droppedAddresses()[normalise(url)];
  return mark !== undefined && (epoch === undefined || epoch <= mark.epoch);
}

/**
 * Whether the address was dropped after `began`. A ticket exchange that began
 * before the drop and ends after it is for a machine that has left since: its
 * key is not kept, and does not bring the address back.
 */
export function droppedSince(url: string, began: number, member?: { coreId?: string; groupId?: string }): boolean {
  const marks = droppedAddresses();
  const of = member?.coreId !== undefined && member.groupId !== undefined ? marks[memberKey(member.groupId, member.coreId)] : undefined;
  return [marks[normalise(url)], of].some((mark) => mark !== undefined && mark.at >= began);
}

/**
 * Whether the group dropped this machine, whatever address it is reached at.
 * With `epoch`, the admission a member lists for it now: a later one than the
 * one dropped is the machine admitted again.
 */
export function isMemberDropped(groupId: string | undefined, coreId: string | undefined, epoch?: number): boolean {
  if (groupId === undefined || coreId === undefined) return false;
  const marks = droppedAddresses();
  const mark = marks[memberKey(groupId, coreId)];
  // No room left to remember a removal: one that could not be written must not look like none.
  if (mark === undefined) return Object.keys(marks).filter((key) => key.startsWith('member ')).length >= DROPPED_MEMBERS_MAX;
  return epoch === undefined || epoch <= mark.epoch;
}

export function readStoredEndpoint(): Endpoint | null {
  try {
    const raw = window.localStorage.getItem(ENDPOINT_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isEndpoint(parsed) || isDropped(parsed.url)) return null;
    return { url: normalise(parsed.url), token: parsed.token, ...(parsed.paired === true ? { paired: true } : {}), ...brought(parsed) };
  } catch {
    return null;
  }
}

/** The marks of a machine a group brought, kept wherever its key is saved: without them it would pass for one paired by hand. */
function brought(from: { coreId?: unknown; groupId?: unknown; epoch?: unknown }): { coreId?: string; groupId?: string; epoch?: number } {
  return {
    ...(typeof from.coreId === 'string' ? { coreId: from.coreId } : {}),
    ...(typeof from.groupId === 'string' ? { groupId: from.groupId } : {}),
    ...(typeof from.coreId === 'string' && typeof from.epoch === 'number' ? { epoch: from.epoch } : {})
  };
}

export function storeEndpoint(endpoint: Endpoint): void {
  try {
    window.localStorage.setItem(
      ENDPOINT_STORAGE_KEY,
      JSON.stringify({ url: normalise(endpoint.url), token: endpoint.token, ...(endpoint.paired ? { paired: true } : {}), ...brought(endpoint) })
    );
  } catch {
    /* a browser that refuses storage still runs for this session */
  }
}

export function clearStoredEndpoint(): void {
  try {
    window.localStorage.removeItem(ENDPOINT_STORAGE_KEY);
  } catch {
    /* nothing to clear */
  }
}

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
    ...brought(stored)
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
    if (entry.url === normalise(local.url)) return false;
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
}): StoredEnvironment[] {
  const url = normalise(entry.url);
  const list = readEnvironments();
  const at = list.findIndex((env) => env.url === url);
  const label = entry.label ?? list[at]?.label ?? defaultEnvironmentLabel(url);
  const next: StoredEnvironment = {
    url, label, token: entry.token, paired: entry.paired,
    ...brought({ coreId: entry.coreId ?? list[at]?.coreId, groupId: entry.groupId ?? list[at]?.groupId, epoch: entry.epoch ?? list[at]?.epoch })
  };
  if (at === -1) {
    list.push(next);
  } else {
    list[at] = next;
  }
  storeEnvironments(list);
  return list;
}

/** The machine was paired by hand since: it is no longer the group's to drop. */
export function forgetGroupOf(url: string): StoredEnvironment[] {
  setDropped(url, null);
  const list = readEnvironments().map((env) => (env.url === normalise(url) ? { url: env.url, label: env.label, token: env.token, paired: env.paired } : env));
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
 * Forgets the core. Its key stays valid there until revoked; it just opens
 * nothing from here. With `token`, only the entry that still holds that key
 * goes: another window may have paired the machine anew since.
 */
export function removeEnvironment(url: string, token?: string): StoredEnvironment[] {
  const all = readEnvironments();
  const list = all.filter((env) => env.url !== normalise(url) || (token !== undefined && env.token !== token));
  storeEnvironments(list);
  // The same key may be the one the window opens on next time: it goes too, or the
  // next start would send it to the address it was just forgotten at.
  const stored = readStoredEndpoint();
  if (stored?.url === normalise(url) && all.some((env) => !list.includes(env) && env.token === stored.token)) clearStoredEndpoint();
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
  const saved = readEnvironments().find((env) => env.url === normalise(url));
  const stored = readStoredEndpoint();
  // Something saved must say the group brought that machine there. An address a member merely gave, and
  // that was only tried, is not one to touch: a key the owner holds for whoever really sits there stays.
  const mine = saved?.coreId === coreId || (stored?.url === normalise(url) && stored.coreId === coreId);
  if (!mine || (saved !== undefined && saved.coreId !== coreId)) return readEnvironments();
  if (dropped === undefined) return removeEnvironment(url, saved?.token);
  // The address is marked first: a key another window left for that machine, in the list or as the core
  // it opens on, is not read again either.
  setDropped(url, dropped);
  if (rawStoredUrl() === normalise(url)) clearStoredEndpoint();
  return readEnvironments();
}

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

export function readMainMachine(): MainMachine | null {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(MAIN_STORAGE_KEY) ?? 'null');
    if (typeof parsed !== 'object' || parsed === null) return null;
    const shape = parsed as Record<string, unknown>;
    if (shape['local'] === true) return { local: true };
    if (typeof shape['url'] !== 'string') return null;
    const member = typeof shape['coreId'] === 'string' && typeof shape['groupId'] === 'string' ? { coreId: shape['coreId'], groupId: shape['groupId'] } : {};
    return { url: normalise(shape['url']), ...member };
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
  const keyed = readEnvironments().filter((env) => env.token !== '');
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
  const env = 'local' in main ? readEnvironments().find((entry) => entry.token !== '' && servesThisPage(entry.url)) : mainEnvironment(main);
  if (env) storeEndpoint(env);
  else if ('local' in main) clearStoredEndpoint();
}

function rawStoredUrl(): string | null {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(ENDPOINT_STORAGE_KEY) ?? 'null');
    return isEndpoint(parsed) ? normalise(parsed.url) : null;
  } catch {
    return null;
  }
}

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
  return { url: normalise(core ?? `${link.origin}${link.pathname}`), grant };
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

  const url = normalise(core ?? window.location.origin);
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
  return core ? normalise(core) : null;
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

/**
 * What a tapped notification put in the address: `?thread=`, and `?member=`
 * when another machine of the group sent it through this page's core
 * (`member`, since `?core=` is a pairing link's address of a core). Taken off
 * at once, so a reload during the boot does not jump there again.
 */
export function takeNotificationTarget(): { thread: string | null; member: string | null } {
  const query = new URLSearchParams(window.location.search);
  const thread = query.get('thread');
  const member = query.get('member');
  if (thread !== null || member !== null) {
    const url = new URL(window.location.href);
    url.searchParams.delete('thread');
    url.searchParams.delete('member');
    window.history.replaceState(window.history.state, '', url);
  }
  return { thread: thread || null, member: thread && member !== null && /^[0-9a-f]{64}$/.test(member) ? member : null };
}

/**
 * A path the core answers on its own HTTP server (`/file/...`, `/view/...`),
 * as an address of the core at `endpointUrl`. Joined, not resolved: a core
 * reached through a relay route answers under that route's path.
 */
export function coreHref(endpointUrl: string, path: string): string {
  return `${endpointUrl.replace(/\/+$/, '')}${path}`;
}

/**
 * For a machine reached through another member's relay route, this device's
 * key for that member, where it keeps it: the core it opens on, or the
 * remembered ones. Null for an address that is no relay, or a member it holds
 * no key for.
 */
export function relayKeyFor(url: string): string | null {
  const relay = parseGroupRelayUrl(url);
  if (relay === null) return null;
  const stored = readStoredEndpoint();
  if (stored?.url === relay.member && stored.token !== '') return stored.token;
  return readEnvironments().find((env) => env.url === relay.member && env.token !== '')?.token ?? null;
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
    return isEndpoint(result) ? { url: normalise(result.url), token: result.token, local: true } : null;
  } catch (error) {
    shellRefusal = error instanceof Error ? error.message : String(error);
    return null;
  }
}

function fromOrigin(): Endpoint | null {
  const protocol = window.location.protocol;
  if (protocol !== 'http:' && protocol !== 'https:') return null;
  return { url: normalise(window.location.origin), token: '' };
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
  return remembered ? { url, token: remembered.token, ...(remembered.paired ? { paired: true } : {}), ...brought(remembered) } : null;
}

/**
 * A link on this page's own origin, or naming a core this device already
 * holds a key for, goes through. Any other core could be anyone's: a crafted
 * `?core=` would otherwise point this UI at a stranger who then sees every
 * prompt typed here, so the user is asked first, and a missing asker refuses.
 */
async function followLink(endpoint: Endpoint, approve?: (url: string) => Promise<boolean>): Promise<boolean> {
  const known = endpoint.url === normalise(window.location.origin) || knownEndpoint(endpoint.url) !== null;
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

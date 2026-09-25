import { GRANT_QUERY_PARAM, PAIR_QUERY_PARAM } from '@boite/contracts';

export interface Endpoint {
  url: string;
  token: string;
  /**
   * A one-time pairing grant from the link that opened this page. Never
   * stored: it is spent on the first hello, and the session token that comes
   * back is what gets stored in its place.
   */
  grant?: string;
  /**
   * The token is the session key a pairing link became, not a core token. In
   * the shell this is what lets a stored endpoint win over the core the shell
   * started itself: the user paired this app with a core somewhere else.
   */
  paired?: boolean;
  /** The core the shell started on this computer, the one a native folder picker can name paths for. */
  local?: boolean;
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

export function readStoredEndpoint(): Endpoint | null {
  try {
    const raw = window.localStorage.getItem(ENDPOINT_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isEndpoint(parsed)) return null;
    return { url: normalise(parsed.url), token: parsed.token, ...(parsed.paired === true ? { paired: true } : {}) };
  } catch {
    return null;
  }
}

export function storeEndpoint(endpoint: Endpoint): void {
  try {
    window.localStorage.setItem(
      ENDPOINT_STORAGE_KEY,
      JSON.stringify({ url: normalise(endpoint.url), token: endpoint.token, ...(endpoint.paired ? { paired: true } : {}) })
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
  try {
    const raw = window.localStorage.getItem(ENVIRONMENTS_STORAGE_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) list = parsed.filter(isEnvironment);
    }
  } catch {
    list = [];
  }
  if (list.length > 0) return list;
  const stored = readStoredEndpoint();
  if (!stored?.paired) return [];
  const seeded: StoredEnvironment = {
    url: stored.url,
    label: defaultEnvironmentLabel(stored.url),
    token: stored.token,
    paired: true
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
}): StoredEnvironment[] {
  const url = normalise(entry.url);
  const list = readEnvironments();
  const at = list.findIndex((env) => env.url === url);
  const label = entry.label ?? list[at]?.label ?? defaultEnvironmentLabel(url);
  if (at === -1) {
    list.push({ url, label, token: entry.token, paired: entry.paired });
  } else {
    list[at] = { url, label, token: entry.token, paired: entry.paired };
  }
  storeEnvironments(list);
  return list;
}

/** Forgets the core. Its key stays valid there until revoked; it just opens nothing from here. */
export function removeEnvironment(url: string): StoredEnvironment[] {
  const list = readEnvironments().filter((env) => env.url !== normalise(url));
  storeEnvironments(list);
  return list;
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
 */
function takeFromQuery(): Endpoint | null {
  const params = new URLSearchParams(window.location.search);
  const core = params.get(CORE_QUERY_PARAM);
  const token = params.get(PAIR_QUERY_PARAM);
  const grant = params.get(GRANT_QUERY_PARAM);
  if (!core && !token && !grant) return null;

  const endpoint: Endpoint = {
    url: normalise(core ?? window.location.origin),
    token: token ?? '',
    ...(grant ? { grant } : {})
  };
  // A grant is not a credential to keep: the stored token stays empty until
  // the session comes back, then `onSession` writes that one.
  storeEndpoint({ url: endpoint.url, token: endpoint.token });

  params.delete(CORE_QUERY_PARAM);
  params.delete(PAIR_QUERY_PARAM);
  params.delete(GRANT_QUERY_PARAM);
  const query = params.toString();
  const stripped = `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`;
  window.history.replaceState(null, '', stripped);

  return endpoint;
}

export function insideTauri(): boolean {
  return window.__TAURI_INTERNALS__ !== undefined;
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

/**
 * Where the core is, in order: a pairing link, then in the Tauri shell a core
 * this app was paired with and otherwise the one the shell started, then what
 * was stored by an earlier pairing, then the origin that served this page.
 */
export async function resolveEndpoint(preferLocal = false): Promise<Endpoint | null> {
  const paired = takeFromQuery();
  if (paired) return paired;

  if (insideTauri()) {
    const stored = readStoredEndpoint();
    if (stored?.paired && !preferLocal) return stored;
    return await fromTauri();
  }

  const stored = readStoredEndpoint();
  if (stored) return stored;

  return fromOrigin();
}

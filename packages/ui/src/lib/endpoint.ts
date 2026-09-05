import { PAIR_QUERY_PARAM } from '@boite/contracts';

export interface Endpoint {
  url: string;
  token: string;
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
    return isEndpoint(parsed) ? { url: normalise(parsed.url), token: parsed.token } : null;
  } catch {
    return null;
  }
}

export function storeEndpoint(endpoint: Endpoint): void {
  try {
    window.localStorage.setItem(
      ENDPOINT_STORAGE_KEY,
      JSON.stringify({ url: normalise(endpoint.url), token: endpoint.token })
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
 * The core's own pairing link carries the token alone, on a page it serves
 * itself, so an absent `core` parameter means the origin of this page.
 */
function takeFromQuery(): Endpoint | null {
  const params = new URLSearchParams(window.location.search);
  const core = params.get(CORE_QUERY_PARAM);
  const token = params.get(PAIR_QUERY_PARAM);
  if (!core && !token) return null;

  const endpoint: Endpoint = {
    url: normalise(core ?? window.location.origin),
    token: token ?? ''
  };
  storeEndpoint(endpoint);

  params.delete(CORE_QUERY_PARAM);
  params.delete(PAIR_QUERY_PARAM);
  const query = params.toString();
  const stripped = `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`;
  window.history.replaceState(null, '', stripped);

  return endpoint;
}

function insideTauri(): boolean {
  return window.__TAURI_INTERNALS__ !== undefined;
}

async function fromTauri(): Promise<Endpoint | null> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const result: unknown = await invoke('core_endpoint');
    return isEndpoint(result) ? { url: normalise(result.url), token: result.token } : null;
  } catch {
    return null;
  }
}

function fromOrigin(): Endpoint | null {
  const protocol = window.location.protocol;
  if (protocol !== 'http:' && protocol !== 'https:') return null;
  return { url: normalise(window.location.origin), token: '' };
}

/**
 * Where the core is, in order: a pairing link, the Tauri shell, what was stored
 * by an earlier pairing, then the origin that served this page.
 */
export async function resolveEndpoint(): Promise<Endpoint | null> {
  const paired = takeFromQuery();
  if (paired) return paired;

  if (insideTauri()) return await fromTauri();

  const stored = readStoredEndpoint();
  if (stored) return stored;

  return fromOrigin();
}

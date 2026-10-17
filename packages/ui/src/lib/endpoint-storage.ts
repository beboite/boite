// Owns the persisted core endpoint and the identity metadata saved with its key.
import { withoutTrailingSlashes } from '@boite/contracts';
import { isDropped } from './endpoint-dropped';

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
   * This device's key opens that machine: the id of the machine its hellos
   * are signed for. `token` is empty then. A machine of the device's group.
   */
  signs?: string;
  /**
   * Taken from the address this page was opened on. Nothing about it is
   * stored until the core has answered a hello, so a link that leads nowhere,
   * or somewhere the user refused, leaves the stored core as it was.
   */
  fromLink?: boolean;
}

export const ENDPOINT_STORAGE_KEY = 'boite.core';
export function isEndpoint(value: unknown): value is Endpoint {
  if (typeof value !== 'object' || value === null) return false;
  const shape = value as Record<string, unknown>;
  return typeof shape['url'] === 'string' && typeof shape['token'] === 'string';
}

export function readStoredEndpoint(): Endpoint | null {
  try {
    const raw = window.localStorage.getItem(ENDPOINT_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isEndpoint(parsed) || isDropped(parsed.url)) return null;
    return { url: withoutTrailingSlashes(parsed.url), token: parsed.token, ...(parsed.paired === true ? { paired: true } : {}), ...brought(parsed), ...signsOf(parsed) };
  } catch {
    return null;
  }
}

/** The marks of a machine a group brought, kept wherever its key is saved: without them it would pass for one paired by hand. */
export function brought(from: { coreId?: unknown; groupId?: unknown; epoch?: unknown }): { coreId?: string; groupId?: string; epoch?: number } {
  return {
    ...(typeof from.coreId === 'string' ? { coreId: from.coreId } : {}),
    ...(typeof from.groupId === 'string' ? { groupId: from.groupId } : {}),
    ...(typeof from.coreId === 'string' && typeof from.epoch === 'number' ? { epoch: from.epoch } : {})
  };
}

/** Whether this device holds something that opens the machine saved here: a key of its own for it, or its device key. */
export function opens(entry: { token: string; signs?: string }): boolean {
  return entry.token !== '' || entry.signs !== undefined;
}

/** The machine a device key signs for, kept beside the address. */
export function signsOf(from: { signs?: unknown }): { signs?: string } {
  return typeof from.signs === 'string' && /^[0-9a-f]{64}$/.test(from.signs) ? { signs: from.signs } : {};
}

export function storeEndpoint(endpoint: Endpoint): void {
  try {
    window.localStorage.setItem(
      ENDPOINT_STORAGE_KEY,
      JSON.stringify({ url: withoutTrailingSlashes(endpoint.url), token: endpoint.token, ...(endpoint.paired ? { paired: true } : {}), ...brought(endpoint), ...signsOf(endpoint) })
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

export function rawStoredUrl(): string | null {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(ENDPOINT_STORAGE_KEY) ?? 'null');
    return isEndpoint(parsed) ? withoutTrailingSlashes(parsed.url) : null;
  } catch {
    return null;
  }
}

/*
 * What an invitation link says, read in the client: `boite://contact#` then
 * base64url JSON, the format of the core's `contacts/invite.ts`. The core
 * checks every field when it joins; the client only reads the Tailscale share
 * an invitee without an API key must accept by hand before joining.
 */

export const INVITE_PREFIX = 'boite://contact#';
const SHARE = /^https:\/\/login\.tailscale\.com\/[A-Za-z0-9/_\-.?=&]{1,500}$/;

/** The link's JSON fields, or null when it is not an invitation. */
export function readInvite(link: string): Record<string, unknown> | null {
  const trimmed = link.trim();
  if (!trimmed.startsWith(INVITE_PREFIX) || trimmed.length > 8192) return null;
  const encoded = trimmed.slice(INVITE_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
  try {
    const bytes = Uint8Array.from(atob(encoded.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0));
    const wire: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return wire !== null && typeof wire === 'object' && !Array.isArray(wire) ? wire as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** The `https://login.tailscale.com/` share the link carries, else null. */
export function inviteShare(link: string): string | null {
  const share = readInvite(link)?.s;
  return typeof share === 'string' && SHARE.test(share) ? share : null;
}

/** base64url JSON after the prefix, as the core writes it. */
export function encodeInvite(fields: Record<string, unknown>): string {
  const bytes = new TextEncoder().encode(JSON.stringify(fields));
  return INVITE_PREFIX + btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

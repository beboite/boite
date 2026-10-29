/**
 * The one-time link a contact joins with: `boite://contact#` then this core's
 * card as base64url JSON. It carries no secret but its token, whose hash
 * alone the inviting core keeps, so it travels like a password.
 */
import { createHash, createPublicKey } from 'node:crypto';
import { invalidParams, unavailable } from '../errors.ts';
import { isTailnetAddress, isTailnetV6 } from '../group/addresses.ts';
import { checkBox } from '../group/seal.ts';

export const INVITE_PREFIX = 'boite://contact#';
/** How long an invitation stays good. */
export const INVITE_TTL_MS = 24 * 3_600_000;

export interface ContactCard {
  coreId: string;
  /** Ed25519 public key, SPKI PEM. */
  publicKey: string;
  /** X25519 public key requests to this core are sealed to, base64url. */
  box: string;
  machine: string;
}

export interface Invitation extends ContactCard {
  url: string;
  /** 64 hex characters; spent at the first join. */
  token: string;
  share: string | null;
  expiresAt: number;
}

interface Wire { v: 1; c: string; k: string; x: string; m: string; u: string; t: string; s: string | null; e: number }

export function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** The Ed25519 key in canonical PEM and the core id it stands for, or refused with the field. */
export function checkSigningKey(value: unknown, coreId: unknown, field: string): { publicKey: string; coreId: string } {
  let canonical: string;
  try {
    if (typeof value !== 'string' || value.length > 1000) throw new Error('not a key');
    const parsed = createPublicKey(value);
    if (parsed.asymmetricKeyType !== 'ed25519') throw new Error('not Ed25519');
    canonical = parsed.export({ type: 'spki', format: 'pem' }).toString();
  } catch {
    throw invalidParams(`${field}.publicKey: expected an Ed25519 public key in PEM`, { field: `${field}.publicKey` });
  }
  const id = createHash('sha256').update(canonical).digest('hex');
  if (id !== coreId) throw invalidParams(`${field}.coreId: expected the SHA-256 of its public key`, { field: `${field}.coreId` });
  return { publicKey: canonical, coreId: id };
}

export function checkMachine(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 100) throw invalidParams(`${field}: expected 1 to 100 characters`, { field });
  return value.trim();
}

export function checkCard(value: unknown, field: string): ContactCard {
  const card = value as Partial<ContactCard> | null;
  if (!card || typeof card !== 'object') throw invalidParams(`${field}: expected a contact card`, { field });
  const { publicKey, coreId } = checkSigningKey(card.publicKey, card.coreId, field);
  return { coreId, publicKey, box: checkBox(card.box, `${field}.box`), machine: checkMachine(card.machine, `${field}.machine`) };
}

const PLAIN_HTTP = 'expected https, or http to a tailnet name or address, or numeric loopback';

/** A tailnet address (100.64.0.0/10, fd7a:115c:a1e0::/48) or numeric loopback: WireGuard or the machine itself carries plain HTTP. */
function carried(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, '');
  return isTailnetAddress(bare) || isTailnetV6(bare) || bare === '127.0.0.1' || bare === '::1';
}

/** A DNS name, as opposed to an address written as numbers. */
function isName(host: string): boolean {
  return !host.startsWith('[') && !/^[\d.]+$/.test(host);
}

/**
 * What a guest dials: an origin, HTTPS anywhere, HTTP only to a tailnet name
 * or address, where WireGuard carries it, or to numeric loopback. A name
 * outside `*.ts.net` (a Headscale tailnet's base domain) passes here and is
 * resolved before the join dials it (`checkTailnetName`).
 */
export function contactUrl(raw: unknown, field: string): string {
  let url: URL;
  try { url = new URL(typeof raw === 'string' && raw.length <= 2048 ? raw : ''); } catch {
    throw invalidParams(`${field}: expected an http or https origin`, { field });
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw invalidParams(`${field}: expected an origin without credentials, path, query or fragment`, { field });
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (isName(host) || carried(host)))) {
    throw invalidParams(`${field}: ${PLAIN_HTTP}`, { field });
  }
  return url.origin;
}

export type Lookup = (host: string) => Promise<string[]>;

async function systemLookup(host: string): Promise<string[]> {
  // Loaded here: only a join to a name outside *.ts.net needs it.
  const { lookup } = await import('node:dns/promises');
  return (await lookup(host, { all: true, verbatim: true })).map(entry => entry.address);
}

/**
 * Plain HTTP to a name outside `*.ts.net` only when every address it resolves
 * to is on the tailnet or loopback: a Headscale MagicDNS name passes, a LAN or
 * public name is refused. A `*.ts.net` name is not resolved: a shared
 * machine's name may answer only once its share is accepted.
 */
export async function checkTailnetName(origin: string, field: string, lookup: Lookup = systemLookup): Promise<void> {
  const url = new URL(origin);
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'http:' || !isName(host) || host.endsWith('.ts.net')) return;
  let addresses: string[];
  try { addresses = await lookup(host); } catch {
    throw unavailable(`${field}: ${host} does not resolve, so this machine is not on the inviter's tailnet; join that tailnet with MagicDNS on, or ask the inviter for an invitation for another network`);
  }
  if (addresses.length === 0 || !addresses.every(carried)) {
    throw invalidParams(`${field}: ${host} resolves to ${addresses.join(', ') || 'nothing'}, outside the tailnet; ${PLAIN_HTTP}`, { field });
  }
}

export function encodeInvite(invite: Invitation): string {
  const wire: Wire = { v: 1, c: invite.coreId, k: invite.publicKey, x: invite.box, m: invite.machine, u: invite.url, t: invite.token, s: invite.share, e: invite.expiresAt };
  return `${INVITE_PREFIX}${Buffer.from(JSON.stringify(wire)).toString('base64url')}`;
}

/** The invitation a link carries, every field checked; an expired one is refused. */
export function decodeInvite(link: unknown, now = Date.now()): Invitation {
  if (typeof link !== 'string' || !link.trim().startsWith(INVITE_PREFIX) || link.length > 8192) {
    throw invalidParams(`link: expected an invitation starting with ${INVITE_PREFIX}`, { field: 'link' });
  }
  const encoded = link.trim().slice(INVITE_PREFIX.length);
  let wire: Partial<Wire>;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error('not base64url');
    wire = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Partial<Wire>;
    if (!wire || typeof wire !== 'object') throw new Error('not an object');
  } catch {
    throw invalidParams('link: expected base64url JSON after the prefix', { field: 'link' });
  }
  if (wire.v !== 1) throw invalidParams('link.v: expected 1', { field: 'link.v' });
  const card = checkCard({ coreId: wire.c, publicKey: wire.k, box: wire.x, machine: wire.m }, 'link');
  if (typeof wire.t !== 'string' || !/^[0-9a-f]{64}$/.test(wire.t)) throw invalidParams('link.token: expected 64 hex characters', { field: 'link.token' });
  if (!Number.isSafeInteger(wire.e)) throw invalidParams('link.expiresAt: expected a timestamp', { field: 'link.expiresAt' });
  if (wire.e! <= now) throw invalidParams('link: this invitation expired; ask for a new one', { field: 'link' });
  let share: string | null = null;
  if (wire.s !== null && wire.s !== undefined) {
    if (typeof wire.s !== 'string' || !/^https:\/\/login\.tailscale\.com\/[A-Za-z0-9/_\-.?=&]{1,500}$/.test(wire.s)) {
      throw invalidParams('link.share: expected a https://login.tailscale.com share link or null', { field: 'link.share' });
    }
    share = wire.s;
  }
  return { ...card, url: contactUrl(wire.u, 'link.url'), token: wire.t, share, expiresAt: wire.e! };
}

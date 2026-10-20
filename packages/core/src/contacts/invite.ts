/**
 * The one-time link a contact joins with: `boite://contact#` then this core's
 * card as base64url JSON. It carries no secret but its token, whose hash
 * alone the inviting core keeps, so it travels like a password.
 */
import { createHash, createPublicKey } from 'node:crypto';
import { invalidParams } from '../errors.ts';
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

/**
 * What a guest dials: an origin, HTTPS anywhere, HTTP only to a tailnet name
 * or address, where WireGuard carries it, or to numeric loopback.
 */
export function contactUrl(raw: unknown, field: string): string {
  let url: URL;
  try { url = new URL(typeof raw === 'string' && raw.length <= 2048 ? raw : ''); } catch {
    throw invalidParams(`${field}: expected an http or https origin`, { field });
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw invalidParams(`${field}: expected an origin without credentials, path, query or fragment`, { field });
  const host = url.hostname.toLowerCase();
  const tailnet = host.endsWith('.ts.net') || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/.test(host);
  const loopback = host === '127.0.0.1' || host === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (tailnet || loopback))) {
    throw invalidParams(`${field}: expected https, or http to a tailnet name (*.ts.net) or numeric loopback`, { field });
  }
  return url.origin;
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

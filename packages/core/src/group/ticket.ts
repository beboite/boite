/*
 * The two things a group hands out as text.
 *
 * An invitation is what a machine pastes to join: the group, the member that
 * minted it, where that member answers, its key fingerprint, its box key and
 * a one-time grant. The join request is sealed to that box key with the grant
 * as a pre-shared key, and the fingerprint is what the answer's signature must
 * match: on a network nobody trusts, only that member reads the request and
 * only it can answer.
 *
 * A ticket is a member's signed word that a client may open one socket on
 * another member: who vouches, for whom, at which role, until when. It carries
 * no secret of the target, only a signature the target checks against the
 * roster.
 */

import { GROUP_INVITE_PREFIX, PAIRING_ROLES, type PairingRole } from '@boite/contracts';
import { invalidParams, unauthorized } from '../errors.ts';
import { ADDRESSES_MAX, checkAddress } from './roster.ts';
import { checkBox } from './seal.ts';

export interface Invite {
  /** Group id. */
  g: string;
  /** Group name, shown before joining. */
  n: string;
  /** The inviting core's id: the fingerprint its answer must match. */
  c: string;
  /** Where the inviting core answers. */
  a: string[];
  /** The inviting core's box key: the join request is sealed to it, so the grant never travels readable. */
  x: string;
  /** The one-time grant. */
  t: string;
}

export function encodeInvite(invite: Invite): string {
  return GROUP_INVITE_PREFIX + Buffer.from(JSON.stringify({ v: 1, ...invite })).toString('base64url');
}

export function parseInvite(text: unknown): Invite {
  const bad = () => invalidParams(`invite: expected an invitation starting with ${GROUP_INVITE_PREFIX}, as "Invite a machine" gives it`, { field: 'invite' });
  if (typeof text !== 'string' || text.length > 4000) throw bad();
  const trimmed = text.trim();
  if (!trimmed.startsWith(GROUP_INVITE_PREFIX)) throw bad();
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(Buffer.from(trimmed.slice(GROUP_INVITE_PREFIX.length), 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch { throw bad(); }
  if (typeof raw !== 'object' || raw === null || raw['v'] !== 1) throw bad();
  const string = (value: unknown, max: number): string => {
    if (typeof value !== 'string' || !value || value.length > max) throw bad();
    return value;
  };
  if (!Array.isArray(raw['a']) || raw['a'].length === 0 || raw['a'].length > ADDRESSES_MAX) throw bad();
  if (typeof raw['c'] !== 'string' || !/^[0-9a-f]{64}$/.test(raw['c'])) throw bad();
  return {
    g: string(raw['g'], 64),
    n: string(raw['n'], 80),
    c: raw['c'],
    a: raw['a'].map((address) => checkAddress(address, 'invite')),
    x: (() => { try { return checkBox(raw['x'], 'invite'); } catch { throw bad(); } })(),
    t: string(raw['t'], 128),
  };
}

export interface TicketPayload {
  v: 1;
  /** Group id. */
  g: string;
  /** The member that vouches. */
  iss: string;
  /** The member the ticket opens. */
  aud: string;
  /** The address of that member the ticket is good at. */
  u: string;
  /** `core:<core id>` for a member's own shell, `device:<device id>` for a paired client. */
  sub: string;
  role: PairingRole;
  nonce: string;
  exp: number;
}

/** What a signature covers, with a prefix so a signed ticket is never a signed anything else. */
export function ticketSigningInput(encoded: string): Buffer {
  return Buffer.from(`boite-group-ticket\n${encoded}`);
}

export function encodeTicket(payload: TicketPayload, sign: (input: Buffer) => Buffer): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${encoded}.${sign(ticketSigningInput(encoded)).toString('base64url')}`;
}

/** The payload and what was signed, with every field read. The signature is the caller's to check. */
export function parseTicket(text: string): { payload: TicketPayload; encoded: string; signature: Buffer } {
  const bad = () => unauthorized('the group ticket is malformed');
  const cut = text.indexOf('.');
  if (text.length > 4000 || cut <= 0) throw bad();
  const encoded = text.slice(0, cut);
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Record<string, unknown>; } catch { throw bad(); }
  if (typeof raw !== 'object' || raw === null || raw['v'] !== 1) throw bad();
  for (const field of ['g', 'iss', 'aud', 'sub', 'nonce'] as const) {
    if (typeof raw[field] !== 'string' || !raw[field] || (raw[field] as string).length > 300) throw bad();
  }
  if (!PAIRING_ROLES.includes(raw['role'] as PairingRole) || !Number.isSafeInteger(raw['exp'])) throw bad();
  let address: string;
  try { address = checkAddress(raw['u'], 'ticket'); } catch { throw bad(); }
  return {
    payload: {
      v: 1,
      g: raw['g'] as string,
      iss: raw['iss'] as string,
      aud: raw['aud'] as string,
      u: address,
      sub: raw['sub'] as string,
      role: raw['role'] as PairingRole,
      nonce: raw['nonce'] as string,
      exp: raw['exp'] as number,
    },
    encoded,
    signature: Buffer.from(text.slice(cut + 1), 'base64url'),
  };
}

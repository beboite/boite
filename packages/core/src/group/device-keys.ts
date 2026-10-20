/*
 * The devices of a group, each with one key.
 *
 * A phone or a browser makes one Ed25519 key and keeps it. A member that
 * admits it lists it in the roster, signed: the key, its fingerprint, its role
 * and the member's word that it is in. From then on every member lets it in on
 * a signature of that key made for that member, minutes old and never seen
 * before (`hello` `device`). Nothing the device sends can be used on another
 * member or twice, so the address it dials does not have to be trusted with a
 * secret, and there is no key per member to hand out, carry or take back.
 *
 * A device counts while it is listed, not revoked, and the member that
 * admitted it is still one: a removed machine takes the devices it alone
 * vouched for with it. `remove` re-signs the others' devices first, so taking
 * an old computer out does not take the phone added through it.
 *
 * They live beside `devices`, the pairings of the older kind, and not in that
 * array: a core of an earlier version checks every entry there and would
 * refuse the whole roster for one it cannot read. It drops a field it does not
 * know instead, and keeps exchanging.
 */
import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';
import { PAIRING_ROLES, type PairingRole } from '@boite/contracts';
import { invalidParams } from '../errors.ts';

export interface DeviceKeyEntry {
  /** SHA-256 of the raw public key, hex. */
  id: string;
  /** The raw 32-byte Ed25519 public key, base64url. */
  publicKey: string;
  name: string;
  role: PairingRole;
  /** The member that let it in, and its signature over the group, the id and the role. */
  admit: { by: string; sig: string };
  /** When it was let in, by that member's clock. */
  at: number;
  rev: number;
  /** The member whose page it installed and that holds its push subscription. */
  push?: string;
  /** Pairings of the older kind (`<core id>:<session id>`) this key took over: revoking it revokes them. */
  legacy?: string[];
  removed?: true;
}

/** What a member publishes about where its page is served, besides its addresses: origins a page of it may open sockets from. */
export interface ServedOrigins {
  rev: number;
  list: string[];
}

export const SERVED_ORIGINS_MAX = 4;
/** Older pairings one device key may take over. */
export const LEGACY_MAX = 32;
const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');

/** The raw key as a key object, or null when it is not 32 bytes. */
export function deviceKey(publicKey: string): KeyObject | null {
  const raw = Buffer.from(publicKey, 'base64url');
  if (raw.length !== 32 || raw.toString('base64url') !== publicKey) return null;
  try {
    return createPublicKey({ key: Buffer.concat([SPKI_ED25519, raw]), format: 'der', type: 'spki' });
  } catch {
    return null;
  }
}

export function deviceId(publicKey: string): string {
  return createHash('sha256').update(Buffer.from(publicKey, 'base64url')).digest('hex');
}

/** Whether `sig` (base64url) is the device's signature over `input`. */
export function deviceSigned(publicKey: string, input: string, sig: unknown): boolean {
  const key = deviceKey(publicKey);
  if (key === null || typeof sig !== 'string' || sig.length > 200) return false;
  try {
    return verify(null, Buffer.from(input), key, Buffer.from(sig, 'base64url'));
  } catch {
    return false;
  }
}

/** What a member signs to let a device in. */
export function deviceAdmissionInput(groupId: string, id: string, role: PairingRole): Buffer {
  return Buffer.from(`boite-group-device\n${groupId}\n${id}\n${role}`);
}

export function text(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw invalidParams(`${field}: expected 1 to ${max} characters`, { field });
  return value;
}

export function positive(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw invalidParams(`${field}: expected a positive integer`, { field });
  return value as number;
}

export function checkDeviceKey(value: unknown, field = 'deviceKey'): DeviceKeyEntry {
  if (typeof value !== 'object' || value === null) throw invalidParams(`${field}: expected a device`, { field });
  const raw = value as Record<string, unknown>;
  const publicKey = text(raw['publicKey'], `${field}.publicKey`, 64);
  if (deviceKey(publicKey) === null) throw invalidParams(`${field}.publicKey: expected a raw Ed25519 key in base64url`, { field: `${field}.publicKey` });
  if (raw['id'] !== deviceId(publicKey)) throw invalidParams(`${field}.id: expected the SHA-256 of its public key`, { field: `${field}.id` });
  if (!PAIRING_ROLES.includes(raw['role'] as PairingRole)) throw invalidParams(`${field}.role: expected ${PAIRING_ROLES.join(' or ')}`, { field: `${field}.role` });
  const admit = raw['admit'] as { by?: unknown; sig?: unknown } | null | undefined;
  if (typeof admit !== 'object' || admit === null || typeof admit.by !== 'string' || !/^[0-9a-f]{64}$/.test(admit.by)) {
    throw invalidParams(`${field}.admit: expected the member that admitted this device`, { field: `${field}.admit` });
  }
  const push = raw['push'];
  if (push !== undefined && (typeof push !== 'string' || !/^[0-9a-f]{64}$/.test(push))) throw invalidParams(`${field}.push: expected a machine id`, { field: `${field}.push` });
  const legacy = raw['legacy'];
  if (legacy !== undefined && (!Array.isArray(legacy) || legacy.length > LEGACY_MAX || legacy.some((id) => typeof id !== 'string' || !/^[0-9a-f]{64}:[A-Za-z0-9_]{1,100}$/.test(id)))) {
    throw invalidParams(`${field}.legacy: expected at most ${LEGACY_MAX} <core id>:<session id>`, { field: `${field}.legacy` });
  }
  return {
    id: raw['id'] as string,
    publicKey,
    name: text(raw['name'], `${field}.name`, 100),
    role: raw['role'] as PairingRole,
    admit: { by: admit.by, sig: text(admit.sig, `${field}.admit.sig`, 200) },
    at: positive(raw['at'], `${field}.at`),
    rev: positive(raw['rev'], `${field}.rev`),
    ...(push === undefined ? {} : { push: push as string }),
    ...(legacy === undefined || (legacy as unknown[]).length === 0 ? {} : { legacy: [...new Set(legacy as string[])].sort() }),
    ...(raw['removed'] === true ? { removed: true as const } : {}),
  };
}

/** Whether a member of the roster really signed this device in. Who that member is now is the reader's question. */
export function deviceAdmitted(entry: DeviceKeyEntry, groupId: string, keys: ReadonlyMap<string, string>): boolean {
  const key = keys.get(entry.admit.by);
  if (key === undefined) return false;
  try {
    return verify(null, deviceAdmissionInput(groupId, entry.id, entry.role), key, Buffer.from(entry.admit.sig, 'base64'));
  } catch {
    return false;
  }
}

export function checkServedOrigins(value: unknown, checkAddress: (raw: unknown, field: string) => string): Record<string, ServedOrigins> {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalidParams('roster.origins: expected origins by machine', { field: 'roster.origins' });
  const out: Record<string, ServedOrigins> = {};
  for (const [coreId, raw] of Object.entries(value)) {
    if (!/^[0-9a-f]{64}$/.test(coreId)) throw invalidParams('roster.origins: expected machine ids', { field: 'roster.origins' });
    const entry = raw as { rev?: unknown; list?: unknown } | null;
    if (typeof entry !== 'object' || entry === null || !Array.isArray(entry.list) || entry.list.length > SERVED_ORIGINS_MAX) {
      throw invalidParams(`roster.origins.${coreId}: expected at most ${SERVED_ORIGINS_MAX} origins`, { field: 'roster.origins' });
    }
    out[coreId] = { rev: positive(entry.rev, `roster.origins.${coreId}.rev`), list: [...new Set(entry.list.map((origin) => checkAddress(origin, `roster.origins.${coreId}`)))] };
  }
  return out;
}

/** Inside one epoch: the removal, then the later revision, then a fixed order so both sides agree. */
export function wins(a: { rev: number; removed?: true }, b: { rev: number; removed?: true }): boolean {
  if ((a.removed === true) !== (b.removed === true)) return a.removed === true;
  if (a.rev !== b.rev) return a.rev > b.rev;
  return JSON.stringify(a) > JSON.stringify(b);
}

/** A revoked key is final: the member that revokes it may not have heard of its latest revision. */
export function mergeDeviceKeys(local: readonly DeviceKeyEntry[], remote: readonly DeviceKeyEntry[]): DeviceKeyEntry[] {
  const merged = new Map(local.map((entry) => [entry.id, entry] as const));
  for (const entry of remote) {
    const known = merged.get(entry.id);
    if (known === undefined) {
      merged.set(entry.id, entry);
      continue;
    }
    // The same key handed over on two members took over a pairing on each: both stay revoked with it.
    const winner = wins(entry, known) ? entry : known;
    const legacy = [...new Set([...(known.legacy ?? []), ...(entry.legacy ?? [])])].sort().slice(0, LEGACY_MAX);
    merged.set(entry.id, legacy.length === 0 ? winner : { ...winner, legacy });
  }
  return [...merged.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Each member's own word on where it is served; the later revision wins, and absence says nothing. */
export function mergeServedOrigins(local: Readonly<Record<string, ServedOrigins>>, remote: Readonly<Record<string, ServedOrigins>>): Record<string, ServedOrigins> {
  const merged: Record<string, ServedOrigins> = { ...local };
  for (const [coreId, entry] of Object.entries(remote)) {
    const known = merged[coreId];
    if (known === undefined || entry.rev > known.rev || (entry.rev === known.rev && JSON.stringify(entry.list) > JSON.stringify(known.list))) merged[coreId] = entry;
  }
  return Object.fromEntries(Object.entries(merged).sort(([a], [b]) => a.localeCompare(b)));
}

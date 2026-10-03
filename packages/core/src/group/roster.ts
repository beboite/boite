/*
 * The roster of a group: the machines and the devices they vouch for.
 *
 * Every member holds the whole roster and they exchange it whole. An entry
 * carries a revision; the higher one wins, and at the same revision a removal
 * wins, so two members that changed things apart end on the same roster
 * whichever order they hear of each other in. A removed entry stays as a
 * tombstone: without it, a member that was offline during the removal would
 * bring the entry back on its return.
 */

import { createHash, createPublicKey } from 'node:crypto';
import { GROUP_MAX_CORES, PAIRING_ROLES, type Os, type PairingRole } from '@boite/contracts';
import { invalidParams } from '../errors.ts';

export interface CoreEntry {
  coreId: string;
  name: string;
  /** Ed25519, SPKI PEM. `coreId` is its SHA-256. */
  publicKey: string;
  addresses: string[];
  os?: Os;
  rev: number;
  removed?: true;
}

export interface DeviceEntry {
  /** `<home core id>:<session id>`. */
  id: string;
  name: string;
  role: PairingRole;
  rev: number;
  removed?: true;
}

export interface Roster {
  id: string;
  name: string;
  cores: CoreEntry[];
  devices: DeviceEntry[];
}

/** Tombstones included: a group that removed more machines than this drops its oldest removals. */
export const CORE_ENTRIES_MAX = 128;
/** Tombstones included, so the roster stays far under the 256 KB one exchange carries. */
export const DEVICE_ENTRIES_MAX = 500;
export const ADDRESSES_MAX = 8;
const OS: readonly Os[] = ['windows', 'linux', 'macos'];

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw invalidParams(`${field}: expected 1 to ${max} characters`, { field });
  return value;
}

function revision(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw invalidParams(`${field}: expected a positive integer`, { field });
  return value as number;
}

/** The key as this core writes it, and the id that is its fingerprint. */
export function fingerprint(publicKey: string): { coreId: string; publicKey: string } {
  let canonical: string;
  try {
    const parsed = createPublicKey(publicKey);
    if (parsed.asymmetricKeyType !== 'ed25519') throw new Error('not Ed25519');
    canonical = parsed.export({ type: 'spki', format: 'pem' }).toString();
  } catch {
    throw invalidParams('publicKey: expected an Ed25519 public key in PEM', { field: 'publicKey' });
  }
  return { coreId: createHash('sha256').update(canonical).digest('hex'), publicKey: canonical };
}

/** An address is an origin: scheme, host and port, nothing a request could be steered with. */
export function checkAddress(raw: unknown, field = 'address'): string {
  const value = text(raw, field, 300);
  let url: URL;
  try { url = new URL(value); } catch { throw invalidParams(`${field}: expected an http or https origin, got ${value}`, { field }); }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw invalidParams(`${field}: expected an http or https origin without credentials, path or query, got ${value}`, { field });
  }
  return url.origin;
}

export function checkCore(value: unknown, field = 'core'): CoreEntry {
  if (typeof value !== 'object' || value === null) throw invalidParams(`${field}: expected a machine`, { field });
  const raw = value as Record<string, unknown>;
  const key = fingerprint(text(raw['publicKey'], `${field}.publicKey`, 1000));
  if (raw['coreId'] !== key.coreId) throw invalidParams(`${field}.coreId: expected the fingerprint of its public key`, { field: `${field}.coreId` });
  if (!Array.isArray(raw['addresses']) || raw['addresses'].length > ADDRESSES_MAX) {
    throw invalidParams(`${field}.addresses: expected at most ${ADDRESSES_MAX} origins`, { field: `${field}.addresses` });
  }
  const addresses = [...new Set(raw['addresses'].map((address) => checkAddress(address, `${field}.addresses`)))];
  return {
    coreId: key.coreId,
    name: text(raw['name'], `${field}.name`, 100),
    publicKey: key.publicKey,
    addresses,
    ...(OS.includes(raw['os'] as Os) ? { os: raw['os'] as Os } : {}),
    rev: revision(raw['rev'], `${field}.rev`),
    ...(raw['removed'] === true ? { removed: true as const } : {}),
  };
}

export function checkDevice(value: unknown, field = 'device'): DeviceEntry {
  if (typeof value !== 'object' || value === null) throw invalidParams(`${field}: expected a device`, { field });
  const raw = value as Record<string, unknown>;
  const id = text(raw['id'], `${field}.id`, 200);
  if (!/^[0-9a-f]{64}:[A-Za-z0-9_]{1,100}$/.test(id)) throw invalidParams(`${field}.id: expected <core id>:<session id>`, { field: `${field}.id` });
  if (!PAIRING_ROLES.includes(raw['role'] as PairingRole)) throw invalidParams(`${field}.role: expected ${PAIRING_ROLES.join(' or ')}`, { field: `${field}.role` });
  return {
    id,
    name: text(raw['name'], `${field}.name`, 100),
    role: raw['role'] as PairingRole,
    rev: revision(raw['rev'], `${field}.rev`),
    ...(raw['removed'] === true ? { removed: true as const } : {}),
  };
}

/** A roster as another machine sent it: every field read, nothing taken on its word. */
export function checkRoster(value: unknown): Roster {
  if (typeof value !== 'object' || value === null) throw invalidParams('roster: expected a group roster', { field: 'roster' });
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw['cores']) || raw['cores'].length === 0 || raw['cores'].length > CORE_ENTRIES_MAX) {
    throw invalidParams(`roster.cores: expected 1 to ${CORE_ENTRIES_MAX} machines`, { field: 'roster.cores' });
  }
  if (!Array.isArray(raw['devices']) || raw['devices'].length > DEVICE_ENTRIES_MAX) {
    throw invalidParams(`roster.devices: expected at most ${DEVICE_ENTRIES_MAX} devices`, { field: 'roster.devices' });
  }
  const roster: Roster = {
    id: text(raw['id'], 'roster.id', 64),
    name: text(raw['name'], 'roster.name', 80),
    cores: raw['cores'].map((core) => checkCore(core, 'roster.cores')),
    devices: raw['devices'].map((device) => checkDevice(device, 'roster.devices')),
  };
  if (new Set(roster.cores.map((core) => core.coreId)).size !== roster.cores.length) throw invalidParams('roster.cores: a machine is listed twice', { field: 'roster.cores' });
  if (new Set(roster.devices.map((device) => device.id)).size !== roster.devices.length) throw invalidParams('roster.devices: a device is listed twice', { field: 'roster.devices' });
  if (liveCores(roster).length > GROUP_MAX_CORES) throw invalidParams(`roster.cores: a group holds at most ${GROUP_MAX_CORES} machines`, { field: 'roster.cores' });
  return sorted(roster);
}

export function liveCores(roster: Roster): CoreEntry[] {
  return roster.cores.filter((core) => !core.removed);
}

/** A device counts while it is listed and the member it paired with is still in the group. */
export function liveDevices(roster: Roster): DeviceEntry[] {
  const homes = new Set(liveCores(roster).map((core) => core.coreId));
  return roster.devices.filter((device) => !device.removed && homes.has(homeOf(device.id)));
}

export function homeOf(deviceId: string): string {
  return deviceId.slice(0, deviceId.indexOf(':'));
}

/** The highest revision the roster holds: the next change is one above it. */
export function clockOf(roster: Roster): number {
  let clock = 0;
  for (const entry of roster.cores) clock = Math.max(clock, entry.rev);
  for (const entry of roster.devices) clock = Math.max(clock, entry.rev);
  return clock;
}

function sorted(roster: Roster): Roster {
  return {
    id: roster.id,
    name: roster.name,
    cores: [...roster.cores].sort((a, b) => a.coreId.localeCompare(b.coreId)),
    devices: [...roster.devices].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

/** Two rosters with the same digest are the same roster, whatever order they were built in. */
export function digestOf(roster: Roster): string {
  return createHash('sha256').update(JSON.stringify(sorted(roster))).digest('hex');
}

/** Whether `a` replaces `b`: the later revision, then the removal, then a fixed order so both sides agree. */
function wins(a: { rev: number; removed?: true }, b: { rev: number; removed?: true }): boolean {
  if (a.rev !== b.rev) return a.rev > b.rev;
  if ((a.removed === true) !== (b.removed === true)) return a.removed === true;
  return JSON.stringify(a) > JSON.stringify(b);
}

function mergeEntries<T extends { rev: number; removed?: true }>(local: T[], remote: T[], key: (entry: T) => string, max: number): T[] {
  const merged = new Map(local.map((entry) => [key(entry), entry] as const));
  for (const entry of remote) {
    const known = merged.get(key(entry));
    if (known === undefined || wins(entry, known)) merged.set(key(entry), entry);
  }
  const all = [...merged.values()];
  if (all.length <= max) return all;
  // Over the bound, the oldest removals go first; a live entry is never dropped here.
  const tombstones = all.filter((entry) => entry.removed).sort((a, b) => a.rev - b.rev);
  const drop = new Set(tombstones.slice(0, all.length - max));
  return all.filter((entry) => !drop.has(entry));
}

/**
 * Both rosters as one. Merging is commutative and idempotent, so one exchange
 * each way leaves two members equal. The group's id and name are the local
 * ones: a roster of another group is refused before it gets here.
 */
export function mergeRosters(local: Roster, remote: Roster): Roster {
  return sorted({
    id: local.id,
    name: local.name,
    cores: mergeEntries(local.cores, remote.cores, (core) => core.coreId, CORE_ENTRIES_MAX),
    devices: mergeEntries(local.devices, remote.devices, (device) => device.id, DEVICE_ENTRIES_MAX),
  });
}

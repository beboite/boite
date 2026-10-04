/*
 * The roster of a group: the machines and the devices they vouch for.
 *
 * Every member holds the whole roster and they exchange it whole. What makes
 * a machine a member is an admission: the word of a machine that was already
 * one, signed, for one epoch. A removal ends that epoch for good, whatever
 * revision anybody shows afterwards, and only a new admission, signed by a
 * machine the receiver itself counts as a member, opens the next. So a removed
 * machine cannot write itself back in, directly or through a member that has
 * not heard of its removal: it would need a member's signature.
 *
 * Inside an epoch an entry carries a revision and the higher one wins: that is
 * a machine republishing its name and addresses. A device's removal is final
 * too. Removed entries stay as tombstones and are never dropped: one that went
 * missing would let a stale copy bring the entry back. The roster therefore
 * only grows, and a group stops taking new entries at a bound instead.
 */

import { createHash, createPublicKey, verify } from 'node:crypto';
import { GROUP_MAX_CORES, PAIRING_ROLES, type Os, type PairingRole } from '@boite/contracts';
import { invalidParams } from '../errors.ts';
import { boxSigningInput, checkBox } from './seal.ts';

export interface CoreEntry {
  coreId: string;
  name: string;
  /** Ed25519, SPKI PEM. `coreId` is its SHA-256. */
  publicKey: string;
  /** X25519 public key the others seal their requests to, base64url. */
  box: string;
  /** This machine's own signature over its id and `box`: no other member can put a key of its choosing here. */
  boxSig: string;
  addresses: string[];
  os?: Os;
  /** Which admission this entry lives under: 1 at the first, one more each time the machine is let back in. */
  epoch: number;
  /** Who let it in for this epoch, and that machine's signature over the group, this id and the epoch. */
  admit: { by: string; sig: string };
  rev: number;
  removed?: true;
}

/** What a machine says of itself: an entry before any member admitted it. */
export type CoreCard = Omit<CoreEntry, 'epoch' | 'admit' | 'rev' | 'removed'>;

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
  /** The machine that started the group: the one entry that admitted itself. */
  founder: string;
  cores: CoreEntry[];
  devices: DeviceEntry[];
}

/** Machines a group lists over its life, removed ones included: past it, no new machine is admitted. */
export const CORE_ENTRIES_MAX = 64;
/** Devices a group lists over its life, revoked ones included, so the roster stays under the 256 KB one exchange carries. */
export const DEVICE_ENTRIES_MAX = 400;
/** Two members may each add one entry at the bound before they hear of each other: a roster a little over it is still read. */
const OVERSHOOT = 2;
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

/** What a member signs to let a machine in: the group, the machine and the epoch, nothing that changes later. */
export function admissionInput(groupId: string, coreId: string, epoch: number): Buffer {
  return Buffer.from(`boite-group-admit\n${groupId}\n${coreId}\n${epoch}`);
}

/** A machine as it describes itself, before any admission: what a join request carries. */
export function checkCard(value: unknown, field = 'core'): CoreCard {
  if (typeof value !== 'object' || value === null) throw invalidParams(`${field}: expected a machine`, { field });
  const raw = value as Record<string, unknown>;
  const key = fingerprint(text(raw['publicKey'], `${field}.publicKey`, 1000));
  if (raw['coreId'] !== key.coreId) throw invalidParams(`${field}.coreId: expected the fingerprint of its public key`, { field: `${field}.coreId` });
  if (!Array.isArray(raw['addresses']) || raw['addresses'].length > ADDRESSES_MAX) {
    throw invalidParams(`${field}.addresses: expected at most ${ADDRESSES_MAX} origins`, { field: `${field}.addresses` });
  }
  const addresses = [...new Set(raw['addresses'].map((address) => checkAddress(address, `${field}.addresses`)))];
  const box = checkBox(raw['box'], `${field}.box`);
  const boxSig = text(raw['boxSig'], `${field}.boxSig`, 200);
  let signed = false;
  try { signed = verify(null, boxSigningInput(key.coreId, box), key.publicKey, Buffer.from(boxSig, 'base64')); } catch { signed = false; }
  if (!signed) throw invalidParams(`${field}.boxSig: expected this machine's signature over its box key`, { field: `${field}.boxSig` });
  return {
    coreId: key.coreId,
    name: text(raw['name'], `${field}.name`, 100),
    publicKey: key.publicKey,
    box,
    boxSig,
    addresses,
    ...(OS.includes(raw['os'] as Os) ? { os: raw['os'] as Os } : {}),
  };
}

export function checkCore(value: unknown, field = 'core'): CoreEntry {
  const card = checkCard(value, field);
  const raw = value as Record<string, unknown>;
  const admit = raw['admit'] as { by?: unknown; sig?: unknown } | null | undefined;
  if (typeof admit !== 'object' || admit === null || typeof admit.by !== 'string' || !/^[0-9a-f]{64}$/.test(admit.by)) {
    throw invalidParams(`${field}.admit: expected the member that admitted this machine`, { field: `${field}.admit` });
  }
  return {
    ...card,
    epoch: revision(raw['epoch'], `${field}.epoch`),
    admit: { by: admit.by, sig: text(admit.sig, `${field}.admit.sig`, 200) },
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
  if (!Array.isArray(raw['cores']) || raw['cores'].length === 0 || raw['cores'].length > CORE_ENTRIES_MAX * OVERSHOOT) {
    throw invalidParams(`roster.cores: expected 1 to ${CORE_ENTRIES_MAX * OVERSHOOT} machines`, { field: 'roster.cores' });
  }
  if (!Array.isArray(raw['devices']) || raw['devices'].length > DEVICE_ENTRIES_MAX * OVERSHOOT) {
    throw invalidParams(`roster.devices: expected at most ${DEVICE_ENTRIES_MAX * OVERSHOOT} devices`, { field: 'roster.devices' });
  }
  if (typeof raw['founder'] !== 'string' || !/^[0-9a-f]{64}$/.test(raw['founder'])) throw invalidParams('roster.founder: expected a machine id', { field: 'roster.founder' });
  const roster: Roster = {
    id: text(raw['id'], 'roster.id', 64),
    name: text(raw['name'], 'roster.name', 80),
    founder: raw['founder'],
    cores: raw['cores'].map((core) => checkCore(core, 'roster.cores')),
    devices: raw['devices'].map((device) => checkDevice(device, 'roster.devices')),
  };
  if (new Set(roster.cores.map((core) => core.coreId)).size !== roster.cores.length) throw invalidParams('roster.cores: a machine is listed twice', { field: 'roster.cores' });
  if (new Set(roster.devices.map((device) => device.id)).size !== roster.devices.length) throw invalidParams('roster.devices: a device is listed twice', { field: 'roster.devices' });
  if (liveCores(roster).length > GROUP_MAX_CORES * OVERSHOOT) throw invalidParams(`roster.cores: a group holds at most ${GROUP_MAX_CORES} machines`, { field: 'roster.cores' });
  const keys = new Map(roster.cores.map((core) => [core.coreId, core.publicKey] as const));
  for (const core of roster.cores) {
    if (!admitted(core, roster.id, roster.founder, keys)) {
      throw invalidParams(`roster.cores: ${core.coreId} carries no valid admission by a machine of this roster`, { field: 'roster.cores' });
    }
  }
  return sorted(roster);
}

/**
 * Whether the entry's admission is a real signature by a machine of the same
 * roster. Only the founder admits itself, and only for its first epoch. Whether
 * that admitter had the right to admit is the receiver's question (`mergeRosters`).
 */
function admitted(core: CoreEntry, groupId: string, founder: string, keys: ReadonlyMap<string, string>): boolean {
  if (core.admit.by === core.coreId && !(core.coreId === founder && core.epoch === 1)) return false;
  const key = keys.get(core.admit.by);
  if (key === undefined) return false;
  try { return verify(null, admissionInput(groupId, core.coreId, core.epoch), key, Buffer.from(core.admit.sig, 'base64')); } catch { return false; }
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
    founder: roster.founder,
    cores: [...roster.cores].sort((a, b) => a.coreId.localeCompare(b.coreId)),
    devices: [...roster.devices].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

/** Two rosters with the same digest are the same roster, whatever order they were built in. */
export function digestOf(roster: Roster): string {
  return createHash('sha256').update(JSON.stringify(sorted(roster))).digest('hex');
}

/** Inside one epoch: the removal, then the later revision, then a fixed order so both sides agree. */
function wins(a: { rev: number; removed?: true }, b: { rev: number; removed?: true }): boolean {
  if ((a.removed === true) !== (b.removed === true)) return a.removed === true;
  if (a.rev !== b.rev) return a.rev > b.rev;
  return JSON.stringify(a) > JSON.stringify(b);
}

/**
 * The machines of both rosters. A remote entry of a later epoch is an
 * admission the local roster has not seen: it counts only when signed by a
 * machine this core held as a member before the merge, or by one it has just
 * accepted that way. A removal counts whoever reports it: when in doubt a
 * machine is out, and getting back in takes a member's signature.
 */
function mergeCores(local: CoreEntry[], remote: CoreEntry[]): CoreEntry[] {
  const merged = new Map(local.map((core) => [core.coreId, core] as const));
  const members = new Set(local.filter((core) => !core.removed).map((core) => core.coreId));
  let waiting = remote;
  for (let progressed = true; progressed && waiting.length > 0;) {
    progressed = false;
    const deferred: CoreEntry[] = [];
    for (const core of waiting) {
      const known = merged.get(core.coreId);
      const epoch = known?.epoch ?? 0;
      if (core.epoch < epoch) continue;
      if (core.epoch === epoch) {
        if (wins(core, known!)) merged.set(core.coreId, core);
        continue;
      }
      // A later epoch already ended is taken as ended: nobody is let in by that.
      if (!core.removed && !members.has(core.admit.by)) {
        deferred.push(core);
        continue;
      }
      merged.set(core.coreId, core);
      if (!core.removed) members.add(core.coreId);
      progressed = true;
    }
    waiting = deferred;
  }
  return [...merged.values()];
}

function mergeDevices(local: DeviceEntry[], remote: DeviceEntry[]): DeviceEntry[] {
  const merged = new Map(local.map((device) => [device.id, device] as const));
  for (const device of remote) {
    const known = merged.get(device.id);
    // A device is one pairing: revoked, it never comes back under the same id, and the
    // member that revokes it may not have heard of it yet.
    if (known === undefined || wins(device, known)) merged.set(device.id, device);
  }
  return [...merged.values()];
}

/**
 * The local roster with what the remote one adds. Two members that held the
 * same machines before end equal after one exchange each way. The group's id,
 * name and founder are the local ones: a roster of another group is refused
 * before it gets here.
 */
export function mergeRosters(local: Roster, remote: Roster): Roster {
  return sorted({
    id: local.id,
    name: local.name,
    founder: local.founder,
    cores: mergeCores(local.cores, remote.cores),
    devices: mergeDevices(local.devices, remote.devices),
  });
}

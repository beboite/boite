/*
 * How a client gets into the machines of a group.
 *
 * A device, a phone or a browser, holds one key the roster lists
 * (`device-keys.ts`): it is admitted once, with a grant, and says
 * hello on any member with a signature made for that member. The desktop app
 * of a member, and a client paired before device keys, gets a ticket from a
 * member it is connected to instead, exchanged on another member for a key
 * of that member's own. docs/groups.md describes both.
 */
import { randomUUID, verify } from 'node:crypto';
import { deviceAdmitInput, deviceHelloInput, DEVICE_LINK_JOIN, GROUP_TICKET_TTL_MS, PAIRING_ROLES, ungroupedInput } from '@boite/contracts';
import type { DeviceHello, DeviceInvite, Group, GroupTicket, PairingRole, UngroupedData } from '@boite/contracts';
import { invalidParams, messageOf, refused, unauthorized, unavailable } from '../errors.ts';
import type { GroupStore } from '../group.ts';
import { newToken } from '../ids.ts';
import { machineName } from '../paths.ts';
import { principalOf as principalOfRole, type ClientIdentity, type Identity } from '../sessions.ts';
import { ticketAddresses } from './addresses.ts';
import { deviceAdmissionInput, deviceId, deviceKey, deviceSigned, LEGACY_MAX, type DeviceKeyEntry } from './device-keys.ts';
import { clockOf, DEVICE_ENTRIES_MAX, homeOf, liveCores, liveDeviceKeys, liveDevices, reachOf, type DeviceEntry, type Roster } from './roster.ts';
import { encodeTicket, parseTicket, ticketSigningInput } from './ticket.ts';

/** Clocks of two machines may differ by this much before a ticket is refused for its date. */
const CLOCK_SKEW_MS = 60_000;
/** Live devices a group holds at a time. */
export const DEVICES_MAX = 200;

/** How far a device's hello may be dated from this machine's clock. */
const DEVICE_HELLO_SKEW_MS = 2 * 60_000;
/** Device hello nonces remembered at once; past it, hellos are refused until the oldest expire. */
const DEVICE_NONCES_MAX = 20_000;

export class GroupClients {
  /** Device hello nonces seen, until their hello would be refused for its date anyway. In memory: see docs/groups.md, limits. */
  readonly #deviceNonces = new Map<string, number>();

  readonly #group: GroupStore;

  constructor(group: GroupStore) {
    this.#group = group;}

  // -- Devices: one key each, admitted once, let in on every member.

  /** A core in no group starts one named after itself: a device is always a device of a group. */
  async #ensureGroup(): Promise<Roster> {
    if (this.#group.roster === null) await this.#group.create((machineName() || 'Boite').slice(0, 80));
    return this.#group.require();
  }

  /** "Add a device": one admission grant as a link, carrying an invitation a computer's core joins with. */
  async addDevice(): Promise<DeviceInvite> {
    await this.#ensureGroup();
    const grant = this.#group.core.sessions.grant(Date.now(), 'device');
    const { invite } = await this.#group.invite();
    return { url: `${grant.url}#${DEVICE_LINK_JOIN}=${encodeURIComponent(invite)}`, expiresAt: grant.expiresAt };
  }

  /** Writes a device into the roster under this machine's signature; the same key again is the same device. */
  #admitKey(publicKey: string, name: string, role: PairingRole, legacy: string[] = []): DeviceKeyEntry {
    const roster = this.#group.require();
    const id = deviceId(publicKey);
    const known = roster.deviceKeys?.find((entry) => entry.id === id);
    if (known?.removed) throw unauthorized('this device was removed from the group: it needs a new key, which the app makes when it is added again');
    const live = known !== undefined && liveDeviceKeys(roster).includes(known);
    const legacyIds = [...new Set([...(known?.legacy ?? []), ...legacy])].sort();
    if (legacyIds.length > LEGACY_MAX) throw refused('this device key took over too many older pairings: add the device again, which makes it a new key');
    if (live && known!.role === role && JSON.stringify(known!.legacy ?? []) === JSON.stringify(legacyIds)) return known!;
    if (!live && liveDeviceKeys(roster).length >= DEVICES_MAX) throw refused(`a group holds at most ${DEVICES_MAX} devices; revoke one that is no longer used`);
    if (known === undefined && (roster.deviceKeys?.length ?? 0) >= DEVICE_ENTRIES_MAX) {
      throw refused(`this group has listed ${DEVICE_ENTRIES_MAX} devices over its life, revoked ones included, and takes no new one: start a new group`);
    }
    const self = this.#group.selfId();
    const entry: DeviceKeyEntry = {
      id,
      publicKey,
      name: (name.trim() || 'device').slice(0, 100),
      role,
      admit: { by: self, sig: this.#group.core.coordination.signature(deviceAdmissionInput(roster.id, id, role)).toString('base64') },
      at: known?.at ?? Date.now(),
      rev: clockOf(roster) + 1,
      ...(known?.push === undefined ? {} : { push: known.push }),
      ...(legacyIds.length > 0 ? { legacy: legacyIds } : {}),
    };
    this.#group.commit({ ...roster, deviceKeys: [...(roster.deviceKeys ?? []).filter((device) => device.id !== id), entry] });
    return entry;
  }

  /**
   * `hello` with a grant and a device key: the grant is spent here, and the
   * device is in the group from then on. The key is proven held by a signature
   * over the grant itself.
   */
  async admitDevice(grant: string, offer: { publicKey?: unknown; name?: unknown; sig?: unknown }, client: ClientIdentity, nonce: string | null): Promise<{ deviceId: string; sessionId: string; role: PairingRole }> {
    const publicKey = typeof offer.publicKey === 'string' ? offer.publicKey : '';
    if (deviceKey(publicKey) === null) throw invalidParams('device.publicKey: expected a raw Ed25519 key in base64url', { field: 'device.publicKey' });
    if (!deviceSigned(publicKey, deviceAdmitInput(grant, publicKey), offer.sig)) throw unauthorized('device.sig: expected the device\'s signature over the grant it redeems');
    const name = typeof offer.name === 'string' ? offer.name.slice(0, 100) : client.name;
    const id = deviceId(publicKey);
    // Before the grant is spent: a removed key gets a refusal that leaves the link good for the key the app makes next.
    if (this.#group.roster?.deviceKeys?.some((device) => device.id === id && device.removed)) {
      throw unauthorized('this device was removed from the group: it needs a new key, which the app makes when it is added again');
    }
    const role = this.#group.core.sessions.redeem(grant, id, nonce);
    await this.#ensureGroup();
    const entry = this.#admitKey(publicKey, name, role);
    return { deviceId: entry.id, sessionId: this.#deviceSession(entry, client), role: entry.role };
  }

  /**
   * `hello` with a device signature. The device is one this roster lists
   * live; the signature names this machine, is dated within two minutes and
   * its nonce was never seen. The session row it opens is this machine's
   * record of the device: its last visit, its push destination, its sockets.
   */
  authenticateDevice(hello: unknown, client: ClientIdentity, now = Date.now()): { sessionId: string; role: PairingRole; deviceId: string } {
    // Unauthorized says the device is out for good, and the app drops its key on it. A device this machine has not
    // heard of yet, its roster behind the member that admitted it, is told to come back; so is a clock that is off.
    const roster = this.#group.roster;
    const raw = (typeof hello === 'object' && hello !== null ? hello : {}) as Partial<DeviceHello>;
    // Out of every group, removed or gone, it says so under its key: its own word, which the app takes as a `group.get`
    // answering none. Unavailable, not Unauthorized: a group that lets it in again tells it of the device, and the key
    // opens it then. Joining one, it does not know yet, and the device is told to come back.
    if (roster === null && this.#group.joining > 0) throw unavailable('this machine has not heard of this device yet: its group tells it within seconds');
    if (roster === null) throw this.#ungrouped(raw.nonce);
    const known = typeof raw.id === 'string' ? roster.deviceKeys?.find((device) => device.id === raw.id) : undefined;
    if (known === undefined) throw unavailable('this machine has not heard of this device yet: its group tells it within seconds');
    const entry = liveDeviceKeys(roster).find((device) => device === known);
    if (entry === undefined) throw unauthorized('this device was removed from the group');
    if (typeof raw.at !== 'number' || Math.abs(now - raw.at) > DEVICE_HELLO_SKEW_MS) {
      throw refused('the device hello is dated more than two minutes from this machine\'s clock: set the clock of this device or that machine');
    }
    if (typeof raw.nonce !== 'string' || raw.nonce.length < 16 || raw.nonce.length > 64) throw refused('device.nonce: expected 16 to 64 characters');
    if (!deviceSigned(entry.publicKey, deviceHelloInput(this.#group.selfId(), raw.at, raw.nonce), raw.sig)) throw unauthorized('the device hello is not signed by its key for this machine');
    for (const [nonce, until] of this.#deviceNonces) if (until <= now) this.#deviceNonces.delete(nonce);
    const key = `${entry.id}:${raw.nonce}`;
    if (this.#deviceNonces.has(key)) throw refused('this device hello was already used');
    if (this.#deviceNonces.size >= DEVICE_NONCES_MAX) throw unavailable('too many device hellos at once: try again in a minute');
    this.#deviceNonces.set(key, raw.at + DEVICE_HELLO_SKEW_MS * 2);
    return { sessionId: this.#deviceSession(entry, client, now), role: entry.role, deviceId: entry.id };
  }

  /** The refusal that says this machine is in no group, signed over the nonce of the hello it answers. */
  #ungrouped(nonce: unknown): Error {
    if (typeof nonce !== 'string' || nonce.length < 16 || nonce.length > 64) return refused('device.nonce: expected 16 to 64 characters');
    const { coreId, publicKey } = this.#group.core.coordination.card();
    const sig = this.#group.core.coordination.signature(Buffer.from(ungroupedInput(coreId, nonce))).toString('base64');
    return unavailable('this machine belongs to no group', { reason: 'ungrouped', publicKey, sig } satisfies UngroupedData);
  }

  /** This machine's session row for a device key, made on its first visit. Its token is thrown away: the key is what opens it. */
  #deviceSession(entry: DeviceKeyEntry, client: ClientIdentity, now = Date.now()): string {
    const member = `key:${entry.id}`;
    const known = Object.entries(this.#group.sessions).find(([sessionId, held]) => held === member && this.#group.core.journal.getSession(sessionId) !== null);
    if (known !== undefined) {
      this.#group.core.journal.touchSession(known[0], now);
      return known[0];
    }
    const session = this.#group.core.sessions.issue(entry.role, client, now);
    this.#group.sessions[session.id] = member;
    this.#group.saveSessions();
    return session.id;
  }

  /** The device id a session of this machine stands for, when a device key opened it. */
  deviceOf(sessionId: string | null): string | undefined {
    const member = sessionId === null ? undefined : this.#group.sessions[sessionId];
    return member?.startsWith('key:') ? member.slice('key:'.length) : undefined;
  }

  /**
   * A device paired the older way hands over its key: the session it called
   * with is listed as what the key took over, so revoking either revokes both.
   */
  async enrollDevice(identity: Identity, params: { publicKey?: unknown; name?: unknown; at?: unknown; sig?: unknown }): Promise<{ id: string; group: Group }> {
    if (identity.sessionId === null || identity.principal === 'agent') throw refused('group.enrollDevice is for a paired device; this machine\'s own app is the machine itself');
    const row = this.#group.core.journal.getSession(identity.sessionId);
    if (row === null) throw unauthorized('this session was revoked');
    const publicKey = typeof params.publicKey === 'string' ? params.publicKey : '';
    if (deviceKey(publicKey) === null) throw invalidParams('publicKey: expected a raw Ed25519 key in base64url', { field: 'publicKey' });
    const at = typeof params.at === 'number' ? params.at : 0;
    if (Math.abs(Date.now() - at) > DEVICE_HELLO_SKEW_MS || !deviceSigned(publicKey, deviceHelloInput(this.#group.selfId(), at, 'enroll'), params.sig)) {
      throw invalidParams('sig: expected the device\'s signature for this machine, dated now', { field: 'sig' });
    }
    const already = this.#group.sessions[identity.sessionId];
    if (already?.startsWith('key:')) throw refused('this session is already a device key\'s');
    await this.#ensureGroup();
    const legacy = already?.startsWith('device:') ? already.slice('device:'.length) : `${this.#group.selfId()}:${identity.sessionId}`;
    const entry = this.#admitKey(publicKey, typeof params.name === 'string' ? params.name : row.client_name, row.role, [legacy]);
    return { id: entry.id, group: this.#group.view(principalOfRole(row.role), entry.id)! };
  }

  /** This machine's session for a device key, once the device has said hello here. */
  sessionOfDevice(id: string): string | undefined {
    return Object.entries(this.#group.sessions).find(([sessionId, held]) => held === `key:${id}` && this.#group.core.journal.getSession(sessionId) !== null)?.[0];
  }

  /** The member whose page a device installed holds its push subscription: the others send its notifications there. */
  pushHome(deviceIdValue: string): string | undefined {
    return this.#group.roster === null ? undefined : liveDeviceKeys(this.#group.roster).find((device) => device.id === deviceIdValue)?.push;
  }

  /** The device subscribed to notifications on this machine. */
  pushedHere(deviceIdValue: string): void {
    const roster = this.#group.roster;
    const entry = roster === null ? undefined : liveDeviceKeys(roster).find((device) => device.id === deviceIdValue);
    if (roster === null || entry === undefined || entry.push === this.#group.selfId()) return;
    this.#group.commit({ ...roster, deviceKeys: roster.deviceKeys!.map((device) => (device === entry ? { ...entry, push: this.#group.selfId(), rev: clockOf(roster) + 1 } : device)) });
  }

  /** Takes a device out of the group, by its key's id or its older pairing's id. */
  revokeDevice(id: unknown): Group {
    const roster = this.#group.require();
    if (typeof id !== 'string') throw invalidParams('id: expected a device id', { field: 'id' });
    const keyed = roster.deviceKeys?.find((device) => device.id === id && !device.removed);
    if (keyed !== undefined) {
      this.revokeKey(roster, id);
      return this.#group.view('owner')!;
    }
    const legacy = liveDevices(roster).find((device) => device.id === id);
    if (legacy === undefined) throw refused(`${id} is not a device of this group`, { field: 'id' });
    const prefix = `${this.#group.selfId()}:`;
    if (id.startsWith(prefix) && this.#group.core.journal.getSession(id.slice(prefix.length)) !== null) this.#group.core.sessions.revoke(id.slice(prefix.length));
    else this.#group.commit({ ...roster, devices: roster.devices.map((device) => (device === legacy ? { ...device, rev: clockOf(roster) + 1, removed: true as const } : device)) });
    return this.#group.view('owner')!;
  }

  /** The key's removal, and the older pairings it took over, written together. */
  /** Also `group.ts`'s, when a device's own session is revoked. */
  revokeKey(roster: Roster, id: string): void {
    const entry = roster.deviceKeys?.find((device) => device.id === id);
    if (entry === undefined || entry.removed) return;
    const rev = clockOf(roster) + 1;
    const legacy = new Set(entry.legacy ?? []);
    const devices = roster.devices.map((device) => (legacy.has(device.id) && !device.removed ? { ...device, rev, removed: true as const } : device));
    for (const old of legacy) {
      if (!devices.some((device) => device.id === old)) devices.push({ id: old, name: entry.name, role: entry.role, rev, removed: true });
    }
    this.#group.commit({ ...roster, devices, deviceKeys: roster.deviceKeys!.map((device) => (device === entry ? { ...entry, rev, removed: true as const } : device)) });
    // The sessions of its older pairings on this machine go too.
    const prefix = `${this.#group.selfId()}:`;
    for (const old of legacy) {
      const sessionId = old.startsWith(prefix) ? old.slice(prefix.length) : undefined;
      if (sessionId !== undefined && !this.#group.revoking.has(sessionId) && this.#group.core.journal.getSession(sessionId) !== null) {
        try { this.#group.core.sessions.revoke(sessionId); } catch (error) { this.#group.core.log('warn', `group: could not revoke session ${sessionId}: ${messageOf(error)}`); }
      }
    }
  }

  // -- Tickets: one member's word for a client, exchanged on another member.

  #enroll(sessionId: string, name: string, role: PairingRole): string {
    const roster = this.#group.require();
    const id = `${this.#group.selfId()}:${sessionId}`;
    const known = roster.devices.find((device) => device.id === id);
    if (known !== undefined && !known.removed) return id;
    if (known?.removed) throw unauthorized('this device was removed from the group');
    if (liveDevices(roster).length >= DEVICES_MAX) throw refused(`a group holds at most ${DEVICES_MAX} devices; revoke one that is no longer used`);
    if (roster.devices.length >= DEVICE_ENTRIES_MAX) {
      throw refused(`this group has listed ${DEVICE_ENTRIES_MAX} devices over its life, revoked ones included, and takes no new one: start a new group`);
    }
    const entry: DeviceEntry = { id, name: (name || 'device').slice(0, 100), role, rev: clockOf(roster) + 1 };
    this.#group.commit({ ...roster, devices: [...roster.devices, entry] });
    return id;
  }

  ticket(coreId: unknown, identity: Identity, url?: unknown): GroupTicket {
    const roster = this.#group.require();
    const self = this.#group.selfId();
    const target = liveCores(roster).find((core) => core.coreId === coreId);
    if (target === undefined || target.coreId === self) throw refused(`${String(coreId)} is not another machine of this group`, { field: 'coreId' });
    // The ticket is good at one address, and the member checks it still gives that one: a stale roster here vouches for nothing there.
    const usable = ticketAddresses(reachOf(roster, target));
    const at = url === undefined ? usable[0] : usable.find((address) => address === url);
    if (at === undefined) throw refused(`url: expected an address of ${target.name} a key may be sent to, HTTPS when it has one and written as numbers otherwise`, { field: 'url' });
    let sub: string;
    let role: PairingRole;
    if (identity.sessionId === null) {
      if (identity.principal !== 'owner') throw refused('group.ticket is for the owner and paired devices');
      // The shell of this machine, holding its core token: the machine itself vouches.
      sub = `core:${self}`;
      role = 'owner';
    } else {
      const row = this.#group.core.journal.getSession(identity.sessionId);
      if (row === null) throw unauthorized('this session was revoked');
      role = row.role;
      // A client that came in through the group keeps the name it came in under.
      const member = this.#group.sessions[identity.sessionId];
      if (member?.startsWith('key:')) throw refused('a device key says hello on the other machine itself: it needs no ticket');
      sub = member ?? `device:${this.#enroll(identity.sessionId, row.client_name, role)}`;
    }
    const expiresAt = Date.now() + GROUP_TICKET_TTL_MS;
    const ticket = encodeTicket(
      { v: 1, g: roster.id, iss: self, aud: target.coreId, u: at, sub, role, nonce: newToken(), exp: expiresAt },
      (input) => this.#group.core.coordination.signature(input),
    );
    return { ticket, coreId: target.coreId, addresses: this.#group.routes(target.coreId) ?? reachOf(roster, target), url: at, expiresAt };
  }

  /** `hello` with a ticket: checked against the roster, then a session of this core's own, once. */
  admit(text: string, client: ClientIdentity, now = Date.now()): { id: string; token: string; role: PairingRole } {
    const roster = this.#group.roster;
    if (roster === null) throw unauthorized('this machine belongs to no group');
    const { payload, encoded, signature } = parseTicket(text);
    if (payload.g !== roster.id || payload.aud !== this.#group.selfId()) throw unauthorized('the group ticket is for another machine or another group');
    const issuer = liveCores(roster).find((core) => core.coreId === payload.iss);
    if (issuer === undefined || issuer.coreId === this.#group.selfId()) throw unauthorized('the group ticket was issued by a machine that is not in this group');
    if (!verify(null, ticketSigningInput(encoded), issuer.publicKey, signature)) throw unauthorized('the group ticket signature is wrong');
    if (payload.exp <= now - CLOCK_SKEW_MS || payload.exp > now + GROUP_TICKET_TTL_MS + CLOCK_SKEW_MS) {
      throw unauthorized('the group ticket expired, or the clocks of the two machines differ by more than a minute');
    }
    if (!PAIRING_ROLES.includes(payload.role)) throw unauthorized('the group ticket is malformed');
    if (!this.#group.given().includes(payload.u)) throw unauthorized(`the group ticket was made for ${payload.u}, an address this machine does not give, or no longer`);
    if (payload.sub.startsWith('core:')) {
      const member = payload.sub.slice('core:'.length);
      if (payload.role !== 'owner' || !liveCores(roster).some((core) => core.coreId === member)) throw unauthorized('the group ticket names a machine that is not in this group');
    } else if (payload.sub.startsWith('device:')) {
      const id = payload.sub.slice('device:'.length);
      if (!liveCores(roster).some((core) => core.coreId === homeOf(id)) || roster.devices.some((device) => device.id === id && device.removed)) {
        throw unauthorized('this device was removed from the group');
      }
    } else throw unauthorized('the group ticket is malformed');
    const spent = `${payload.iss}:${payload.nonce}`;
    if (this.#group.spent.has(spent)) throw unauthorized('the group ticket was already used');
    // One write: the ticket is spent, the session exists and names who it stands for, or none of the three.
    return this.#group.core.journal.db.transaction(() => {
      this.#group.spent.set(spent, payload.exp + CLOCK_SKEW_MS);
      this.#group.saveSpent();
      const session = this.#group.core.sessions.issue(payload.role, client, now);
      this.#group.sessions[session.id] = payload.sub;
      this.#group.vias[session.id] = payload.u;
      this.#group.saveSessions();
      return session;
    })();
  }
}

/*
 * A group: the machines of one person that trust each other.
 *
 * Until groups, three things were set up one pair at a time: a pairing link per
 * client and per core, the browser origins of every other core, and the agent
 * coordination link between two cores. A group is one roster every member
 * holds, and those three follow from it. A client of one member asks it for a
 * ticket to another, the other checks the ticket against the roster and hands
 * the client a session key of its own; origins and coordination peers are read
 * off the same roster.
 *
 * Membership is symmetric and total: any member may invite, remove and vouch.
 * It suits the machines of one owner and nothing less trusted, which keeps the
 * manual pairing link for everything else. A removal is known to each member
 * when it hears of it: until then that member still treats the removed machine
 * as one of the group, with everything that grants. Once a member has heard, a
 * removed machine comes back only through a new invitation (docs/groups.md).
 *
 * What members say to each other is signed and sealed to the recipient
 * (`group/seal.ts`), whatever network carries it. What a client says to a core
 * is not: that link is as private as its transport, Tailscale, HTTPS, or a
 * LAN the owner chose to listen on, the same as a `ws://` pairing.
 */
import { randomUUID, verify } from 'node:crypto';
import { migrateGroupPeer } from './coordination-group.ts';
import type { KeyObject } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join as joinPath } from 'node:path';
import { GRANT_TTL_MS, GROUP_MAX_CORES, GROUP_TICKET_TTL_MS, PAIRING_ROLES } from '@boite/contracts';
import { deviceAdmitInput, deviceHelloInput, type CoordinationPeer, type DeviceHello, type DeviceInvite, type Group, type GroupDevice, type GroupInvite, type GroupTicket, type PairingRole, type Principal } from '@boite/contracts';
import { boundedBody, PeerGone } from './coordination-wire.ts';
import type { Core } from './core.ts';
import { invalidParams, messageOf, refused, RpcFailure, unauthorized, unavailable } from './errors.ts';
import { advertisedAddresses, probeTailnet, tailnetAddress, ticketAddresses, type Tailnet } from './group/addresses.ts';
import { admissionInput, checkAddress, checkCard, checkRoster, clockOf, CORE_ENTRIES_MAX, DEVICE_ENTRIES_MAX, digestOf, homeOf, liveCores, liveDeviceKeys, liveDevices, memberOrigins, mergeRosters, groupName, homeGone, peerOf, reachOf } from './group/roster.ts';
import { deviceAdmissionInput, deviceId, deviceKey, deviceSigned, SERVED_ORIGINS_MAX, type DeviceKeyEntry } from './group/device-keys.ts';
import type { CoreCard, CoreEntry, DeviceEntry, Roster } from './group/roster.ts';
import { boxPublic, boxSigningInput, newBoxKey, open, pack, readBoxKey, seal, SEALED, sealedName, sealResponse, unpack } from './group/seal.ts';
import type { Sealing } from './group/seal.ts';
import { encodeInvite, encodeTicket, inviteOf, parseInvite, parseTicket, ticketSigningInput, inviteId, invitePsk } from './group/ticket.ts';
import type { Invite } from './group/ticket.ts';
import { DEVICES_MAX, GroupClients } from './group/clients.ts';
import { askToJoin, JOIN_SIGNING_PREFIX, type JoinReply } from './group/join.ts';
import { SyncBackoff } from './group/backoff.ts';
import { newId, newToken } from './ids.ts';
import { currentOs, machineName } from './paths.ts';
import { principalOf as principalOfRole, type ClientIdentity, type Identity } from './sessions.ts';

const SETTING = 'group';
const SESSIONS_SETTING = 'group:sessions';
const VIAS_SETTING = 'group:session-addresses';
const SPENT_SETTING = 'group:spent';
/** Join requests a minute that name a live invitation: each costs a key agreement, and no honest group makes this many. */
const JOINS_PER_MINUTE = 30;
/** Requests one invitation is asked with before it is taken away: a machine joins once, and asks again a few times at most. */
const JOIN_REQUESTS_MAX = 64;
const JOIN_BODY_MAX = 16_384;
/** A member that missed a change is offered it again this often. */
const TICK_MS = 15_000;
/** Every member is asked for its roster this many ticks apart, whatever it acknowledged: five minutes. */
const FULL_SYNC_TICKS = 20;
const NAME_REFRESH_MS = 5 * 60_000;
/** How long a leaving machine waits for the others to hear it before it goes anyway. */
const FAREWELL_MS = 6000;

export type { NetworkSink } from './group/addresses.ts';
export { JOIN_ROUTE } from './group/join.ts';

export class GroupStore {
  roster: Roster | null = null;
  /** Session id here to the member it stands for: `core:<id>` or `device:<id>`. Local, never exchanged. */
  sessions: Record<string, string> = {};
  /** The address each of those sessions was issued for: it lives while this machine still gives it. */
  vias: Record<string, string> = {};
  /** Joins in flight: meanwhile a device of the group it joins is told to come back, not that this machine is in none. */
  joining = 0;
  /** Keyed by `inviteId`: the grant itself is kept nowhere once the invitation is handed out. */
  private readonly invites = new Map<string, { expiresAt: number; joined: string | null; psk: Buffer; seen: Set<string> }>();
  private boxKey: KeyObject | null = null;
  /** Ticket nonces already exchanged, until they would have expired anyway. Kept in the journal: a restart must not make a used ticket good again. */
  readonly spent = new Map<string, number>();
  /** Sessions being revoked right now: their own revocation is not started a second time from inside it. */
  readonly revoking = new Set<string>();
  private joins = { since: 0, count: 0 };
  /** The roster digest each member last agreed on with this core. */
  private readonly acked = new Map<string, string>();
  /** Members that did not answer the last offer: offered the same roster again after one tick, doubling up to the full sync period. */
  readonly backoff = new SyncBackoff(TICK_MS, TICK_MS * FULL_SYNC_TICKS);
  /** The address each member last answered on, tried first the next time. */
  private readonly good = new Map<string, string>();
  private tailnet: Tailnet | null = null;
  private tailnetAt = 0;
  private onTailnet = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticks = 0;
  private ticking = false;
  private closed = false;
  /** The server answers: this machine's addresses can be read off its listeners and interfaces. */
  private live = false;
  private reconciling = false;
  private readonly pending = new Set<Promise<unknown>>();
  /** Origins pages of this machine were served from, newest last: what it publishes beside its addresses. */
  private served: string[] = [];

  /** Phones, browsers and the desktop app of a member: how each gets in (`group/clients.ts`). */
  readonly clients: GroupClients;

  constructor(readonly core: Core) {
    this.clients = new GroupClients(this);
    const stored = core.journal.getSetting(SETTING);
    if (stored !== undefined && stored !== null) {
      try {
        this.roster = checkRoster(stored);
      } catch (error) {
        core.log('error', `the stored group roster is unreadable and was ignored: ${messageOf(error)}`, { source: 'group', event: 'group.roster-unreadable' });
      }
    }
    const sessions = core.journal.getSetting(SESSIONS_SETTING);
    if (typeof sessions === 'object' && sessions !== null && !Array.isArray(sessions)) {
      this.sessions = Object.fromEntries(Object.entries(sessions).filter(([, member]) => typeof member === 'string')) as Record<string, string>;
    }
    const vias = core.journal.getSetting(VIAS_SETTING);
    if (typeof vias === 'object' && vias !== null && !Array.isArray(vias)) {
      this.vias = Object.fromEntries(Object.entries(vias).filter(([, url]) => typeof url === 'string')) as Record<string, string>;
    }
    const spent = core.journal.getSetting(SPENT_SETTING);
    if (typeof spent === 'object' && spent !== null && !Array.isArray(spent)) {
      const now = Date.now();
      for (const [nonce, until] of Object.entries(spent)) if (typeof until === 'number' && until > now) this.spent.set(nonce, until);
    }
  }

  /**
   * Called by the core once this store is in place and before any socket is
   * accepted: a crash between writing a removal and dropping the keys it
   * kills, or between leaving and dropping them, must not leave them good.
   */
  restore(): void {
    this.reconcile();
  }

  /** Called once the server listens: a member publishes where it answers and asks the others what it missed. */
  start(): void {
    if (this.closed) return;
    // Before anything is awaited: from the first hello on, what this machine gives is what it listens on now.
    const ip = tailnetAddress();
    this.tailnet = ip === null ? null : { ip, name: this.tailnet?.ip === ip ? this.tailnet.name : null };
    this.listen(this.roster !== null);
    this.live = true;
    this.reconcile();
    if (this.roster === null) return;
    this.arm();
    this.background(this.refresh().then(() => this.syncPending()));
  }

  selfId(): string {
    return this.core.coordination.card().coreId;
  }

  require(): Roster {
    if (this.roster === null) throw refused('this machine belongs to no group');
    return this.roster;
  }

  view(principal: Principal, device?: string): Group | null {
    const roster = this.roster;
    if (roster === null) return null;
    const devices: GroupDevice[] = [
      ...liveDeviceKeys(roster).map((entry) => ({ id: entry.id, name: entry.name, role: entry.role, by: entry.admit.by, addedAt: entry.at })),
      // A pairing of the older kind whose key has not come over yet.
      ...liveDevices(roster)
        .filter((entry) => !liveDeviceKeys(roster).some((keyed) => keyed.legacy?.includes(entry.id)))
        .map((entry) => ({ id: entry.id, name: entry.name, role: entry.role, by: homeOf(entry.id), legacy: true as const })),
    ];
    return {
      id: roster.id,
      name: roster.name,
      self: this.selfId(),
      cores: liveCores(roster).map((core) => ({ coreId: core.coreId, name: core.name, ...(core.os ? { os: core.os } : {}), addresses: reachOf(roster, core), epoch: core.epoch })),
      // Who else is in the group is the owner's to read; a device sees itself.
      devices: principal === 'owner' ? devices : devices.filter((entry) => entry.id === device),
      ...(device === undefined ? {} : { device }),
      // A home that left the group is no home: the others keep their own settings.
      ...(typeof roster.settingsHome === 'string' && liveCores(roster).some((core) => core.coreId === roster.settingsHome) ? { settingsHome: roster.settingsHome } : {}),
    };
  }
  // -- What the rest of the core reads off the roster.

  /** The other members, as agent coordination addresses them. */
  peers(): CoordinationPeer[] {
    if (this.roster === null) return [];
    const self = this.selfId();
    return liveCores(this.roster).filter((core) => core.coreId !== self).map(peerOf);
  }

  /** A machine this group removed, so its next request can be answered "you were removed" instead of silence. */
  removedPeer(coreId: string | null): CoordinationPeer | null {
    const entry = this.roster?.cores.find((core) => core.coreId === coreId && core.removed);
    return entry === undefined ? null : peerOf(entry);
  }

  /** Every address of a member, the one that last answered first. Null for a core outside the group. */
  routes(coreId: string): string[] | null {
    const entry = this.roster?.cores.find((core) => core.coreId === coreId);
    if (entry === undefined || this.roster === null) return null;
    const all = reachOf(this.roster, entry);
    const good = this.good.get(coreId);
    return good !== undefined && all.includes(good) ? [good, ...all.filter((address) => address !== good)] : all;
  }

  reached(coreId: string, url: string): void {
    if (this.roster?.cores.some((core) => core.coreId === coreId)) this.good.set(coreId, url);
  }

  /**
   * The address a pairing link names for a machine of a group, or null. A phone
   * opens that link and sends its grant there, so it is an address whose
   * transport says who answers: the HTTPS one, else a literal address. Never a
   * name over plain HTTP, which is whatever the phone's resolver says it is.
   */
  ownAddress(): string | null {
    const mine = this.roster?.cores.find((core) => core.coreId === this.selfId());
    const dialable = mine?.addresses.filter((address) => !/^https?:\/\/(127\.0\.0\.1|\[::1\]|localhost)(:|$)/.test(address)) ?? [];
    return dialable.find((address) => address.startsWith('https://'))
      ?? dialable.find((address) => /^http:\/\/(\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:]+\])(:\d+)?$/i.test(address))
      ?? null;
  }

  /** A page served by one member opens its socket on another: the origin is a member's address. */
  allowsOrigin(origin: string): boolean {
    return this.roster !== null && memberOrigins(this.roster).has(origin);
  }

  /**
   * A page of this machine opened its socket from `origin` and said hello:
   * that is where this machine is served, behind a proxy or a name its
   * addresses do not list. The other members accept it from then on.
   */
  servedFrom(raw: string): void {
    // Only an origin the roster itself would read back: one it refused would make the whole roster unreadable.
    let origin: string;
    try { origin = checkAddress(raw); } catch { return; }
    if (this.served.at(-1) === origin) return;
    const roster = this.roster;
    const self = this.selfId();
    const mine = roster?.cores.find((core) => core.coreId === self);
    // An address it already gives says nothing new, and would push a real one out of the few kept.
    if (mine?.addresses.includes(origin)) return;
    this.served = [...this.served.filter((known) => known !== origin), origin].slice(-SERVED_ORIGINS_MAX);
    if (roster === null || this.closed) return;
    const list = this.served.filter((known) => !mine?.addresses.includes(known)).sort();
    const known = roster.origins?.[self];
    if (JSON.stringify(known?.list ?? []) === JSON.stringify(list)) return;
    this.commit({ ...roster, origins: { ...roster.origins, [self]: { rev: clockOf(roster) + 1, list } } });
  }

  /** Who a session handed out through the group stands for (`core:<id>`, `device:<id>`); undefined for a pairing link's. */
  issuedFor(sessionId: string): string | undefined {
    return this.sessions[sessionId];
  }
  // -- Sealing: what this core says to another member, and hears from one.

  /** This machine's X25519 key, made on first use and kept beside its identity key. */
  private box(): { key: KeyObject; box: string } {
    if (this.boxKey === null) {
      const file = joinPath(this.core.dataDir, 'group-box-key.pem');
      if (!existsSync(file)) {
        writeFileSync(file, newBoxKey().export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
      }
      this.boxKey = readBoxKey(readFileSync(file, 'utf8'));
    }
    return { key: this.boxKey, box: boxPublic(this.boxKey) };
  }

  /** This machine's sealing key, public half: what a contact seals its requests to. */
  boxPublic(): string { return this.box().box; }

  /** A signed message sealed to a machine of the roster, or null for a machine outside it. */
  sealFor(coreId: string, plaintext: string): ({ body: string } & Sealing) | null {
    const entry = this.roster?.cores.find((core) => core.coreId === coreId);
    if (entry === undefined) return null;
    const context = { from: this.selfId(), to: coreId };
    return { ...seal(plaintext, entry.box, context), context };
  }

  /** Opens what `from` sealed to this machine. Throws when it does not open. */
  unseal(body: string, from: string): { plaintext: string } & Sealing {
    const context = { from, to: this.selfId() };
    return { ...open(body, this.box().key, context), context };
  }
  // -- This core's own entry.

  private async probe(): Promise<void> {
    const stale = Date.now() - this.tailnetAt >= NAME_REFRESH_MS;
    if (stale) this.tailnetAt = Date.now();
    this.tailnet = await probeTailnet(this.tailnet, stale);
  }

  /** A member answers on its tailnet address, and so does a core a contact dials; any other core opens nothing. */
  private listen(member: boolean): void {
    const wanted = member || this.core.contacts?.wantsTailnet() === true;
    this.onTailnet = this.core.network.also(wanted && this.tailnet !== null ? this.tailnet.ip : null);
  }

  /** Contacts changed: the tailnet listener follows. */
  relisten(): void { if (!this.closed && this.live) this.listen(this.roster !== null); }

  private card(): CoreCard {
    const { coreId, publicKey } = this.core.coordination.card();
    const endpoint = this.core.boundEndpoint();
    const { box } = this.box();
    return {
      coreId,
      name: (machineName() || 'Boite').slice(0, 100),
      publicKey,
      box,
      boxSig: this.core.coordination.signature(boxSigningInput(coreId, box)).toString('base64'),
      addresses: advertisedAddresses({ ...endpoint, tailnet: this.onTailnet, publicUrl: this.core.settings.get().publicUrl }, this.tailnet),
      os: currentOs(),
    };
  }

  /**
   * The addresses a ticket or a group key may name at this moment, read off
   * the interfaces and the settings now: the roster holds what this machine
   * last published, and between a move and the next publication it is behind.
   */
  given(): string[] {
    // Where pages of this machine were served is given too: a proxy in front of it answers there.
    const served = [...new Set([...(this.roster?.origins?.[this.selfId()]?.list ?? []), ...this.served])];
    // Until the server is bound there is nothing to read: what was last published stands.
    if (!this.live) return ticketAddresses([...(this.roster?.cores.find((core) => core.coreId === this.selfId())?.addresses ?? []), ...served]);
    const ip = tailnetAddress();
    const tailnet = ip === null ? null : { ip, name: null };
    const listening = { ...this.core.boundEndpoint(), tailnet: this.onTailnet && ip === this.tailnet?.ip, publicUrl: this.core.settings.get().publicUrl };
    return ticketAddresses([...advertisedAddresses(listening, tailnet), ...served]);
  }

  /** False for a key the group issued for an address this machine no longer gives, revoked on the spot. Any other key is none of the group's. */
  honours(sessionId: string): boolean {
    const member = this.sessions[sessionId];
    if (member === undefined || member.startsWith('key:') || this.given().includes(this.vias[sessionId] ?? '')) return true;
    this.reconcile();
    return false;
  }

  /** This core's word that a machine is in the group for one epoch. */
  private admission(groupId: string, coreId: string, epoch: number): CoreEntry['admit'] {
    return { by: this.selfId(), sig: this.core.coordination.signature(admissionInput(groupId, coreId, epoch)).toString('base64') };
  }

  /** The name or the addresses changed: the entry is this core's to rewrite, one revision up. */
  private publishSelf(): void {
    const roster = this.roster;
    if (roster === null) return;
    const mine = roster.cores.find((core) => core.coreId === this.selfId());
    if (mine === undefined || mine.removed) return;
    // What it says of itself changes; the admission it lives under does not.
    const next: CoreEntry = { ...this.card(), epoch: mine.epoch, admit: mine.admit, rev: mine.rev };
    if (JSON.stringify(next) === JSON.stringify(mine)) return;
    this.commit({ ...roster, cores: roster.cores.map((core) => (core === mine ? { ...next, rev: clockOf(roster) + 1 } : core)) });
  }

  private async refresh(): Promise<void> {
    await this.probe();
    if (this.closed) return;
    this.listen(this.roster !== null);
    this.publishSelf();
  }

  /** The stored settings changed: a public address is one of the addresses this core gives. */
  settingsChanged(): void {
    if (this.roster !== null && !this.closed) this.publishSelf();
  }

  // -- The roster, kept and exchanged.

  commit(next: Roster): void {
    const before = this.roster === null ? null : digestOf(this.roster);
    this.roster = next;
    this.core.journal.setSetting(SETTING, next);
    if (digestOf(next) === before) return;
    this.reconcile();
    this.core.bus.emit('group.updated', {});
    this.kick();
  }

  saveSessions(): void {
    this.core.journal.setSetting(SESSIONS_SETTING, this.sessions);
    this.core.journal.setSetting(VIAS_SETTING, this.vias);
  }

  saveSpent(): void {
    this.core.journal.setSetting(SPENT_SETTING, Object.fromEntries(this.spent));
  }

  /**
   * Keys the group handed out here die with what they stood for: a machine
   * removed, a device revoked on any member, a device whose own machine left.
   * A device this core has not heard of yet is not dead: its ticket can arrive
   * before the roster that lists it.
   */
  private reconcile(): void {
    const roster = this.roster;
    const cores = new Set(roster === null ? [] : liveCores(roster).map((core) => core.coreId));
    const keys = new Set(roster === null ? [] : liveDeviceKeys(roster).map((device) => device.id));
    const dead = (member: string): boolean => {
      if (roster === null) return true;
      if (member.startsWith('core:')) return !cores.has(member.slice('core:'.length));
      if (member.startsWith('key:')) return !keys.has(member.slice('key:'.length));
      const id = member.slice('device:'.length);
      return !cores.has(homeOf(id)) || roster.devices.some((device) => device.id === id && device.removed);
    };
    // A key issued for an address this machine no longer gives is dead too: sent there now, it reaches somebody
    // else. One with no address remembered was issued before addresses were, and goes the same way.
    const given = this.given();
    // A device key's session names no address: what it sends is good on this machine alone, wherever it arrives.
    const retired = (sessionId: string): boolean => !this.sessions[sessionId]?.startsWith('key:') && !given.includes(this.vias[sessionId] ?? '');
    this.reconciling = true;
    try {
      // Group membership replaces standing pairwise trust, which would survive a removal.
      for (const peer of this.core.coordination.peers()) if (cores.has(peer.coreId)) migrateGroupPeer(this.core, peer);
      const gone = Object.entries(this.sessions).filter(([sessionId, member]) => dead(member) || retired(sessionId)).map(([sessionId]) => sessionId);
      // A device paired here and revoked elsewhere loses its own session too.
      if (roster !== null) {
        const prefix = `${this.selfId()}:`;
        for (const device of roster.devices) {
          if (device.removed && device.id.startsWith(prefix)) gone.push(device.id.slice(prefix.length));
        }
      }
      let forgotten = false;
      for (const sessionId of gone) {
        // Its own revocation is under way: that one drops the session, then what it stood for.
        if (this.revoking.has(sessionId)) continue;
        if (this.core.journal.getSession(sessionId) !== null) {
          // What a session stood for is forgotten only once the session is gone: a failure here leaves both, for the next start.
          try { this.core.sessions.revoke(sessionId); } catch (error) {
            this.core.log('warn', `group: could not revoke session ${sessionId}: ${messageOf(error)}`, { source: 'group', event: 'group.revoke-failed' });
            continue;
          }
        }
        if (sessionId in this.sessions) {
          delete this.sessions[sessionId];
          delete this.vias[sessionId];
          forgotten = true;
        }
      }
      if (forgotten) this.saveSessions();
    } finally {
      this.reconciling = false;
    }
  }

  /**
   * `sessions.revoke` is about to take a session away: a device of the group
   * is revoked on every member. The removal is written first, so a crash
   * before the session row goes leaves a removal the next start acts on, never
   * a deleted session whose device the other members still let in.
   */
  sessionRevoking(sessionId: string): void {
    const member = this.sessions[sessionId];
    const roster = this.roster;
    if (this.reconciling || roster === null) return;
    // A machine's own key is no device: taking it away here revokes nothing elsewhere.
    if (member?.startsWith('core:')) return;
    if (member?.startsWith('key:')) {
      this.revoking.add(sessionId);
      try { this.clients.revokeKey(roster, member.slice('key:'.length)); } finally { this.revoking.delete(sessionId); }
      return;
    }
    const deviceId = member === undefined ? `${this.selfId()}:${sessionId}` : member.slice('device:'.length);
    const entry = roster.devices.find((device) => device.id === deviceId);
    if (entry?.removed) return;
    // A session paired here that never asked for a ticket is no device of the group.
    if (entry === undefined && member === undefined) return;
    // A ticket can be exchanged here before the roster that lists its device arrives:
    // the removal is written anyway, and wins over that entry when it comes.
    const removed: DeviceEntry = { id: deviceId, name: entry?.name ?? 'device', role: entry?.role ?? 'device', rev: clockOf(roster) + 1, removed: true };
    this.revoking.add(sessionId);
    try {
      this.commit({ ...roster, devices: [...roster.devices.filter((device) => device.id !== deviceId), removed] });
    } finally {
      this.revoking.delete(sessionId);
    }
  }

  /** The session is gone: what it stood for is forgotten last, so a crash before this leaves something the next start cleans up. */
  sessionRevoked(sessionId: string): void {
    if (this.sessions[sessionId] === undefined) return;
    delete this.sessions[sessionId];
    delete this.vias[sessionId];
    this.saveSessions();
  }

  absorb(theirs: Roster): void {
    const mine = this.roster;
    if (mine === null) return;
    let merged: Roster;
    try {
      // What is kept must be a roster this core, and the others, can read back: bounds and admissions included.
      merged = checkRoster(mergeRosters(mine, theirs));
    } catch (error) {
      this.core.log('error', `group: a roster from a member was not merged, the result would not be a valid roster: ${messageOf(error)}`, { source: 'group', event: 'group.merge-refused' });
      return;
    }
    const self = merged.cores.find((core) => core.coreId === this.selfId());
    if (self === undefined || self.removed) {
      this.disband();
      return;
    }
    this.commit(merged);
    // Another member may hold an older word of this core; its own is the one that counts.
    this.publishSelf();
  }

  /** A member sent its roster: both are merged, and it gets the result back. */
  receive(peer: CoordinationPeer, payload: unknown): { roster: Roster } | { left: true } {
    if (this.roster === null) return { left: true };
    // A machine linked by hand for agent messages is trusted for those, not for the roster.
    if (!liveCores(this.roster).some((core) => core.coreId === peer.coreId)) throw refused('only a machine of this group may send its roster');
    const theirs = checkRoster(payload);
    if (theirs.id !== this.roster.id) throw refused('this machine belongs to another group');
    this.absorb(theirs);
    if (this.roster === null) return { left: true };
    if (digestOf(this.roster) === digestOf(theirs)) this.acked.set(peer.coreId, digestOf(theirs));
    // A restarted member may have pre-admission relay copies even when its roster is current.
    if (liveCores(this.roster).some(core => core.coreId === peer.coreId) && this.core.contacts.list().some(contact => this.core.contacts.members.holdersOf(contact.coreId).includes(peer.coreId))) this.core.contacts.members.mark([peer.coreId]);
    return { roster: this.roster };
  }

  private async syncWith(entry: CoreEntry): Promise<void> {
    const roster = this.roster;
    if (roster === null || this.closed) return;
    // The answer counts only if, when it arrives, this is still the same group and
    // the machine that answers is still one of its members: one removed while its
    // answer was on the way has nothing left to say here.
    const stillMember = (): boolean => this.roster !== null && !this.closed && this.roster.id === roster.id
      && liveCores(this.roster).some((core) => core.coreId === entry.coreId);
    let answer: unknown;
    const since = this.backoff.mark();
    try {
      answer = await this.core.coordination.request(peerOf(entry), 'group.sync', roster);
    } catch (error) {
      // A member says, signed and sealed to this exchange, that this core was removed while it was away.
      if (error instanceof PeerGone && stillMember()) {
        this.core.log('warn', `${entry.name} answered that this machine was removed from the group ${roster.name}`, { source: 'group', event: 'group.removed' });
        this.disband();
      }
      // Anything else is a machine that is off or unreachable: it is asked again later, sooner if the roster changes.
      else if (stillMember()) this.backoff.failed(entry.coreId, digestOf(roster), since);
      return;
    }
    this.backoff.heard(entry.coreId);
    if (!stillMember() || this.roster === null) return;
    const reply = answer as { roster?: unknown; left?: boolean } | null;
    if (reply?.left === true) {
      this.acked.set(entry.coreId, digestOf(this.roster));
      return;
    }
    let theirs: Roster;
    try { theirs = checkRoster(reply?.roster); } catch { return; }
    if (theirs.id !== this.roster.id) return;
    this.absorb(theirs);
    if (this.roster !== null && digestOf(this.roster) === digestOf(theirs)) this.acked.set(entry.coreId, digestOf(theirs));
  }

  /** Every member that has not agreed on the current roster is offered it once, unless it is waiting out a failed offer of that same roster. */
  private async syncPending(): Promise<void> {
    const roster = this.roster;
    if (roster === null || this.closed) return;
    const digest = digestOf(roster);
    const self = this.selfId();
    await Promise.allSettled(liveCores(roster)
      .filter((core) => core.coreId !== self && this.acked.get(core.coreId) !== digest && !this.backoff.waiting(core.coreId, digest))
      .map((core) => this.backoff.offer(core.coreId, digest, () => this.syncWith(core))));
  }

  private kick(): void {
    queueMicrotask(() => {
      if (!this.closed) this.background(this.syncPending());
    });
  }

  private background(work: Promise<unknown>): void {
    const job = work.catch((error: unknown) => {
      if (!this.closed) this.core.log('warn', `group: ${messageOf(error)}`, { source: 'group', event: 'group.contact-failed' });
    });
    this.pending.add(job);
    void job.finally(() => this.pending.delete(job));
  }

  private arm(): void {
    if (this.timer !== null || this.closed) return;
    this.timer = setInterval(() => { this.background(this.tick()); }, TICK_MS);
    this.timer.unref?.();
  }

  private disarm(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.closed || this.ticking || this.roster === null) return;
    this.ticking = true;
    try {
      const now = Date.now();
      for (const [grant, invite] of this.invites) if (invite.expiresAt <= now) this.invites.delete(grant);
      let swept = false;
      for (const [nonce, until] of this.spent) if (until <= now) swept = this.spent.delete(nonce) || swept;
      if (swept) this.saveSpent();
      await this.refresh();
      this.ticks += 1;
      if (this.ticks % FULL_SYNC_TICKS === 0) this.acked.clear();
      await this.syncPending();
    } finally {
      this.ticking = false;
    }
  }

  private adopt(roster: Roster): void {
    this.roster = roster;
    this.core.journal.setSetting(SETTING, roster);
    this.acked.clear();
    // A roster taken whole can carry removals this machine never acted on: a device revoked while it was out of the group.
    this.reconcile();
    this.arm();
    this.core.bus.emit('group.updated', {});
  }

  private disband(): void {
    this.roster = null;
    this.core.journal.deleteSetting(SETTING);
    this.acked.clear();
    this.backoff.clear();
    this.good.clear();
    this.invites.clear();
    this.reconcile();
    this.disarm();
    this.listen(false);
    this.core.bus.emit('group.updated', {});
  }

  // -- What the owner does.

  async create(name: unknown): Promise<Group> {
    const checked = groupName(name);
    const refusal = () => refused(`this machine already belongs to the group ${this.roster?.name}; leave it before starting another`);
    if (this.roster !== null) throw refusal();
    await this.probe();
    if (this.roster !== null) throw refusal();
    this.listen(true);
    const id = newId('grp_');
    const self = this.selfId();
    // The one machine that admits itself: the group starts with it.
    this.adopt({ id, name: checked, founder: self, cores: [{ ...this.card(), epoch: 1, admit: this.admission(id, self, 1), rev: 1 }], devices: [] });
    return this.view('owner')!;
  }

  async invite(): Promise<GroupInvite> {
    this.require();
    await this.refresh();
    const roster = this.require();
    const self = roster.cores.find((core) => core.coreId === this.selfId())!;
    const now = Date.now();
    for (const [grant, invite] of this.invites) if (invite.expiresAt <= now) this.invites.delete(grant);
    const grant = newToken();
    const expiresAt = now + GRANT_TTL_MS;
    this.invites.set(inviteId(grant), { expiresAt, joined: null, psk: invitePsk(grant), seen: new Set() });
    return { invite: encodeInvite({ g: roster.id, n: roster.name, c: self.coreId, a: self.addresses, x: self.box, t: grant }), expiresAt };
  }
  rename(name: unknown): Group {
    const checked = groupName(name);
    const roster = this.require();
    if (roster.name !== checked) {
      if ((roster.nameRev ?? 0) >= Number.MAX_SAFE_INTEGER) throw refused('name: the group name revision has reached its limit', { field: 'name' });
      this.commit({ ...roster, name: checked, nameRev: (roster.nameRev ?? 0) + 1 });
    }
    return this.view('owner')!;
  }

  /** The member every other one copies its settings from, or null for none. The copy is the clients' to make. */
  settingsHome(coreId: unknown): Group {
    const roster = this.require();
    if (coreId !== null && (typeof coreId !== 'string' || !liveCores(roster).some((core) => core.coreId === coreId))) {
      throw invalidParams('coreId: expected the id of a machine of this group, or null', { field: 'coreId' });
    }
    if ((roster.settingsHome ?? null) !== coreId) {
      const rev = roster.settingsHomeRev ?? 0;
      if (rev >= Number.MAX_SAFE_INTEGER) throw refused('coreId: the settings home revision has reached its limit', { field: 'coreId' });
      this.commit({ ...roster, settingsHome: coreId, settingsHomeRev: rev + 1 });
    }
    return this.view('owner')!;
  }

  /** This core calls the member the invitation names, proves it holds its own key, and takes the roster back. */
  async join(text: unknown): Promise<Group> {
    this.joining++;
    try { return await this.enter(text); } finally { this.joining--; }
  }

  private async enter(text: unknown): Promise<Group> {
    const refusal = () => refused(`this machine already belongs to the group ${this.roster?.name}; leave it before joining another`);
    // A group of this machine alone, the one its devices brought, gives way: its devices come along.
    const alone = (): boolean => this.roster === null || liveCores(this.roster).every((core) => core.coreId === this.selfId());
    if (!alone()) throw refusal();
    const invite = parseInvite(typeof text === 'string' ? inviteOf(text) : text);
    await this.probe();
    if (!alone()) throw refusal();
    const previous = this.roster;
    if (previous?.id === invite.g) throw refusal();
    if (invite.c === this.selfId()) throw refused('this invitation was made on this machine; paste it on the machine that joins', { field: 'invite' });
    this.listen(true);
    try {
      const nonce = randomUUID();
      const context = { from: this.selfId(), to: invite.c };
      // The grant is not in the request: it is the key the request is sealed with.
      const body = JSON.stringify({ v: 1, group: invite.g, nonce, core: this.card() });
      const signature = this.core.coordination.signature(Buffer.from(JOIN_SIGNING_PREFIX + body)).toString('base64');
      const sealed = { ...seal(pack(body, signature), invite.x, context, invitePsk(invite.t)), context };
      let reply: JoinReply;
      try {
        reply = await Promise.any(invite.a.map((url) => askToJoin(url, invite, sealed, nonce)));
      } catch {
        throw refused(`no machine accepted the invitation at ${invite.a.join(', ')}: it is off or unreachable from here, or the invitation expired, was already used or was made by another machine`, { field: 'invite' });
      }
      if (reply.error !== undefined) throw refused(reply.error, { field: 'invite' });
      const roster = checkRoster(reply.roster);
      const live = liveCores(roster);
      if (roster.id !== invite.g || !live.some((core) => core.coreId === this.selfId()) || !live.some((core) => core.coreId === invite.c)) {
        throw refused('the machine that answered sent a roster that is not this invitation\'s group', { field: 'invite' });
      }
      // Still alone in the group it was in: a change of its own entry meanwhile, a served origin say, is no company.
      const current = this.roster as Roster | null;
      if (!alone() || (current?.id ?? null) !== (previous?.id ?? null)) throw refusal();
      // The devices of the group it was alone in come into this one under this machine's word, in the same
      // write: adopted first, their sessions here would be taken for keys of a group this machine left.
      // Within the new group's bounds: past them its roster would be refused by every member.
      const rev = clockOf(roster) + 1;
      const known = new Set((roster.deviceKeys ?? []).map((device) => device.id));
      const room = Math.max(0, Math.min(DEVICES_MAX - liveDeviceKeys(roster).length, DEVICE_ENTRIES_MAX - (roster.deviceKeys?.length ?? 0)));
      const carried = (current === null ? [] : liveDeviceKeys(current)).filter((device) => !known.has(device.id)).slice(0, room).map((device): DeviceKeyEntry => ({
        ...device,
        admit: { by: this.selfId(), sig: this.core.coordination.signature(deviceAdmissionInput(roster.id, device.id, device.role)).toString('base64') },
        rev,
      }));
      this.adopt(carried.length === 0 ? roster : { ...roster, deviceKeys: [...(roster.deviceKeys ?? []), ...carried] });
    } finally {
      if (this.roster === null) this.listen(false);
    }
    this.publishSelf();
    this.kick();
    return this.view('owner')!;
  }

  /**
   * The other end of `join`, on the member that minted the invitation. The
   * caller is in no roster yet. Its request names an invitation and is sealed
   * with that invitation's grant: a caller that does not hold it gets no
   * answer worth reading, and nothing is computed for one that names none.
   */
  async http(request: Request): Promise<Response> {
    if (this.closed || this.core.policy.networkOff('groups') || request.method !== 'POST' || request.headers.has('origin')) return new Response('forbidden', { status: 403 });
    if (this.roster === null) return new Response('this machine belongs to no group', { status: 404 });
    const from = request.headers.get('x-boite-peer') ?? '';
    const named = request.headers.get('x-boite-invite') ?? '';
    const invite = this.invites.get(named);
    const unknown = (): Response => new Response('unknown or expired invitation', { status: 403 });
    // Spent: expired, replaced, or used by a machine that was since removed. Asked again it costs nothing and counts as a refusal.
    const spent = (): boolean => this.roster === null || invite === undefined || this.invites.get(named) !== invite || invite.expiresAt <= Date.now()
      || (invite.joined !== null && !liveCores(this.roster).some((core) => core.coreId === invite.joined));
    if (invite === undefined || spent() || request.headers.get('x-boite-signature') !== SEALED || !/^[0-9a-f]{64}$/.test(from)) return unknown();
    const context = { from, to: this.selfId() };
    let opened: { plaintext: string; responseKey: Buffer };
    let name: string;
    try {
      const raw = await boundedBody(request.body, JOIN_BODY_MAX);
      // The body may have taken its time: asked again before anything is opened or counted.
      if (this.core.policy.networkOff('groups')) return new Response('forbidden', { status: 403 });
      if (spent()) return unknown();
      // A request recorded on the path and sent again, respaced or not, is refused before anything is
      // computed for it: its sender holds no invitation, and what it replays must not spend the allowance below.
      name = sealedName(raw);
      if (invite.seen.has(name)) return new Response('this join request was already received', { status: 403 });
      opened = open(raw, this.box().key, context, invite.psk);
      // Who asks is proven before anything is counted: an invitation already used is good for the machine it admitted, and for no other holder.
      const { body, signature } = unpack(opened.plaintext);
      const card = checkCard((JSON.parse(body) as { core?: unknown }).core);
      const signed = card.coreId === from && verify(null, Buffer.from(JOIN_SIGNING_PREFIX + body), card.publicKey, Buffer.from(signature, 'base64'));
      if (!signed || (invite.joined !== null && invite.joined !== from)) return unknown();
    } catch {
      return unknown();
    }
    // Counted once it opened and proved who sent it, so only a holder of the invitation spends the
    // allowance: naming an invitation is no proof of holding it, and its name travels readable.
    // Remembered before it is counted, so one turned away for the allowance cannot come back, recorded, to
    // spend a later minute's. An invitation asked this many times is spent.
    invite.seen.add(name);
    if (invite.seen.size > JOIN_REQUESTS_MAX) this.invites.delete(named);
    const now = Date.now();
    if (now - this.joins.since > 60_000) this.joins = { since: now, count: 0 };
    this.joins.count += 1;
    if (this.joins.count > JOINS_PER_MINUTE) return new Response('too many join requests', { status: 429 });
    if (this.closed || this.core.stopping) return new Response('the core is stopping', { status: 503 });
    return this.core.router.trackRequest(() => {
      let nonce = '';
      let roster: Roster | undefined;
      let error: string | undefined;
      try {
        const { body, signature } = unpack(opened.plaintext);
        const parsed = JSON.parse(body) as { group?: unknown; nonce?: unknown; core?: unknown };
        if (typeof parsed !== 'object' || parsed === null || typeof parsed.nonce !== 'string' || parsed.nonce.length > 100) throw invalidParams('nonce: expected up to 100 characters');
        nonce = parsed.nonce;
        roster = this.admitCore(invite, parsed, body, signature, from);
      } catch (reason) {
        error = reason instanceof RpcFailure ? reason.message : 'the machine could not process the invitation';
        if (!(reason instanceof RpcFailure)) this.core.log('warn', `group join failed: ${messageOf(reason)}`, { source: 'group', event: 'group.join-failed' });
      }
      const answer = JSON.stringify({ nonce, publicKey: this.core.coordination.card().publicKey, roster, error } satisfies JoinReply);
      const signature = this.core.coordination.signature(Buffer.from(JOIN_SIGNING_PREFIX + answer)).toString('base64');
      return new Response(sealResponse(pack(answer, signature), opened.responseKey, context), {
        status: error === undefined ? 200 : 400,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-boite-signature': SEALED },
      });
    });
  }

  private admitCore(invite: { joined: string | null }, parsed: { group?: unknown; core?: unknown }, body: string, signature: string, from: string): Roster {
    const roster = this.require();
    if (parsed.group !== roster.id) throw refused('the invitation is for another group');
    const card = checkCard(parsed.core);
    if (card.coreId !== from) throw refused('the join request names another machine than the one that sealed it');
    if (!verify(null, Buffer.from(JOIN_SIGNING_PREFIX + body), card.publicKey, Buffer.from(signature, 'base64'))) {
      throw refused('the join request is not signed by the key it announces');
    }
    if (card.coreId === this.selfId()) throw refused('this invitation was made on this machine; paste it on the machine that joins');
    const known = roster.cores.find((core) => core.coreId === card.coreId);
    if (invite.joined !== null) {
      if (invite.joined !== card.coreId) throw refused('the invitation was already used by another machine');
      // A lost answer is asked for again: the same machine gets the same welcome, and nothing is written.
      // Once that machine was removed the invitation is spent for it too: coming back takes a new one.
      if (known === undefined || known.removed) throw refused('the invitation was already used, and the machine it admitted has since been removed: ask for a new one');
      return roster;
    }
    if ((known === undefined || known.removed) && liveCores(roster).length >= GROUP_MAX_CORES) {
      throw refused(`a group holds at most ${GROUP_MAX_CORES} machines`);
    }
    if (known === undefined && roster.cores.length >= CORE_ENTRIES_MAX) {
      throw refused(`this group has listed ${CORE_ENTRIES_MAX} machines over its life, removed ones included, and takes no new one: start a new group`);
    }
    invite.joined = card.coreId;
    // A new epoch, signed by this member: the only way a machine enters, or comes back after a removal.
    const epoch = (known?.epoch ?? 0) + 1;
    const entry: CoreEntry = { ...card, epoch, admit: this.admission(roster.id, card.coreId, epoch), rev: clockOf(roster) + 1 };
    this.commit({ ...roster, cores: [...roster.cores.filter((core) => core.coreId !== card.coreId), entry] });
    return this.require();
  }

  /** The others are told while this core is still a member they listen to, then it forgets the group. */
  async leave(): Promise<{ ok: true }> {
    const roster = this.require();
    const self = this.selfId();
    const farewell: Roster = { ...roster, ...homeGone(roster, self), cores: roster.cores.map((core) => (core.coreId === self ? { ...core, rev: clockOf(roster) + 1, removed: true as const } : core)) };
    const told = Promise.allSettled(liveCores(roster)
      .filter((core) => core.coreId !== self)
      .map((core) => this.core.coordination.request(peerOf(core), 'group.sync', farewell)));
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([told, new Promise<void>((resolve) => { timer = setTimeout(resolve, FAREWELL_MS); })]);
    clearTimeout(timer);
    if (this.roster !== null) this.disband();
    return { ok: true };
  }

  remove(coreId: unknown): Group {
    const roster = this.require();
    const entry = liveCores(roster).find((core) => core.coreId === coreId);
    if (entry === undefined) throw refused(`${String(coreId)} is not a machine of this group`, { field: 'coreId' });
    if (entry.coreId === this.selfId()) throw refused('group.remove names another machine; group.leave takes this one out', { field: 'coreId' });
    const rev = clockOf(roster) + 1;
    // The devices that machine let in stay: this one signs for them now, so taking an old computer out keeps the phone added through it.
    const deviceKeys = roster.deviceKeys?.map((device) => (device.removed || device.admit.by !== entry.coreId ? device
      : { ...device, admit: { by: this.selfId(), sig: this.core.coordination.signature(deviceAdmissionInput(roster.id, device.id, device.role)).toString('base64') }, rev }));
    this.commit({ ...roster, ...homeGone(roster, entry.coreId), cores: roster.cores.map((core) => (core === entry ? { ...core, rev, removed: true as const } : core)), ...(deviceKeys === undefined ? {} : { deviceKeys }) });
    // The removed machine hears it from a member it still listens to, and leaves on its own.
    this.background(this.core.coordination.request(peerOf(entry), 'group.sync', this.require()).catch(() => undefined));
    return this.view('owner')!;
  }

  beginClose(): void {
    this.closed = true;
    this.disarm();
  }

  async close(): Promise<void> {
    this.beginClose();
    await Promise.allSettled([...this.pending]);
  }
}

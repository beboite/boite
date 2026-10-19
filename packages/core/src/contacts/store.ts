/*
 * Contacts: other owners' Boites, linked so their agents and this core's work
 * together on the projects each side opens to the other, and on nothing else.
 *
 * The inviting core (`host`) shares its machine through Tailscale and hands
 * out a one-time link. The invitee (`guest`) spends it on the host's join
 * route, each side keeps the other's signing and sealing keys, and the guest
 * keeps a WebSocket open to the host: a shared machine answers connections
 * but opens none, so the host's requests to the guest go down that link as a
 * coordination bridge route. Every request between contacts is signed and
 * sealed (`group/seal.ts`), whichever way it travels.
 *
 * What a contact reaches is decided here, on the core that answers: the
 * threads of the projects opened to it, each with its own coordination
 * settings, and a thread that wrote to it in the last 7 days.
 */
import { randomUUID, verify } from 'node:crypto';
import type { AgentContact, Contact, ContactGrant, ContactInvite, ContactOffer, ContactRequest, ContactSettings, ContactsState, ContactTailscale, CoordinationBridgeResponse, CoordinationPeer, ModelTier, RpcEvents, RpcParams, RpcResult } from '@boite/contracts';
import { text } from '../coordination-letter.ts';
import type { BridgeRoute } from '../coordination-bridge.ts';
import { PeerRefusal } from '../coordination-wire.ts';
import type { Core } from '../core.ts';
import { invalidParams, messageOf, refused, RpcFailure, unavailable } from '../errors.ts';
import { magicName, tailnetAddress } from '../group/addresses.ts';
import { SyncBackoff } from '../group/backoff.ts';
import { seal, type Sealing } from '../group/seal.ts';
import { newId, newToken } from '../ids.ts';
import { Concierge } from './concierge.ts';
import { checkNormalizedRemote, gitRemoteOf } from './git-remote.ts';
import { encodeInvite, INVITE_TTL_MS, tokenHash, type ContactCard } from './invite.ts';
import { joinContact, joinRequest } from './join.ts';
import { evaluatePolicy, TailscaleClient } from './tailscale.ts';
import { attestedTier, checkTier, modelTier, tierAllowed } from './tier.ts';
import { fingerprintWords } from './words.ts';

export { CONTACT_JOIN_ROUTE } from './join.ts';
export const CONTACT_LINK_ROUTE = '/coordination/contact/link';

const CONTACTS = 'contacts';
const SETTINGS = 'contacts:settings';
const REQUESTS = 'contacts:requests';
const INVITES = 'contacts:invites';
const RECENT = 'contacts:recent';
const MAX_CONTACTS = 32;
const MAX_INVITES = 16;
/** Requests waiting at once, per contact and direction. */
const MAX_PENDING = 32;
const DECIDED_KEPT = 50;
/** How long a thread that wrote to a contact may hear back from it, outside the projects opened to it. */
export const REPLY_WINDOW_MS = 7 * 24 * 3_600_000;
const SKEW_MS = 60_000;
const HELLO_INPUT = 'boite-contact-hello\n';
const TICK_MS = 1000;
/** Every this many ticks, what waits to be told to a contact is offered again. */
const FLUSH_TICKS = 30;
const TAILSCALE_CACHE_MS = 60_000;

/** A contact as this core keeps it: the public fields, its keys, and whether its offers are behind. */
interface StoredContact extends Omit<Contact, 'link'> {
  publicKey: string;
  box: string;
  /** Bumped by every grant change; cleared once the contact heard this one. */
  syncPending?: number;
}
/**
 * `pendingSend`: an outgoing ask, or the answer to an incoming one, the other side has not received yet.
 * `remoteId`: an incoming request's id on the asking core, for its retries and the answer; `id` is always this core's own.
 */
type StoredRequest = ContactRequest & { pendingSend?: true; remoteId?: string };
type Frame = { t: 'req'; id: string; body: string; signature: string } | { t: 'res'; id: string; status: number; body: string; signature: string };
/** What the server keeps on a contact's link socket. */
export interface ContactSocketData { contact: { coreId: string; routeId: string } }
/** What a contact reads when the concierge refuses: never the model's own words. */
const CONCIERGE_REFUSAL = 'Nothing on this Boite fits this request.';

interface LinkSocket { send(data: string): unknown; close(code?: number, reason?: string): void }

export class ContactStore {
  readonly tailscale: TailscaleClient;
  readonly concierge: Concierge;
  readonly maxContacts = MAX_CONTACTS;
  /** The origin an invitation gives: this machine's tailnet name. Tests point it at loopback. */
  selfUrl: () => Promise<string> = () => this.tailnetUrl();
  /** Guest side: the link this core keeps to each host. */
  private readonly dialed = new Map<string, { socket: WebSocket; state: 'connecting' | 'connected' }>();
  /** Host side: the link each guest keeps to this core, by the guest's id. */
  private readonly hosted = new Map<string, { routeId: string; socket: LinkSocket }>();
  /** Join and hello nonces already used, until they would be stale anyway. */
  private readonly nonces = new Map<string, number>();
  private readonly backoff = new SyncBackoff(TICK_MS, 60_000);
  private readonly flushing = new Set<string>();
  private readonly deciding = new Set<string>();
  private readonly pending = new Set<Promise<unknown>>();
  /** Cores this one is joining right now: each holds a contact slot until its join ends. */
  private readonly joining = new Set<string>();
  private peerCache: CoordinationPeer[] | null = null;
  private tailscaleCache: { at: number; value: ContactTailscale } | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** What `wantsTailnet` last told the group's listener. */
  private listening: boolean | null = null;
  private ticks = 0;
  private started = false;
  private closed = false;

  constructor(private readonly core: Core) {
    this.tailscale = new TailscaleClient(core.dataDir);
    this.concierge = new Concierge(core);
  }

  // -- Storage.

  list(): StoredContact[] { return (this.core.journal.getSetting(CONTACTS) as StoredContact[] | undefined) ?? []; }
  find(coreId: string | null | undefined): StoredContact | undefined { return coreId ? this.list().find(contact => contact.coreId === coreId) : undefined; }
  has(coreId: string | null | undefined): boolean { return this.find(coreId) !== undefined; }
  /**
   * Cores that hold a slot: stored contacts and outgoing joins, each counted
   * once since a reciprocal join can store a core it is still joining, and
   * without the slot `coreId` would fill itself.
   */
  occupied(coreId?: string): number {
    const held = new Set(this.list().map(contact => contact.coreId));
    for (const id of this.joining) if (id !== coreId) held.add(id);
    return held.size;
  }

  /** Holds a slot for an outgoing join, so joins in flight never exceed the cap together; the caller releases it. */
  reserve(coreId: string): () => void {
    if (this.joining.has(coreId)) throw refused('link: this core is already joining that contact');
    if (this.occupied() >= this.maxContacts) throw refused(`at most ${this.maxContacts} contacts; remove one first`);
    this.joining.add(coreId);
    return () => { this.joining.delete(coreId); };
  }

  private save(contacts: StoredContact[]): void {
    this.core.journal.setSetting(CONTACTS, contacts);
    this.peerCache = null;
    this.changed();
  }

  private mutate(coreId: string, change: (contact: StoredContact) => void): StoredContact {
    const contacts = this.list();
    const contact = contacts.find(entry => entry.coreId === coreId);
    if (!contact) throw invalidParams('coreId: expected the core id of one of this core\'s contacts', { field: 'coreId' });
    change(contact);
    this.save(contacts);
    return contact;
  }

  private requests(): StoredRequest[] { return (this.core.journal.getSetting(REQUESTS) as StoredRequest[] | undefined) ?? []; }

  /** Every pending request and what is still to send, then the last decided ones. */
  private saveRequests(requests: StoredRequest[]): void {
    const kept = requests.filter(request => request.status === 'pending' || request.pendingSend);
    const decided = requests.filter(request => request.status !== 'pending' && !request.pendingSend)
      .sort((a, b) => (b.decidedAt ?? b.createdAt) - (a.decidedAt ?? a.createdAt)).slice(0, DECIDED_KEPT);
    this.core.journal.setSetting(REQUESTS, [...kept, ...decided]);
  }

  settings(): ContactSettings {
    const saved = this.core.journal.getSetting(SETTINGS) as Partial<ContactSettings> | undefined;
    return { minTier: saved?.minTier === 2 || saved?.minTier === 3 ? saved.minTier : 1 };
  }

  private changed(): void { this.core.bus.emit('contacts.updated', {}); }

  private background(job: Promise<unknown>): void {
    this.pending.add(job);
    void job.catch(error => { if (!this.closed) this.core.log('warn', `contacts: ${messageOf(error)}`, { source: 'contacts' }); }).finally(() => this.pending.delete(job));
  }

  // -- What other parts of the core ask.

  /** Contacts as coordination peers: a host is reached through the link its guest keeps, a guest dials its host's URL. */
  peers(): CoordinationPeer[] {
    this.peerCache ??= this.list().map(contact => ({
      coreId: contact.coreId, name: contact.name, url: contact.url ?? '', publicKey: contact.publicKey, readThreads: false, viaClient: contact.role === 'host',
    }));
    return this.peerCache;
  }

  /** A signed message sealed to a contact, or null for a core that is not one. */
  sealFor(coreId: string, plaintext: string): ({ body: string } & Sealing) | null {
    const contact = this.find(coreId);
    if (!contact) return null;
    const context = { from: this.core.coordination.card().coreId, to: coreId };
    return { ...seal(plaintext, contact.box, context), context };
  }

  /** The host side keeps no URL: it reaches a guest only while the guest's link is open. */
  linked(coreId: string): boolean {
    const contact = this.find(coreId);
    return contact?.role === 'guest' || this.hosted.has(coreId);
  }

  /** Listens on the tailnet while a contact may dial in: one is linked as guest, or an invitation is out. */
  wantsTailnet(): boolean {
    return this.list().some(contact => contact.role === 'host') || this.liveInvites().length > 0;
  }

  private grantFor(coreId: string, threadId: string): ContactGrant | undefined {
    const projectId = this.core.journal.getThread(threadId)?.projectId;
    return projectId ? this.find(coreId)?.grants.find(grant => grant.projectId === projectId) : undefined;
  }

  /** Projects opened to this contact. */
  granted(coreId: string): string[] { return this.find(coreId)?.grants.map(grant => grant.projectId) ?? []; }

  /** A contact's letter may reach this thread: its project is opened to the contact, or the thread wrote to it lately. */
  mayReach(coreId: string, threadId: string): boolean {
    const thread = this.core.journal.getThread(threadId);
    if (!thread || thread.archived || !this.has(coreId)) return false;
    if (this.grantFor(coreId, threadId)) return true;
    const at = this.recent()[threadId]?.[coreId];
    return typeof at === 'number' && Date.now() - at <= REPLY_WINDOW_MS;
  }

  mayRead(coreId: string, threadId: string): boolean { return this.grantFor(coreId, threadId)?.readThreads === true; }

  private recent(): Record<string, Record<string, number>> { return (this.core.journal.getSetting(RECENT) as Record<string, Record<string, number>> | undefined) ?? {}; }

  /** This thread wrote to a contact: it may hear back for 7 days. */
  noteSent(threadId: string, coreId: string): void {
    const now = Date.now();
    const recent = this.recent();
    for (const [thread, contacts] of Object.entries(recent)) {
      for (const [id, at] of Object.entries(contacts)) if (now - at > REPLY_WINDOW_MS || !this.has(id)) delete contacts[id];
      if (Object.keys(contacts).length === 0) delete recent[thread];
    }
    recent[threadId] = { ...recent[threadId], [coreId]: now };
    this.core.journal.setSetting(RECENT, recent);
  }

  /** The threads `which` names no longer hear back from this contact. */
  private forgetReplies(coreId: string, which: (threadId: string) => boolean): void {
    const recent = this.recent();
    let changed = false;
    for (const [thread, contacts] of Object.entries(recent)) {
      if (!(coreId in contacts) || !which(thread)) continue;
      delete contacts[coreId];
      if (Object.keys(contacts).length === 0) delete recent[thread];
      changed = true;
    }
    if (changed) this.core.journal.setSetting(RECENT, recent);
  }

  /** Refused when this thread's model is below the tier the owner set for contact traffic. */
  checkSendTier(threadId: string): void {
    const thread = this.core.threads.require(threadId);
    const tier = modelTier(thread.providerId, thread.model);
    const { minTier } = this.settings();
    if (!tierAllowed(tier, minTier)) {
      throw refused(`threadId: this thread runs ${thread.providerId} ${thread.model ?? '(default model)'}, tier ${tier}; contacts take tier ${minTier} or better, set in Contacts`, { field: 'threadId', expected: `a thread on a model of tier ${minTier} or better` });
    }
  }

  /** Refused when the model a contact's core attests for its agent is below this owner's tier. */
  checkAttestedTier(agent: string | undefined): void {
    const tier = attestedTier(agent);
    const { minTier } = this.settings();
    if (!tierAllowed(tier, minTier)) throw refused(`from.agent: ${agent ?? 'an unknown model'} is tier ${tier}; this owner takes tier ${minTier} or better from contacts`);
  }

  private linkState(contact: StoredContact): Contact['link'] {
    if (contact.role === 'host') return this.hosted.has(contact.coreId) ? 'connected' : 'offline';
    return this.dialed.get(contact.coreId)?.state ?? (this.started && !this.closed ? 'connecting' : 'offline');
  }

  view(contact: StoredContact): Contact {
    const { publicKey: _key, box: _box, syncPending: _sync, ...shown } = contact;
    return { ...shown, link: this.linkState(contact) };
  }

  private requestView(request: StoredRequest): ContactRequest {
    const { pendingSend: _send, remoteId: _remote, ...shown } = request;
    return shown;
  }

  /** A contact by name (any case) or core id; the agent's `boite agents ask` takes either. */
  private named(value: unknown): StoredContact {
    if (typeof value !== 'string' || !value.trim()) throw invalidParams('contact: expected the name or core id of a contact; see boite agents contacts', { field: 'contact' });
    const wanted = value.trim().toLowerCase();
    const contacts = this.list();
    const found = contacts.find(contact => contact.coreId === wanted)
      ?? contacts.filter(contact => contact.name.toLowerCase() === wanted || contact.name.replace(/\s+/g, '-').toLowerCase() === wanted)[0];
    if (!found) throw invalidParams(`contact: ${value} is not one of this core's contacts; see boite agents contacts`, { field: 'contact' });
    return found;
  }

  // -- Owner methods.

  async state(): Promise<ContactsState> {
    const requests = this.requests().map(request => this.requestView(request));
    const pending = requests.filter(request => request.status === 'pending').sort((a, b) => a.createdAt - b.createdAt);
    const decided = requests.filter(request => request.status !== 'pending').sort((a, b) => (b.decidedAt ?? b.createdAt) - (a.decidedAt ?? a.createdAt)).slice(0, DECIDED_KEPT);
    return {
      self: { coreId: this.core.coordination.card().coreId, machine: this.machine() },
      contacts: this.list().map(contact => this.view(contact)),
      requests: [...pending, ...decided],
      settings: this.settings(),
      tailscale: await this.tailscaleState(),
    };
  }

  private machine(): string { return (this.core.info().hostname ?? 'Boite').slice(0, 100); }

  card(): ContactCard {
    const { coreId, publicKey } = this.core.coordination.card();
    return { coreId, publicKey, box: this.core.group.boxPublic(), machine: this.machine() };
  }

  liveInvites(): [string, { expiresAt: number }][] {
    const now = Date.now();
    return Object.entries((this.core.journal.getSetting(INVITES) as Record<string, { expiresAt: number }> | undefined) ?? {}).filter(([, invite]) => invite.expiresAt > now);
  }

  async invite(): Promise<ContactInvite> {
    const room = (): void => {
      if (this.list().length >= MAX_CONTACTS) throw refused(`at most ${MAX_CONTACTS} contacts; remove one first`);
      if (this.liveInvites().length >= MAX_INVITES) throw refused(`at most ${MAX_INVITES} open invitations; wait for one to be used or to expire`);
    };
    room();
    const url = await this.selfUrl();
    const share = await this.share();
    // Read again after the awaits: another invitation may have been made meanwhile.
    room();
    const token = newToken();
    const expiresAt = Date.now() + INVITE_TTL_MS;
    this.core.journal.setSetting(INVITES, Object.fromEntries([...this.liveInvites(), [tokenHash(token), { expiresAt }]]));
    // Dialled from now on: the tailnet listener opens before the link leaves this machine.
    this.relisten();
    this.arm();
    const link = encodeInvite({ ...this.card(), url, token, share: share.status === 'created' ? share.url : null, expiresAt });
    return { link, expiresAt, share };
  }

  /** The Tailscale share of this machine, made with the owner's key, or why the owner shares it by hand. */
  private async share(): Promise<ContactInvite['share']> {
    if (!this.tailscale.hasKey()) return { status: 'manual', reason: 'No Tailscale API key is stored: share this machine with the invitee from the Tailscale admin console.' };
    const ip = tailnetAddress();
    if (ip === null) return { status: 'manual', reason: 'This machine is not on a tailnet.' };
    try {
      const device = await this.tailscale.device(ip);
      return { status: 'created', url: await this.tailscale.createShare(device.id) };
    } catch (error) {
      return { status: 'manual', reason: `The share could not be created (${messageOf(error)}): share this machine from the Tailscale admin console.` };
    }
  }

  private async tailnetUrl(): Promise<string> {
    const { fqdn } = await this.tailscaleState(true);
    if (fqdn === null) throw unavailable('contacts.invite: this machine has no tailnet name; connect it to Tailscale with MagicDNS on');
    return `http://${fqdn}:${this.core.boundEndpoint().port}`;
  }

  async tailscaleState(fresh = false): Promise<ContactTailscale> {
    const now = Date.now();
    if (!fresh && this.tailscaleCache !== null && now - this.tailscaleCache.at < TAILSCALE_CACHE_MS) return this.tailscaleCache.value;
    const apiKey = this.tailscale.hasKey();
    const ip = tailnetAddress();
    let value: ContactTailscale = { fqdn: null, apiKey, policy: 'unknown' };
    if (ip !== null) {
      if (apiKey) {
        try {
          const device = await this.tailscale.device(ip);
          const policy = evaluatePolicy(await this.tailscale.policy(), device, this.core.boundEndpoint().port);
          value = { fqdn: device.name, apiKey, ...policy };
        } catch (error) {
          this.core.log('warn', `contacts: the Tailscale API could not be read: ${messageOf(error)}`, { source: 'contacts' });
        }
      }
      if (value.fqdn === null) value = { ...value, fqdn: await magicName(ip) };
    }
    this.tailscaleCache = { at: now, value };
    return value;
  }

  async setTailscaleKey(key: string | null): Promise<ContactTailscale> {
    if (key !== null && typeof key !== 'string') throw invalidParams('key: expected a Tailscale API key or null', { field: 'key' });
    this.tailscale.setKey(key);
    this.tailscaleCache = null;
    this.changed();
    return this.tailscaleState(true);
  }

  join(link: string): Promise<Contact> { return joinContact(this, this.core, link); }

  /** An invitation's token, spent: false when it was not live. */
  spendInvite(hash: string): boolean {
    const invites = Object.fromEntries(this.liveInvites());
    if (!(hash in invites)) return false;
    delete invites[hash];
    this.core.journal.setSetting(INVITES, invites);
    return true;
  }

  /**
   * Each owner joined the other: one relationship stays, the same on both
   * cores. The smaller core id hosts and the other dials it with `url`.
   */
  reciprocal(coreId: string, url: string | undefined): StoredContact {
    const hosts = this.core.coordination.card().coreId < coreId;
    const before = this.find(coreId)?.role;
    const contact = this.mutate(coreId, entry => {
      if (hosts) { entry.role = 'host'; delete entry.url; } else if (url !== undefined) { entry.role = 'guest'; entry.url = url; }
    });
    if (contact.role !== before) this.unlink(coreId);
    this.relisten();
    return contact;
  }

  /** The card a join brought, stored with the role this core plays for it. */
  store(card: ContactCard, role: 'host' | 'guest', url?: string): StoredContact {
    const contacts = this.list();
    const taken = new Set(contacts.map(contact => contact.name.toLowerCase()));
    let name = card.machine;
    for (let n = 2; taken.has(name.toLowerCase()); n += 1) name = `${card.machine} ${n}`;
    const contact: StoredContact = {
      coreId: card.coreId, name, machine: card.machine, fingerprint: fingerprintWords(this.core.coordination.card().publicKey, card.publicKey),
      role, ...(url === undefined ? {} : { url }), trusted: false, grants: [], offers: [], lastSeenAt: null, addedAt: Date.now(),
      publicKey: card.publicKey, box: card.box,
    };
    this.save([...contacts, contact]);
    return contact;
  }

  update(params: RpcParams<'contacts.update'>): Contact {
    if (params.trusted !== undefined && typeof params.trusted !== 'boolean') throw invalidParams('trusted: expected a boolean', { field: 'trusted' });
    const name = params.name === undefined ? undefined : text(params.name, 'name', 100).trim();
    if (name !== undefined && this.list().some(contact => contact.coreId !== params.coreId && contact.name.toLowerCase() === name.toLowerCase())) {
      throw invalidParams('name: expected a name no other contact has', { field: 'name' });
    }
    const contact = this.mutate(params.coreId, entry => {
      if (name !== undefined) entry.name = name;
      if (params.trusted !== undefined) entry.trusted = params.trusted;
    });
    // Trusted now: what waits is answered without the owner.
    if (params.trusted === true) for (const request of this.requests()) if (request.coreId === contact.coreId && request.direction === 'in' && request.status === 'pending') this.autoDecide(request.id);
    return this.view(contact);
  }

  grant(params: RpcParams<'contacts.grant'>): Contact {
    if (params.readThreads !== undefined && typeof params.readThreads !== 'boolean') throw invalidParams('readThreads: expected a boolean', { field: 'readThreads' });
    const project = typeof params.projectId === 'string' ? this.core.journal.getProject(params.projectId) : null;
    if (!project || project.archived) throw invalidParams('projectId: expected an unarchived project of this core', { field: 'projectId' });
    const contact = this.mutate(params.coreId, entry => {
      const existing = entry.grants.find(grant => grant.projectId === project.id);
      if (existing) existing.readThreads = params.readThreads ?? existing.readThreads;
      else entry.grants.push({ projectId: project.id, readThreads: params.readThreads ?? false, grantedAt: Date.now() });
      entry.syncPending = (entry.syncPending ?? 0) + 1;
    });
    this.flush(contact.coreId);
    return this.view(contact);
  }

  revoke(params: RpcParams<'contacts.revoke'>): Contact {
    if (typeof params.projectId !== 'string') throw invalidParams('projectId: expected a project id', { field: 'projectId' });
    const contact = this.mutate(params.coreId, entry => {
      entry.grants = entry.grants.filter(grant => grant.projectId !== params.projectId);
      entry.syncPending = (entry.syncPending ?? 0) + 1;
    });
    // Its threads stop hearing back from this contact too; only a later letter of theirs opens that again.
    this.forgetReplies(contact.coreId, threadId => this.core.journal.getThread(threadId)?.projectId === params.projectId);
    this.core.coordination.rejectContactLetters(contact.coreId, 'Project closed to this contact');
    this.flush(contact.coreId);
    return this.view(contact);
  }

  remove(coreId: string): { ok: true } {
    const contact = this.find(coreId);
    if (!contact) throw invalidParams('coreId: expected the core id of one of this core\'s contacts', { field: 'coreId' });
    this.unlink(coreId);
    this.save(this.list().filter(entry => entry.coreId !== coreId));
    this.saveRequests(this.requests().filter(request => request.coreId !== coreId));
    this.forgetReplies(coreId, () => true);
    // No longer trusted anywhere: pending letters both ways are rejected and the bridge route is dropped.
    this.core.coordination.untrust(coreId, true);
    this.relisten();
    return { ok: true };
  }

  setSettings(settings: ContactSettings): ContactSettings {
    if (!settings || typeof settings !== 'object') throw invalidParams('settings: expected { minTier }', { field: 'settings' });
    const minTier: ModelTier = checkTier(settings.minTier, 'settings.minTier');
    this.core.journal.setSetting(SETTINGS, { minTier });
    this.changed();
    return { minTier };
  }

  decide(params: RpcParams<'contacts.decide'>): ContactRequest {
    if (typeof params.accept !== 'boolean') throw invalidParams('accept: expected a boolean', { field: 'accept' });
    return this.settle(params.id, params.accept, params.projectId, params.reason, 'owner');
  }

  /** One incoming request decided: a project opened, or refused with the reason the asking agent reads. */
  private settle(id: unknown, accept: boolean, projectId: unknown, reason: unknown, decidedBy: NonNullable<ContactRequest['decidedBy']>): ContactRequest {
    const requests = this.requests();
    const request = requests.find(entry => entry.id === id && entry.direction === 'in');
    if (!request || request.status !== 'pending') throw invalidParams('id: expected a pending request from a contact', { field: 'id' });
    const now = Date.now();
    if (accept) {
      const project = typeof projectId === 'string' ? this.core.journal.getProject(projectId) : null;
      if (!project || project.archived) throw invalidParams('projectId: expected the unarchived project to open', { field: 'projectId' });
      // An existing read grant stays as the owner set it; a new grant never reads conversations.
      this.grant({ coreId: request.coreId, projectId: project.id });
      Object.assign(request, { status: 'accepted', project: { id: project.id, name: project.name.slice(0, 200) }, decidedBy, decidedAt: now, pendingSend: true });
    } else {
      const why = reason === undefined || reason === null || reason === '' ? 'The owner declined this request.' : text(reason, 'reason', 500);
      Object.assign(request, { status: 'refused', reason: why, decidedBy, decidedAt: now, pendingSend: true });
    }
    this.saveRequests(requests);
    this.changed();
    this.flush(request.coreId);
    return this.requestView(request);
  }

  /** A trusted contact's request: an exact git remote match opens its project, else the concierge decides. */
  private autoDecide(id: string): void {
    if (this.closed || this.deciding.has(id)) return;
    const request = this.requests().find(entry => entry.id === id && entry.direction === 'in' && entry.status === 'pending');
    if (!request || !this.find(request.coreId)?.trusted) return;
    const projects = this.core.journal.listProjects().filter(project => !project.archived)
      .map(project => ({ id: project.id, name: project.name.slice(0, 200), ...(() => { const remote = gitRemoteOf(project.path); return remote ? { gitRemote: remote } : {}; })() }));
    if (request.gitRemote) {
      const matches = projects.filter(project => project.gitRemote === request.gitRemote);
      if (matches.length === 1) { this.settle(id, true, matches[0]!.id, undefined, 'match'); return; }
    }
    this.deciding.add(id);
    this.background(this.concierge.decide(this.requestView(request), projects).then(verdict => {
      const current = this.requests().find(entry => entry.id === id);
      if (current?.status !== 'pending' || !this.find(current.coreId)?.trusted) return;
      if (verdict.accept) { this.settle(id, true, verdict.projectId, undefined, 'concierge'); return; }
      // The contact wrote the request the model read, and the model saw every project here:
      // its reason stays in this core's log, and the contact reads fixed words.
      this.core.log('info', `contacts: the concierge refused ${request.contact}'s request: ${verdict.reason}`, { source: 'contacts' });
      this.settle(id, false, undefined, CONCIERGE_REFUSAL, 'concierge');
    }, (error: unknown) => {
      this.core.log('warn', `contacts: the concierge did not decide ${request.contact}'s request (${messageOf(error)}); it waits for the owner`, { source: 'contacts' });
    }).finally(() => this.deciding.delete(id)));
  }

  // -- Agent methods.

  /** The contacts this thread's agent may write to, with what each opened to this core. */
  forThread(threadId: string): RpcResult<'collaboration.contacts'> {
    this.core.threads.require(threadId);
    const config = this.core.coordination.config(threadId);
    if (config.mode === 'off' || !config.remote) return [];
    return this.list().map(contact => ({ name: contact.name, coreId: contact.coreId, projects: contact.offers.map(offer => offer.name), link: this.linkState(contact) }));
  }

  ask(params: RpcParams<'collaboration.ask'>): ContactRequest {
    const from = this.core.coordination.describe(params.threadId);
    const config = this.core.coordination.config(params.threadId);
    if (!config.remote) throw refused('threadId: cross-machine coordination is disabled for this thread', { field: 'threadId' });
    if (config.paused) throw refused('coordination paused by the owner');
    const contact = this.named(params.contact);
    this.checkSendTier(params.threadId);
    const body = text(params.text, 'text', 4000);
    const requests = this.requests();
    if (requests.filter(request => request.coreId === contact.coreId && request.direction === 'out' && request.status === 'pending').length >= MAX_PENDING) {
      throw refused(`at most ${MAX_PENDING} requests may wait at ${contact.name}; wait for an answer`);
    }
    const gitRemote = gitRemoteOf(this.core.threads.require(params.threadId).cwd);
    const request: StoredRequest = {
      id: newId('creq_'), direction: 'out', coreId: contact.coreId, contact: contact.name, from, text: body,
      ...(gitRemote ? { gitRemote } : {}), createdAt: Date.now(), status: 'pending', pendingSend: true,
    };
    this.saveRequests([...requests, request]);
    this.noteSent(params.threadId, contact.coreId);
    this.changed();
    this.flush(contact.coreId);
    return this.requestView(request);
  }

  // -- What a contact's core tells this one (`coordination.ts` checked the signature, the seal and `from`).

  /** The projects the contact opened to this core. */
  synced(coreId: string, payload: unknown): { ok: true } {
    const offers = (payload as { offers?: unknown } | null)?.offers;
    if (!Array.isArray(offers) || offers.length > 256) throw invalidParams('sync.offers: expected up to 256 projects');
    const checked: ContactOffer[] = offers.map((offer: Partial<ContactOffer>, index) => ({
      projectId: text(offer?.projectId, `sync.offers[${index}].projectId`, 128), name: text(offer?.name, `sync.offers[${index}].name`, 200),
    }));
    const contact = this.find(coreId);
    if (contact && JSON.stringify(contact.offers) !== JSON.stringify(checked)) this.mutate(coreId, entry => { entry.offers = checked; });
    return { ok: true };
  }

  /** A contact's agent asks for an agent here. Kept for the owner, or decided at once for a trusted contact. */
  asked(coreId: string, payload: unknown, from: AgentContact): { id: string } {
    const ask = payload as { id?: unknown; text?: unknown; gitRemote?: unknown } | null;
    if (typeof ask?.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(ask.id)) throw invalidParams('ask.id: expected 1 to 100 letters, digits, - or _');
    const contact = this.find(coreId)!;
    const requests = this.requests();
    // A retry of the same ask: the contact's id is only unique among its own requests.
    if (requests.some(request => request.remoteId === ask.id && request.coreId === coreId && request.direction === 'in')) return { id: ask.id };
    this.checkAttestedTier(from.agent);
    if (requests.filter(request => request.coreId === coreId && request.direction === 'in' && request.status === 'pending').length >= MAX_PENDING) {
      throw refused(`at most ${MAX_PENDING} of your requests may wait here; wait for the owner to answer`);
    }
    const gitRemote = ask.gitRemote === undefined || ask.gitRemote === null ? null : checkNormalizedRemote(ask.gitRemote, 'ask.gitRemote');
    const request: StoredRequest = {
      id: newId('creq_'), remoteId: ask.id, direction: 'in', coreId, contact: contact.name, from, text: text(ask.text, 'ask.text', 4000),
      ...(gitRemote ? { gitRemote } : {}), createdAt: Date.now(), status: 'pending',
    };
    this.saveRequests([...requests, request]);
    this.changed();
    if (contact.trusted) queueMicrotask(() => this.autoDecide(request.id));
    return { id: ask.id };
  }

  /** The contact decided a request of this core: the asking thread hears it as a message. */
  answered(coreId: string, payload: unknown, threads: AgentContact[]): { ok: true } {
    const answer = payload as { id?: unknown; status?: unknown; project?: { id?: unknown; name?: unknown }; reason?: unknown; decidedBy?: unknown; decidedAt?: unknown } | null;
    const requests = this.requests();
    const request = requests.find(entry => entry.id === answer?.id && entry.coreId === coreId && entry.direction === 'out');
    if (!request) throw invalidParams('answer.id: expected a request this core sent you');
    if (request.status !== 'pending') return { ok: true };
    if (answer!.status !== 'accepted' && answer!.status !== 'refused') throw invalidParams('answer.status: expected accepted or refused');
    if (!['owner', 'match', 'concierge'].includes(answer!.decidedBy as string)) throw invalidParams('answer.decidedBy: expected owner, match or concierge');
    const decidedAt = Number.isSafeInteger(answer!.decidedAt) ? answer!.decidedAt as number : Date.now();
    if (answer!.status === 'accepted') {
      Object.assign(request, { status: 'accepted', project: { id: text(answer!.project?.id, 'answer.project.id', 128), name: text(answer!.project?.name, 'answer.project.name', 200) } });
    } else Object.assign(request, { status: 'refused', reason: text(answer!.reason, 'answer.reason', 500) });
    Object.assign(request, { decidedBy: answer!.decidedBy, decidedAt });
    delete request.pendingSend;
    this.saveRequests(requests);
    this.changed();
    this.core.coordination.contactAnswer(this.requestView(request), this.find(coreId)?.name ?? request.contact, threads);
    return { ok: true };
  }

  /** What an accepted request opened: the project's threads the contact sees. */
  private answerThreads(request: StoredRequest): AgentContact[] {
    if (request.status !== 'accepted' || !request.project) return [];
    const projectId = request.project.id;
    return this.core.coordination.contactDirectory(request.coreId).filter(entry => this.core.journal.getThread(entry.threadId)?.projectId === projectId);
  }

  // -- Telling the contact: grants, asks and answers, retried until heard.

  private offersFor(contact: StoredContact): ContactOffer[] {
    return contact.grants.flatMap(grant => {
      const project = this.core.journal.getProject(grant.projectId);
      return project && !project.archived ? [{ projectId: project.id, name: project.name.slice(0, 200) }] : [];
    });
  }

  private flush(coreId: string): void {
    if (this.closed || !this.started || this.flushing.has(coreId) || !this.linked(coreId)) return;
    this.flushing.add(coreId);
    this.background(this.tell(coreId).finally(() => this.flushing.delete(coreId)));
  }

  private async tell(coreId: string): Promise<void> {
    const peer = (): CoordinationPeer => {
      const found = this.peers().find(entry => entry.coreId === coreId);
      if (!found) throw new Error('no longer a contact');
      return found;
    };
    const contact = this.find(coreId);
    if (!contact) return;
    if (contact.syncPending) {
      const version = contact.syncPending;
      try { await this.core.coordination.request(peer(), 'contact.sync', { offers: this.offersFor(contact) }); }
      catch (error) { if (!(error instanceof PeerRefusal)) throw error; }
      if (this.find(coreId)?.syncPending === version) this.mutate(coreId, entry => { delete entry.syncPending; });
    }
    for (const request of this.requests().filter(entry => entry.coreId === coreId && entry.pendingSend)) {
      if (this.closed) return;
      let refusal: string | null = null;
      try {
        if (request.direction === 'out') await this.core.coordination.request(peer(), 'contact.ask', { id: request.id, from: request.from, text: request.text, ...(request.gitRemote ? { gitRemote: request.gitRemote } : {}) });
        else {
          await this.core.coordination.request(peer(), 'contact.answer', {
            id: request.remoteId ?? request.id, status: request.status, decidedBy: request.decidedBy, decidedAt: request.decidedAt,
            ...(request.project ? { project: request.project } : {}), ...(request.reason ? { reason: request.reason } : {}), threads: this.answerThreads(request),
          });
        }
      } catch (error) {
        if (!(error instanceof PeerRefusal)) throw error;
        refusal = error.message;
      }
      const requests = this.requests();
      const current = requests.find(entry => entry.id === request.id && entry.coreId === coreId && entry.direction === request.direction);
      if (!current) continue;
      delete current.pendingSend;
      // The contact refused the ask itself (a tier, a full queue): the asking thread is told now.
      const refusedAsk = refusal !== null && current.direction === 'out' && current.status === 'pending';
      if (refusedAsk) Object.assign(current, { status: 'refused', reason: refusal, decidedAt: Date.now() });
      this.saveRequests(requests);
      this.changed();
      if (refusedAsk) this.core.coordination.contactAnswer(this.requestView(current), this.find(coreId)?.name ?? current.contact, []);
    }
  }

  // -- Join: the host's side.

  /** `POST /contacts/join` (`join.ts`). */
  http(request: Request): Promise<Response> { return joinRequest(this, this.core, request); }

  get isClosed(): boolean { return this.closed; }

  /** Refused unless `at` is within a minute and `nonce` was never used by this core: a request recorded and sent again goes nowhere. */
  fresh(coreId: string, nonce: string, at: unknown): void {
    const now = Date.now();
    if (!nonce) throw invalidParams('nonce: expected 1 to 100 characters');
    if (!Number.isSafeInteger(at) || Math.abs(now - (at as number)) > SKEW_MS) throw refused('at: expected the current time, within a minute');
    for (const [key, seen] of this.nonces) if (now - seen > 2 * SKEW_MS) this.nonces.delete(key);
    const key = `${coreId}:${nonce}`;
    if (this.nonces.has(key)) throw refused('nonce: already used; this request was replayed');
    this.nonces.set(key, now);
  }

  // -- The link: the host's side.

  /**
   * Checks the hello a guest dials with, before the upgrade: signed by the
   * contact's key, to this core, current and never seen. A Response is the
   * refusal to send back.
   */
  hello(request: Request): ContactSocketData['contact'] | Response {
    if (this.closed || request.headers.has('origin')) return new Response('forbidden', { status: 403 });
    const guest = request.headers.get('x-boite-peer') ?? '';
    const contact = this.find(guest);
    if (!contact || contact.role !== 'host') return new Response('not a contact that dials this core', { status: 403 });
    try {
      const hello = Buffer.from(request.headers.get('x-boite-hello') ?? '', 'base64url').toString('utf8');
      const signature = request.headers.get('x-boite-signature') ?? '';
      if (!hello || !verify(null, Buffer.from(`${HELLO_INPUT}${hello}`), contact.publicKey, Buffer.from(signature, 'base64'))) throw refused('signature: expected the contact\'s key to sign the hello');
      const parsed = JSON.parse(hello) as { v?: unknown; from?: unknown; to?: unknown; at?: unknown; nonce?: unknown };
      if (parsed.v !== 1 || parsed.from !== guest || parsed.to !== this.core.coordination.card().coreId) throw refused('hello: expected v 1, from the dialling contact, to this core');
      this.fresh(guest, typeof parsed.nonce === 'string' && parsed.nonce.length <= 100 ? parsed.nonce : '', parsed.at);
    } catch (error) {
      return new Response(error instanceof RpcFailure ? error.message : 'invalid hello', { status: 403 });
    }
    return { coreId: guest, routeId: `contact:${randomUUID()}` };
  }

  /** The guest's socket is open: it becomes the bridge route for that contact, replacing an older one. */
  attach(data: ContactSocketData['contact'], socket: LinkSocket): void {
    const contact = this.find(data.coreId);
    if (this.closed || !contact || contact.role !== 'host') { socket.close(1008, 'not a contact'); return; }
    const previous = this.hosted.get(data.coreId);
    if (previous) {
      this.core.coordination.bridge.disconnect(previous.routeId);
      previous.socket.close(1000, 'replaced by a newer link');
    }
    this.hosted.set(data.coreId, { routeId: data.routeId, socket });
    const route: BridgeRoute = {
      id: data.routeId,
      sendEvent: (_name, payload: RpcEvents['collaboration.bridge.request']) => {
        socket.send(JSON.stringify({ t: 'req', id: payload.requestId, body: payload.body, signature: payload.signature } satisfies Frame));
      },
    };
    this.core.coordination.bridge.register(data.coreId, true, route);
    this.mutate(data.coreId, entry => { entry.lastSeenAt = Date.now(); });
    this.flush(data.coreId);
  }

  /** A frame from a guest: only the answers to this core's requests. */
  frame(data: ContactSocketData['contact'], raw: string | Buffer): void {
    let frame: Partial<Extract<Frame, { t: 'res' }>>;
    try { frame = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8')) as typeof frame; } catch { return; }
    if (frame?.t !== 'res' || typeof frame.id !== 'string' || typeof frame.status !== 'number' || typeof frame.body !== 'string' || typeof frame.signature !== 'string') return;
    try { this.core.coordination.bridge.reply(frame.id, { status: frame.status, body: frame.body, signature: frame.signature }, { id: data.routeId }); } catch { /* A late or unknown answer. */ }
  }

  detach(data: ContactSocketData['contact']): void {
    this.core.coordination.bridge.disconnect(data.routeId);
    if (this.hosted.get(data.coreId)?.routeId !== data.routeId) return;
    this.hosted.delete(data.coreId);
    if (!this.closed) this.changed();
  }

  // -- The link: the guest's side.

  dial(contact: StoredContact): void {
    if (this.closed || !this.started || contact.role !== 'guest' || contact.url === undefined || this.dialed.has(contact.coreId)) return;
    const self = this.core.coordination.card();
    const hello = JSON.stringify({ v: 1, from: self.coreId, to: contact.coreId, at: Date.now(), nonce: randomUUID() });
    const headers = {
      'x-boite-peer': self.coreId,
      'x-boite-hello': Buffer.from(hello).toString('base64url'),
      'x-boite-signature': this.core.coordination.signature(Buffer.from(`${HELLO_INPUT}${hello}`)).toString('base64'),
    };
    let socket: WebSocket;
    try {
      // Bun's client takes headers; the hello rides in them, before any frame.
      socket = new WebSocket(`${contact.url.replace(/^http/, 'ws')}${CONTACT_LINK_ROUTE}`, { headers } as unknown as string[]);
    } catch {
      // A link that fails counts whatever was heard before: the mark is now.
      this.backoff.failed(contact.coreId, 'link', this.backoff.mark());
      return;
    }
    const coreId = contact.coreId;
    const link = { socket, state: 'connecting' as 'connecting' | 'connected' };
    this.dialed.set(coreId, link);
    socket.addEventListener('open', () => {
      if (this.closed || this.dialed.get(coreId) !== link) { socket.close(1000); return; }
      link.state = 'connected';
      this.backoff.heard(coreId);
      if (this.has(coreId)) this.mutate(coreId, entry => { entry.lastSeenAt = Date.now(); });
      this.flush(coreId);
    });
    socket.addEventListener('message', event => { this.background(this.serve(coreId, socket, event.data)); });
    socket.addEventListener('close', () => {
      if (this.dialed.get(coreId) !== link) return;
      this.dialed.delete(coreId);
      this.backoff.failed(coreId, 'link', this.backoff.mark());
      if (!this.closed) this.changed();
    });
  }

  /** A request of the host, carried down the link: answered by the same handler as one posted to this core. */
  private async serve(hostId: string, socket: WebSocket, data: unknown): Promise<void> {
    let frame: Partial<Extract<Frame, { t: 'req' }>>;
    try { frame = JSON.parse(typeof data === 'string' ? data : Buffer.from(data as ArrayBuffer).toString('utf8')) as typeof frame; } catch { return; }
    if (frame?.t !== 'req' || typeof frame.id !== 'string' || typeof frame.body !== 'string' || typeof frame.signature !== 'string') return;
    let response: CoordinationBridgeResponse;
    try { response = await this.core.coordination.forward({ coreId: hostId, body: frame.body, signature: frame.signature }); }
    catch { response = { status: 400, body: '', signature: '' }; }
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ t: 'res', id: frame.id, ...response } satisfies Frame));
  }

  /** Closes this core's side of a contact's link. */
  unlink(coreId: string): void {
    const dialed = this.dialed.get(coreId);
    if (dialed) { this.dialed.delete(coreId); dialed.socket.close(1000, 'contact removed'); }
    const hosted = this.hosted.get(coreId);
    if (hosted) {
      this.hosted.delete(coreId);
      this.core.coordination.bridge.disconnect(hosted.routeId);
      hosted.socket.close(1000, 'contact removed');
    }
    this.backoff.heard(coreId);
  }

  // -- Lifecycle.

  /** Called once the server listens. Nothing runs without a contact or an open invitation. */
  start(): void {
    if (this.closed) return;
    this.started = true;
    this.listening = this.wantsTailnet();
    if (this.list().length > 0 || this.liveInvites().length > 0) this.arm();
  }

  arm(): void {
    if (this.closed || !this.started || this.timer !== null) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref?.();
    queueMicrotask(() => this.tick());
  }

  private tick(): void {
    if (this.closed) return;
    const contacts = this.list();
    // An invitation that expired may have been the last reason to listen on the tailnet.
    this.relisten();
    if (contacts.length === 0 && this.liveInvites().length === 0) {
      if (this.timer !== null) clearInterval(this.timer);
      this.timer = null;
      return;
    }
    this.ticks += 1;
    for (const contact of contacts) if (contact.role === 'guest' && !this.dialed.has(contact.coreId) && !this.backoff.waiting(contact.coreId, 'link')) this.dial(contact);
    if (this.ticks % FLUSH_TICKS === 0) for (const contact of contacts) this.flush(contact.coreId);
  }

  /** Opens or closes the tailnet listener when `wantsTailnet` changed. */
  relisten(): void {
    const wants = this.wantsTailnet();
    if (wants === this.listening) return;
    this.listening = wants;
    this.core.group.relisten();
  }

  beginClose(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    for (const { socket } of this.dialed.values()) socket.close(1001, 'core stopping');
    this.dialed.clear();
    for (const { socket } of this.hosted.values()) socket.close(1001, 'core stopping');
    this.hosted.clear();
    this.concierge.close();
  }

  async close(): Promise<void> {
    this.beginClose();
    await Promise.allSettled([...this.pending]);
  }
}

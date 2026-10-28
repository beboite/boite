/*
 * A contact across the owner's group. A contact is linked to one machine of
 * the group, and the owner may open it projects that live on the others.
 *
 * The linked machine answers for them. It asks the member that holds the
 * project and hands the contact that member's threads under its own core id,
 * each thread id followed by `~` and the first 16 characters of the member's
 * core id. Legacy lookups keep the member name, address and key private.
 * Explicit shared-project associations additionally disclose canonical endpoint
 * fingerprints and their accepted directory labels, without forwarding owner RPC.
 *
 * The member keeps a copy of each contact it was opened to (`relayed`), with
 * the grants on its own projects, the owner's model tier and what the contact
 * opened in return, so its agents list the contact and its letters cross back
 * the same way. The linked machine pushes that copy at every change and
 * retries until the member heard it; each request it relays carries the
 * contact's current copy too, so a member that missed a push answers from
 * what is true now.
 */
import type { AgentAddress, AgentContact, AgentLetter, Contact, ContactCapabilities, ContactOffer, CoordinationPeer, ModelTier } from '@boite/contracts';
import { address, text } from '../coordination-letter.ts';
import { checkMatchExtras, checkRemoteContact, checkTranscript } from '../coordination-lookup.ts';
import { PeerRefusal, type Operation } from '../coordination-wire.ts';
import type { Core } from '../core.ts';
import { invalidParams, messageOf, refused, RpcFailure, unavailable } from '../errors.ts';
import { checkTier } from './tier.ts';
import { projectRoute } from './project-relay.ts';
import { projectRef } from './project-policy.ts';
import { memberThreadId } from './member-address.ts';
import { memberAdmission, projectAdmission } from './admission.ts';
export { memberThreadId } from './member-address.ts';

const MIRROR = 'contacts:relayed';
const MIRROR_PENDING = 'contacts:relayed-pending';
const MARK = '~';
const PREFIX = 16;
/** A relayed request must come back before the contact's own request to this core times out (5 s). */
const RELAY_MS = 3500;
/** What a contact may ask of a member's threads, through the machine it is linked to. */
const RELAYED: readonly Operation[] = ['directory', 'search', 'read', 'deliver', 'receipt', 'contact.project'];

/** A contact as the member it was opened to keeps it. */
export interface RelayedEntry {
  coreId: string;
  name: string;
  minTier: ModelTier;
  link: Contact['link'];
  /** The names of the projects the contact opened to the owner. */
  offers: string[];
  /** The member's own projects opened to the contact. */
  grants: { projectId: string; readThreads: boolean }[];
  capabilities?: ContactCapabilities;
  projectOffers?: ContactOffer[];
}
/** `via`: the member of the group the contact is linked to. */
export type RelayedContact = RelayedEntry & { via: string; admission: string };

/** What the linked machine reads of its contacts. */
export interface LinkedContacts {
  find(coreId: string): { coreId: string; name: string; offers: ContactOffer[]; capabilities?: ContactCapabilities; grants: { projectId: string; readThreads: boolean; machine?: string }[] } | undefined;
  list(): { coreId: string; grants: { machine?: string }[] }[];
  linkOf(coreId: string): Contact['link'];
  settings(): { minTier: ModelTier };
  /** The member dropped grants or the whole contact: its replies and pending letters follow. */
  projectsClosed(coreId: string, projectIds: string[] | null): void;
  /** The copies changed: peers are listed again. */
  reset(): void;
  /** Starts the contacts' timer, which retries the pushes. */
  arm(): void;
}

function within<T>(job: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([job, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not answer in time`)), ms); })]).finally(() => clearTimeout(timer));
}

/** A member's thread as the contact addresses it: on the linked machine. */

export class ContactMembers {
  readonly #pushing = new Set<string>();
  readonly #pending = new Set<Promise<unknown>>();
  #closed = false;

  readonly #core: Core;
  readonly #contacts: LinkedContacts;
  constructor(core: Core, contacts: LinkedContacts) {
    this.#core = core;
    this.#contacts = contacts;
  }

  #members(): CoordinationPeer[] { return this.#core.group.peers(); }
  #selfId(): string { return this.#core.coordination.card().coreId; }

  // -- The linked machine's side.

  /** The member a `machine` field names, or null for this core. */
  member(value: unknown): CoordinationPeer | null {
    if (value === undefined || value === null || value === '' || value === this.#selfId()) return null;
    const coreId = text(value, 'machine', 100);
    const peer = this.#members().find(entry => entry.coreId === coreId);
    if (!peer) throw invalidParams('machine: expected the core id of a machine of this core\'s group', { field: 'machine', expected: 'a member of this core\'s group' });
    return peer;
  }

  /** The member's project, checked there, and its name: what the contact's offers show. */
  async project(member: CoordinationPeer, projectId: unknown): Promise<{ projectId: string; name: string }> {
    const id = text(projectId, 'projectId', 128);
    let answer: unknown;
    try { answer = await within(this.#core.coordination.request(member, 'relay.project', { projectId: id }), RELAY_MS, member.name); }
    catch (error) {
      if (!(error instanceof PeerRefusal)) throw unavailable(`${member.name} did not answer (${messageOf(error)}); open its project while it is on`);
      if (error.message.startsWith('operation:')) throw refused(`${member.name} runs an older Boite; update it to open its projects to a contact`);
      throw invalidParams(`projectId: ${member.name} says ${error.message}`, { field: 'projectId' });
    }
    const name = (answer as { name?: unknown } | null)?.name;
    return { projectId: id, name: text(name, 'project.name', 200) };
  }

  /** The members whose projects are opened to this contact. */
  #holders(contactId: string): CoordinationPeer[] {
    const ids = new Set(this.#contacts.find(contactId)?.grants.flatMap(grant => grant.machine ? [grant.machine] : []) ?? []);
    return this.#members().filter(member => ids.has(member.coreId));
  }

  /** The member and its own thread id behind an id the contact uses, when that member holds a project opened to it. */
  locate(contactId: string, threadId: unknown): { member: CoordinationPeer; threadId: string } | null {
    if (typeof threadId !== 'string') return null;
    const at = threadId.lastIndexOf(MARK);
    if (at <= 0 || threadId.length - at - 1 !== PREFIX) return null;
    const prefix = threadId.slice(at + 1);
    const member = this.#holders(contactId).find(entry => entry.coreId.startsWith(prefix));
    return member ? { member, threadId: threadId.slice(0, at) } : null;
  }

  #entry(contactId: string, memberId: string): RelayedEntry | null {
    const contact = this.#contacts.find(contactId);
    if (!contact) return null;
    return {
      coreId: contact.coreId, name: contact.name, minTier: this.#contacts.settings().minTier, link: this.#contacts.linkOf(contact.coreId),
      offers: contact.offers.map(offer => offer.name),
      capabilities: contact.capabilities, projectOffers: contact.offers,
      grants: contact.grants.filter(grant => grant.machine === memberId).map(grant => ({ projectId: grant.projectId, readThreads: grant.readThreads })),
    };
  }

  /** One request of the contact, answered by the member. A refusal there is the contact's refusal; silence is not. */
  private async ask(member: CoordinationPeer, contactId: string, operation: Operation, payload: unknown): Promise<unknown> {
    const contact = this.#entry(contactId, member.coreId);
    if (!contact) throw refused('no longer a contact');
    const admission = () => {
      const entry = this.#entry(contactId, member.coreId);
      if (!entry) throw refused('no longer a contact');
      const {link: _link, ...policy} = entry;
      return JSON.stringify([memberAdmission(this.#core, member.coreId), this.#core.contacts.find(contactId)?.addedAt, policy]);
    };
    const before = admission();
    let changed = false;
    // A revoked permission cannot authorize an old response when the owner later
    // restores the same values. Observe policy changes throughout this await.
    const off = this.#core.bus.onAny(name => {
      if (name !== 'contacts.updated' && name !== 'group.updated') return;
      try { if (admission() !== before) changed = true; }
      catch { changed = true; }
    });
    try {
      const answer = await within(this.#core.coordination.request(member, 'relay.in', { contact, operation, payload }), RELAY_MS, member.name);
      if (changed || admission() !== before) throw refused('relay: contact, member admission or project permissions changed during request');
      return answer;
    }
    catch (error) {
      if (error instanceof RpcFailure) throw error;
      if (error instanceof PeerRefusal) throw refused(error.message);
      throw new Error(messageOf(error));
    } finally { off(); }
  }

  requestProject(member: CoordinationPeer, contactId: string, payload: unknown): Promise<unknown> {
    return this.ask(member, contactId, 'contact.project', payload);
  }

  /** A member's thread under this core's id. */
  #outward<T extends AgentContact>(entry: T, member: CoordinationPeer): T {
    return { ...entry, coreId: this.#selfId(), threadId: memberThreadId(member.coreId, entry.threadId), machine: this.#core.info().hostname ?? 'Boite' };
  }

  /** Each holder's threads open to the contact, and how many holders did not answer. */
  directory(contactId: string): Promise<{ entries: AgentContact[]; unavailable: number }> {
    return this.#gather(contactId, 'directory', {}, (entry, member) => checkRemoteContact(entry as AgentContact, member));
  }

  search(contactId: string, words: string[]): Promise<{ entries: AgentContact[]; unavailable: number }> {
    return this.#gather(contactId, 'search', { words }, (match, member) => ({ ...checkRemoteContact(match as AgentContact, member), ...checkMatchExtras(match as { matched?: unknown; excerpts?: unknown }) }));
  }

  /** One list from every holder: a member that fails or answers badly is counted, never read as an empty list. */
  async #gather(contactId: string, operation: 'directory' | 'search', payload: unknown, check: (entry: unknown, member: CoordinationPeer) => AgentContact): Promise<{ entries: AgentContact[]; unavailable: number }> {
    const found = await Promise.all(this.#holders(contactId).map(async member => {
      try {
        const answer = await this.ask(member, contactId, operation, payload);
        if (!Array.isArray(answer) || answer.length > 100) throw new Error(`invalid ${operation}`);
        return answer.map(entry => this.#outward(check(entry, member), member));
      } catch (error) { this.#warn(member, error); return null; }
    }));
    return { entries: found.flatMap(list => list ?? []), unavailable: found.filter(list => list === null).length };
  }

  async read(contactId: string, at: { member: CoordinationPeer; threadId: string }, payload: { limit?: unknown; before?: unknown }): Promise<unknown> {
    const answer = await this.ask(at.member, contactId, 'read', { threadId: at.threadId, limit: payload.limit, before: payload.before });
    const contact = checkRemoteContact((answer as { contact?: AgentContact } | null)?.contact as AgentContact, at.member);
    if (contact.threadId !== at.threadId) throw new Error('transcript of another thread');
    return { contact: this.#outward(contact, at.member), ...checkTranscript(answer) };
  }

  async deliver(contactId: string, at: { member: CoordinationPeer; threadId: string }, letter: AgentLetter): Promise<AgentLetter> {
    const shown = letter.to;
    const answer = await this.ask(at.member, contactId, 'deliver', { ...letter, to: { coreId: at.member.coreId, threadId: at.threadId } }) as AgentLetter | null;
    if (!answer || answer.id !== letter.id) throw new Error('invalid delivery receipt');
    return { ...answer, to: shown, toMachine: this.#core.info().hostname ?? 'Boite' };
  }

  /** The receipt of a letter the contact sent a member's thread: the members holding its projects are asked in turn. */
  /**
   * The receipt of a letter the contact sent a member's thread: every member
   * holding its projects is asked at once, within the relay's bound. Unknown
   * is final only when each of them said so: a member that did not answer
   * leaves the contact to ask again.
   */
  async receipt(contactId: string, payload: unknown): Promise<AgentLetter> {
    const found = await Promise.all(this.#holders(contactId).map(async member => {
      try {
        const answer = await this.ask(member, contactId, 'receipt', payload) as AgentLetter | null;
        if (!answer || typeof answer !== 'object') return { member, letter: null, down: true };
        return { member, letter: answer, down: false };
      } catch (error) { return { member, letter: null, down: !(error instanceof RpcFailure) }; }
    }));
    const hit = found.find(entry => entry.letter !== null);
    if (hit) {
      const to = address(hit.letter!.to, 'receipt.to');
      return { ...hit.letter!, to: { coreId: this.#selfId(), threadId: memberThreadId(hit.member.coreId, to.threadId) }, toMachine: this.#core.info().hostname ?? 'Boite' };
    }
    if (found.some(entry => entry.down)) throw new Error('a machine holding this contact\'s projects did not answer');
    throw refused('unknown receipt');
  }

  /**
   * A member's agent asks the contact (`relay.out`): this core sends it on
   * as its own, the member's thread under this core's id, and gives the
   * answer back with the member's own ids.
   */
  async outbound(member: CoordinationPeer, raw: unknown): Promise<unknown> {
    const request = raw as { contact?: unknown; operation?: unknown; payload?: unknown } | null;
    const contactId = text(request?.contact, 'relay.contact', 100);
    const operation = request?.operation as Operation;
    if (!RELAYED.includes(operation)) throw invalidParams('relay.operation: expected directory, search, read, deliver, receipt or contact.project');
    if (!this.#contacts.find(contactId)) throw refused('relay.contact: not a contact of this machine any more');
    // The member's copy may be behind a revoke it missed: this core's grants decide, and the copy is pushed again.
    if (!this.holdersOf(contactId).includes(member.coreId)) {
      this.mark([member.coreId]);
      throw refused('relay.contact: nothing of this machine is opened to that contact any more');
    }
    const peer = this.#core.contacts.peers().find(entry => entry.coreId === contactId && !this.#core.contacts.isRelayPeer(entry));
    if (!peer) throw refused('relay.contact: not a contact of this machine any more');
    let payload = request?.payload;
    if (operation === 'contact.project') {
      const route = projectRoute(payload), self = this.#selfId();
      if (!route || route.source.ownerCoreId !== self || route.source.coreId !== member.coreId || route.target.ownerCoreId !== contactId
        || !this.#contacts.find(contactId)?.grants.some(g => g.machine === member.coreId && g.projectId === route.source.projectId)) throw refused('route.source: expected this member current granted endpoint');
      const admission = projectAdmission(this.#core, contactId, member.coreId, route.source.projectId);
      let answer: unknown;
      try { answer = await this.#core.coordination.request(peer, operation, payload); }
      catch (error) { if (error instanceof PeerRefusal) throw refused(error.message); throw error; }
      if (projectAdmission(this.#core, contactId, member.coreId, route.source.projectId) !== admission) throw refused('route.source: member or project grant changed during request');
      return answer;
    }
    let from: AgentAddress | null = null;
    if (operation === 'deliver') {
      const letter = payload as AgentLetter;
      from = address(letter?.from, 'letter.from');
      if (from.coreId !== member.coreId) throw refused('letter.from: expected a thread of the asking machine');
      // The member's name stays here, as in `outward`.
      payload = { ...letter, from: { ...letter.from, coreId: this.#selfId(), threadId: memberThreadId(member.coreId, from.threadId), machine: this.#core.info().hostname ?? 'Boite' } };
    } else if (operation === 'receipt') {
      const receipt = payload as { id?: unknown; fromThreadId?: unknown } | null;
      from = { coreId: member.coreId, threadId: text(receipt?.fromThreadId, 'receipt.fromThreadId', 128) };
      payload = { id: receipt?.id, fromThreadId: memberThreadId(member.coreId, from.threadId) };
    }
    let answer: unknown;
    try { answer = await this.#core.coordination.request(peer, operation, payload); }
    catch (error) {
      // The contact's refusal is final for the member too; a link down is retried there, as here.
      if (error instanceof PeerRefusal) throw refused(error.message);
      throw new Error(messageOf(error));
    }
    if (from === null) return answer;
    const letter = answer as AgentLetter | null;
    if (!letter || typeof letter !== 'object' || !letter.from) throw new Error('invalid delivery receipt');
    return { ...letter, from: { ...letter.from, coreId: from.coreId, threadId: from.threadId } };
  }

  // -- Telling the members, retried until heard.

  #pendingPush(): Record<string, number> { return (this.#core.journal.getSetting(MIRROR_PENDING) as Record<string, number> | undefined) ?? {}; }

  /** These members' copies are behind: each is pushed now and at every flush until it hears. */
  mark(memberIds: Iterable<string>): void {
    const pending = this.#pendingPush();
    let changed = false;
    for (const id of memberIds) {
      if (!id) continue;
      pending[id] = (pending[id] ?? 0) + 1;
      changed = true;
    }
    if (!changed) return;
    this.#core.journal.setSetting(MIRROR_PENDING, pending);
    this.#contacts.arm();
    this.push();
  }

  /** A member's copy is still to push: the contacts' timer keeps running for it. */
  behind(): boolean { return Object.keys(this.#pendingPush()).length > 0; }

  /** The members that hold this contact's projects. */
  holdersOf(contactId: string): string[] {
    return [...new Set(this.#contacts.find(contactId)?.grants.flatMap(grant => grant.machine ? [grant.machine] : []) ?? [])];
  }

  /** Every member's copy that is behind, once each. */
  push(): void {
    if (this.#closed) return;
    const members = this.#members();
    const pending = this.#pendingPush();
    for (const memberId of Object.keys(pending)) {
      const member = members.find(entry => entry.coreId === memberId);
      // A machine that left the group has nothing to keep.
      if (!member) { this.#settle(memberId, pending[memberId]!); continue; }
      if (this.#pushing.has(memberId)) continue;
      this.#pushing.add(memberId);
      const job = this.#tell(member, pending[memberId]!).finally(() => this.#pushing.delete(memberId));
      this.#pending.add(job);
      void job.catch(error => { if (!this.#closed) this.#core.log('warn', `contacts: ${member.name} did not take its copy of the contacts (${messageOf(error)})`, { source: 'contacts' }); })
        .finally(() => this.#pending.delete(job));
    }
  }

  async #tell(member: CoordinationPeer, version: number): Promise<void> {
    const contacts = this.#contacts.list().flatMap(contact => contact.grants.some(grant => grant.machine === member.coreId) ? [this.#entry(contact.coreId, member.coreId)!] : []);
    try { await within(this.#core.coordination.request(member, 'relay.mirror', { contacts }), RELAY_MS, member.name); }
    catch (error) { if (!(error instanceof PeerRefusal)) throw error; }
    this.#settle(member.coreId, version);
  }

  #settle(memberId: string, version: number): void {
    const pending = this.#pendingPush();
    if (pending[memberId] !== version) return;
    delete pending[memberId];
    this.#core.journal.setSetting(MIRROR_PENDING, pending);
  }

  // -- The member's side.

  #stored(): RelayedContact[] { return (this.#core.journal.getSetting(MIRROR) as RelayedContact[] | undefined) ?? []; }
  /** The copies kept for members still in the group: one that left, or a group this core left, reaches nothing. */
  relayed(): RelayedContact[] {
    const stored = this.#stored();
    if (stored.length === 0) return stored;
    return stored.filter(entry => {
      try { return entry.admission === memberAdmission(this.#core, entry.via); }
      catch { return false; }
    });
  }
  /** The copies of this contact, one for each member it is linked to. */
  relayedOf(coreId: string): RelayedContact[] { return this.relayed().filter(entry => entry.coreId === coreId); }

  /** The member a relayed contact is reached through. */
  via(coreId: string): CoordinationPeer | null {
    const entry = this.relayedOf(coreId)[0];
    return entry ? this.#members().find(peer => peer.coreId === entry.via) ?? null : null;
  }

  /** A request of this core's agent for a relayed contact, sent through the member it is linked to. */
  async send(via: CoordinationPeer, contactId: string, operation: Operation, payload: unknown): Promise<unknown> {
    if (!RELAYED.includes(operation)) throw refused(`${operation}: ask from ${via.name}, the machine linked to that contact`);
    if (operation === 'contact.project') {
      const route = projectRoute(payload);
      const gateway = route && this.#members().find(p => p.coreId === route.source.ownerCoreId && this.relayedOf(contactId).some(e => e.via === p.coreId && e.grants.some(g => g.projectId === route.source.projectId)));
      if (!gateway) throw refused('route.source: expected a currently admitted gateway for this endpoint');
      via = gateway;
    }
    return this.#core.coordination.request(via, 'relay.out', { contact: contactId, operation, payload });
  }

  #checkEntry(value: unknown, field: string): RelayedEntry {
    const raw = value as Partial<RelayedEntry> | null;
    if (!raw || typeof raw !== 'object') throw invalidParams(`${field}: expected a contact`);
    if (!Array.isArray(raw.grants) || raw.grants.length > 256) throw invalidParams(`${field}.grants: expected up to 256 projects`);
    if (!Array.isArray(raw.offers) || raw.offers.length > 256) throw invalidParams(`${field}.offers: expected up to 256 names`);
    if (!['connected', 'connecting', 'offline'].includes(raw.link as string)) throw invalidParams(`${field}.link: expected connected, connecting or offline`);
    return {
      coreId: text(raw.coreId, `${field}.coreId`, 100), name: text(raw.name, `${field}.name`, 100), minTier: checkTier(raw.minTier, `${field}.minTier`), link: raw.link!,
      offers: raw.offers.map((name, index) => text(name, `${field}.offers[${index}]`, 200)),
      capabilities: { ...(raw.capabilities?.sharedProjects === 1 ? {sharedProjects: 1} : {}), ...(raw.capabilities?.humanLetters === 1 ? {humanLetters: 1} : {}) },
      projectOffers: Array.isArray(raw.projectOffers) ? raw.projectOffers.slice(0, 256).map(o => ({projectId: text(o.projectId, 'relay.offer.projectId', 128), name: text(o.name, 'relay.offer.name', 200), ...(o.sharedProject ? {sharedProject: projectRef(o.sharedProject)} : {})})) : [],
      grants: raw.grants.map((grant, index) => {
        if (typeof grant?.readThreads !== 'boolean') throw invalidParams(`${field}.grants[${index}].readThreads: expected a boolean`);
        return { projectId: text(grant.projectId, `${field}.grants[${index}].projectId`, 128), readThreads: grant.readThreads };
      }),
    };
  }

  /** The member names one of its projects for a grant (`relay.project`). */
  projectFor(payload: unknown): { name: string } {
    const projectId = text((payload as { projectId?: unknown } | null)?.projectId, 'projectId', 128);
    const project = this.#core.journal.getProject(projectId);
    if (!project || project.archived || project.kind === 'drafts') throw refused(`no unarchived project ${projectId}`);
    return { name: project.name.slice(0, 200) };
  }

  /** The whole copy `via` keeps of its contacts for this core (`relay.mirror`). */
  mirrored(via: string, payload: unknown): { ok: true } {
    const list = (payload as { contacts?: unknown } | null)?.contacts;
    if (!Array.isArray(list) || list.length > 32) throw invalidParams('mirror.contacts: expected up to 32 contacts');
    this.#replace(via, list.map((entry, index) => this.#checkEntry(entry, `mirror.contacts[${index}]`)), true);
    return { ok: true };
  }

  /** The copy a relayed request carries (`relay.in`): the contact as it stands now. */
  adopt(via: string, value: unknown): RelayedEntry {
    const entry = this.#checkEntry(value, 'relay.contact');
    this.#replace(via, [entry], false);
    return entry;
  }

  /** `whole`: `entries` are every contact of `via`, so the others are gone. */
  #replace(via: string, entries: RelayedEntry[], whole: boolean): void {
    const before = this.#stored();
    const kept = before.filter(entry => entry.via !== via || (!whole && !entries.some(next => next.coreId === entry.coreId)));
    const admission = memberAdmission(this.#core, via);
    const next = [...kept, ...entries.filter(entry => entry.grants.length > 0).map(entry => ({ ...entry, via, admission }))];
    if (JSON.stringify(before) === JSON.stringify(next)) return;
    this.#core.journal.setSetting(MIRROR, next);
    this.#contacts.reset();
    // What the member no longer opens: its replies end and its letters go nowhere.
    for (const old of before.filter(entry => entry.via === via)) {
      const now = next.find(entry => entry.via === via && entry.coreId === old.coreId);
      if (!now) { if (whole || entries.some(entry => entry.coreId === old.coreId)) this.#contacts.projectsClosed(old.coreId, null); continue; }
      const dropped = old.grants.filter(grant => !now.grants.some(kept => kept.projectId === grant.projectId)).map(grant => grant.projectId);
      if (dropped.length > 0) this.#contacts.projectsClosed(old.coreId, dropped);
    }
  }

  #warn(member: CoordinationPeer, error: unknown): void {
    if (!this.#closed) this.#core.log('info', `contacts: ${member.name} did not answer for a contact (${messageOf(error)})`, { source: 'contacts' });
  }

  beginClose(): void { this.#closed = true; }
  settled(): Promise<unknown> { return Promise.allSettled([...this.#pending]); }
}

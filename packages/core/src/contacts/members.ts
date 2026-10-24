/*
 * A contact across the owner's group. A contact is linked to one machine of
 * the group, and the owner may open it projects that live on the others.
 *
 * The linked machine answers for them. It asks the member that holds the
 * project and hands the contact that member's threads under its own core id,
 * each thread id followed by `~` and the first 16 characters of the member's
 * core id. The contact keeps talking to the one machine it knows, and never
 * learns of the member: neither its name nor its address nor its key.
 *
 * The member keeps a copy of each contact it was opened to (`relayed`), with
 * the grants on its own projects, the owner's model tier and what the contact
 * opened in return, so its agents list the contact and its letters cross back
 * the same way. The linked machine pushes that copy at every change and
 * retries until the member heard it; each request it relays carries the
 * contact's current copy too, so a member that missed a push answers from
 * what is true now.
 */
import type { AgentAddress, AgentContact, AgentLetter, Contact, CoordinationPeer, ModelTier } from '@boite/contracts';
import { address, text } from '../coordination-letter.ts';
import { checkMatchExtras, checkRemoteContact, checkTranscript } from '../coordination-lookup.ts';
import { PeerRefusal, type Operation } from '../coordination-wire.ts';
import type { Core } from '../core.ts';
import { invalidParams, messageOf, refused, unavailable } from '../errors.ts';
import { checkTier } from './tier.ts';

const MIRROR = 'contacts:relayed';
const MIRROR_PENDING = 'contacts:relayed-pending';
const MARK = '~';
const PREFIX = 16;
/** A relayed request must come back before the contact's own request to this core times out (5 s). */
const RELAY_MS = 3500;
/** What a contact may ask of a member's threads, through the machine it is linked to. */
const RELAYED: readonly Operation[] = ['directory', 'search', 'read', 'deliver', 'receipt'];

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
}
/** `via`: the member of the group the contact is linked to. */
export type RelayedContact = RelayedEntry & { via: string };

/** What the linked machine reads of its contacts. */
export interface LinkedContacts {
  find(coreId: string): { coreId: string; name: string; offers: { name: string }[]; grants: { projectId: string; readThreads: boolean; machine?: string }[] } | undefined;
  list(): { coreId: string; grants: { machine?: string }[] }[];
  linkOf(coreId: string): Contact['link'];
  settings(): { minTier: ModelTier };
  /** The member dropped grants or the whole contact: its replies and pending letters follow. */
  projectsClosed(coreId: string, projectIds: string[] | null): void;
  /** The copies changed: peers are listed again. */
  reset(): void;
}

function within<T>(job: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([job, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not answer in time`)), ms); })]).finally(() => clearTimeout(timer));
}

/** A member's thread as the contact addresses it: on the linked machine. */
export function memberThreadId(memberId: string, threadId: string): string { return `${threadId}${MARK}${memberId.slice(0, PREFIX)}`; }

export class ContactMembers {
  private readonly pushing = new Set<string>();
  private readonly pending = new Set<Promise<unknown>>();
  private closed = false;

  constructor(private readonly core: Core, private readonly contacts: LinkedContacts) {}

  private members(): CoordinationPeer[] { return this.core.group.peers(); }
  private selfId(): string { return this.core.coordination.card().coreId; }

  // -- The linked machine's side.

  /** The member a `machine` field names, or null for this core. */
  member(value: unknown): CoordinationPeer | null {
    if (value === undefined || value === null || value === '' || value === this.selfId()) return null;
    const coreId = text(value, 'machine', 100);
    const peer = this.members().find(entry => entry.coreId === coreId);
    if (!peer) throw invalidParams('machine: expected the core id of a machine of this core\'s group', { field: 'machine', expected: 'a member of this core\'s group' });
    return peer;
  }

  /** The member's project, checked there, and its name: what the contact's offers show. */
  async project(member: CoordinationPeer, projectId: unknown): Promise<{ projectId: string; name: string }> {
    const id = text(projectId, 'projectId', 128);
    let answer: unknown;
    try { answer = await within(this.core.coordination.request(member, 'relay.project', { projectId: id }), RELAY_MS, member.name); }
    catch (error) {
      if (!(error instanceof PeerRefusal)) throw unavailable(`${member.name} did not answer (${messageOf(error)}); open its project while it is on`);
      if (error.message.startsWith('operation:')) throw refused(`${member.name} runs an older Boite; update it to open its projects to a contact`);
      throw invalidParams(`projectId: ${member.name} says ${error.message}`, { field: 'projectId' });
    }
    const name = (answer as { name?: unknown } | null)?.name;
    return { projectId: id, name: text(name, 'project.name', 200) };
  }

  /** The members whose projects are opened to this contact. */
  private holders(contactId: string): CoordinationPeer[] {
    const ids = new Set(this.contacts.find(contactId)?.grants.flatMap(grant => grant.machine ? [grant.machine] : []) ?? []);
    return this.members().filter(member => ids.has(member.coreId));
  }

  /** The member and its own thread id behind an id the contact uses, when that member holds a project opened to it. */
  locate(contactId: string, threadId: unknown): { member: CoordinationPeer; threadId: string } | null {
    if (typeof threadId !== 'string') return null;
    const at = threadId.lastIndexOf(MARK);
    if (at <= 0 || threadId.length - at - 1 !== PREFIX) return null;
    const prefix = threadId.slice(at + 1);
    const member = this.holders(contactId).find(entry => entry.coreId.startsWith(prefix));
    return member ? { member, threadId: threadId.slice(0, at) } : null;
  }

  private entry(contactId: string, memberId: string): RelayedEntry | null {
    const contact = this.contacts.find(contactId);
    if (!contact) return null;
    return {
      coreId: contact.coreId, name: contact.name, minTier: this.contacts.settings().minTier, link: this.contacts.linkOf(contact.coreId),
      offers: contact.offers.map(offer => offer.name),
      grants: contact.grants.filter(grant => grant.machine === memberId).map(grant => ({ projectId: grant.projectId, readThreads: grant.readThreads })),
    };
  }

  /** One request of the contact, answered by the member. A refusal there is the contact's refusal; silence is not. */
  private async ask(member: CoordinationPeer, contactId: string, operation: Operation, payload: unknown): Promise<unknown> {
    const contact = this.entry(contactId, member.coreId);
    if (!contact) throw refused('no longer a contact');
    try { return await within(this.core.coordination.request(member, 'relay.in', { contact, operation, payload }), RELAY_MS, member.name); }
    catch (error) {
      if (error instanceof PeerRefusal) throw refused(error.message);
      throw new Error(messageOf(error));
    }
  }

  /** A member's thread under this core's id. */
  private outward<T extends AgentContact>(entry: T, member: CoordinationPeer): T {
    return { ...entry, coreId: this.selfId(), threadId: memberThreadId(member.coreId, entry.threadId), machine: this.core.info().hostname ?? 'Boite' };
  }

  /** Each holder's threads open to the contact; a member that does not answer just lists none. */
  async directory(contactId: string): Promise<AgentContact[]> {
    const found = await Promise.all(this.holders(contactId).map(async member => {
      try {
        const answer = await this.ask(member, contactId, 'directory', {});
        if (!Array.isArray(answer) || answer.length > 100) throw new Error('invalid directory');
        return answer.map(entry => this.outward(checkRemoteContact(entry as AgentContact, member), member));
      } catch (error) { this.warn(member, error); return []; }
    }));
    return found.flat();
  }

  async search(contactId: string, words: string[]): Promise<AgentContact[]> {
    const found = await Promise.all(this.holders(contactId).map(async member => {
      try {
        const answer = await this.ask(member, contactId, 'search', { words });
        if (!Array.isArray(answer) || answer.length > 100) throw new Error('invalid search');
        return answer.map(match => this.outward({ ...checkRemoteContact(match as AgentContact, member), ...checkMatchExtras(match as { matched?: unknown; excerpts?: unknown }) }, member));
      } catch (error) { this.warn(member, error); return []; }
    }));
    return found.flat();
  }

  async read(contactId: string, at: { member: CoordinationPeer; threadId: string }, payload: { limit?: unknown; before?: unknown }): Promise<unknown> {
    const answer = await this.ask(at.member, contactId, 'read', { threadId: at.threadId, limit: payload.limit, before: payload.before });
    const contact = checkRemoteContact((answer as { contact?: AgentContact } | null)?.contact as AgentContact, at.member);
    if (contact.threadId !== at.threadId) throw new Error('transcript of another thread');
    return { contact: this.outward(contact, at.member), ...checkTranscript(answer) };
  }

  async deliver(contactId: string, at: { member: CoordinationPeer; threadId: string }, letter: AgentLetter): Promise<AgentLetter> {
    const shown = letter.to;
    const answer = await this.ask(at.member, contactId, 'deliver', { ...letter, to: { coreId: at.member.coreId, threadId: at.threadId } }) as AgentLetter | null;
    if (!answer || answer.id !== letter.id) throw new Error('invalid delivery receipt');
    return { ...answer, to: shown, toMachine: this.core.info().hostname ?? 'Boite' };
  }

  /** The receipt of a letter the contact sent a member's thread: the members holding its projects are asked in turn. */
  async receipt(contactId: string, payload: unknown): Promise<AgentLetter> {
    for (const member of this.holders(contactId)) {
      let answer: AgentLetter | null;
      try { answer = await this.ask(member, contactId, 'receipt', payload) as AgentLetter | null; }
      catch { continue; }
      if (!answer || typeof answer !== 'object') continue;
      const to = address(answer.to, 'receipt.to');
      return { ...answer, to: { coreId: this.selfId(), threadId: memberThreadId(member.coreId, to.threadId) }, toMachine: this.core.info().hostname ?? 'Boite' };
    }
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
    if (!RELAYED.includes(operation)) throw invalidParams('relay.operation: expected directory, search, read, deliver or receipt');
    if (!this.contacts.find(contactId)) throw refused('relay.contact: not a contact of this machine any more');
    const peer = this.core.contacts.peers().find(entry => entry.coreId === contactId && !this.core.contacts.isRelayPeer(entry));
    if (!peer) throw refused('relay.contact: not a contact of this machine any more');
    let payload = request?.payload;
    let from: AgentAddress | null = null;
    if (operation === 'deliver') {
      const letter = payload as AgentLetter;
      from = address(letter?.from, 'letter.from');
      if (from.coreId !== member.coreId) throw refused('letter.from: expected a thread of the asking machine');
      payload = { ...letter, from: { ...letter.from, coreId: this.selfId(), threadId: memberThreadId(member.coreId, from.threadId) } };
    } else if (operation === 'receipt') {
      const receipt = payload as { id?: unknown; fromThreadId?: unknown } | null;
      from = { coreId: member.coreId, threadId: text(receipt?.fromThreadId, 'receipt.fromThreadId', 128) };
      payload = { id: receipt?.id, fromThreadId: memberThreadId(member.coreId, from.threadId) };
    }
    let answer: unknown;
    try { answer = await this.core.coordination.request(peer, operation, payload); }
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

  private pendingPush(): Record<string, number> { return (this.core.journal.getSetting(MIRROR_PENDING) as Record<string, number> | undefined) ?? {}; }

  /** These members' copies are behind: each is pushed now and at every flush until it hears. */
  mark(memberIds: Iterable<string>): void {
    const pending = this.pendingPush();
    let changed = false;
    for (const id of memberIds) {
      if (!id) continue;
      pending[id] = (pending[id] ?? 0) + 1;
      changed = true;
    }
    if (!changed) return;
    this.core.journal.setSetting(MIRROR_PENDING, pending);
    this.push();
  }

  /** The members that hold this contact's projects. */
  holdersOf(contactId: string): string[] {
    return [...new Set(this.contacts.find(contactId)?.grants.flatMap(grant => grant.machine ? [grant.machine] : []) ?? [])];
  }

  /** Every member's copy that is behind, once each. */
  push(): void {
    if (this.closed) return;
    const members = this.members();
    const pending = this.pendingPush();
    for (const memberId of Object.keys(pending)) {
      const member = members.find(entry => entry.coreId === memberId);
      // A machine that left the group has nothing to keep.
      if (!member) { this.settle(memberId, pending[memberId]!); continue; }
      if (this.pushing.has(memberId)) continue;
      this.pushing.add(memberId);
      const job = this.tell(member, pending[memberId]!).finally(() => this.pushing.delete(memberId));
      this.pending.add(job);
      void job.catch(error => { if (!this.closed) this.core.log('warn', `contacts: ${member.name} did not take its copy of the contacts (${messageOf(error)})`, { source: 'contacts' }); })
        .finally(() => this.pending.delete(job));
    }
  }

  private async tell(member: CoordinationPeer, version: number): Promise<void> {
    const contacts = this.contacts.list().flatMap(contact => contact.grants.some(grant => grant.machine === member.coreId) ? [this.entry(contact.coreId, member.coreId)!] : []);
    try { await within(this.core.coordination.request(member, 'relay.mirror', { contacts }), RELAY_MS, member.name); }
    catch (error) { if (!(error instanceof PeerRefusal)) throw error; }
    this.settle(member.coreId, version);
  }

  private settle(memberId: string, version: number): void {
    const pending = this.pendingPush();
    if (pending[memberId] !== version) return;
    delete pending[memberId];
    this.core.journal.setSetting(MIRROR_PENDING, pending);
  }

  // -- The member's side.

  private stored(): RelayedContact[] { return (this.core.journal.getSetting(MIRROR) as RelayedContact[] | undefined) ?? []; }
  /** The copies kept for members still in the group: one that left, or a group this core left, reaches nothing. */
  relayed(): RelayedContact[] {
    const stored = this.stored();
    if (stored.length === 0) return stored;
    const members = new Set(this.members().map(peer => peer.coreId));
    return stored.filter(entry => members.has(entry.via));
  }
  /** The copies of this contact, one for each member it is linked to. */
  relayedOf(coreId: string): RelayedContact[] { return this.relayed().filter(entry => entry.coreId === coreId); }

  /** The member a relayed contact is reached through. */
  via(coreId: string): CoordinationPeer | null {
    const entry = this.relayedOf(coreId)[0];
    return entry ? this.members().find(peer => peer.coreId === entry.via) ?? null : null;
  }

  /** A request of this core's agent for a relayed contact, sent through the member it is linked to. */
  async send(via: CoordinationPeer, contactId: string, operation: Operation, payload: unknown): Promise<unknown> {
    if (!RELAYED.includes(operation)) throw refused(`${operation}: ask from ${via.name}, the machine linked to that contact`);
    return this.core.coordination.request(via, 'relay.out', { contact: contactId, operation, payload });
  }

  private checkEntry(value: unknown, field: string): RelayedEntry {
    const raw = value as Partial<RelayedEntry> | null;
    if (!raw || typeof raw !== 'object') throw invalidParams(`${field}: expected a contact`);
    if (!Array.isArray(raw.grants) || raw.grants.length > 256) throw invalidParams(`${field}.grants: expected up to 256 projects`);
    if (!Array.isArray(raw.offers) || raw.offers.length > 256) throw invalidParams(`${field}.offers: expected up to 256 names`);
    if (!['connected', 'connecting', 'offline'].includes(raw.link as string)) throw invalidParams(`${field}.link: expected connected, connecting or offline`);
    return {
      coreId: text(raw.coreId, `${field}.coreId`, 100), name: text(raw.name, `${field}.name`, 100), minTier: checkTier(raw.minTier, `${field}.minTier`), link: raw.link!,
      offers: raw.offers.map((name, index) => text(name, `${field}.offers[${index}]`, 200)),
      grants: raw.grants.map((grant, index) => {
        if (typeof grant?.readThreads !== 'boolean') throw invalidParams(`${field}.grants[${index}].readThreads: expected a boolean`);
        return { projectId: text(grant.projectId, `${field}.grants[${index}].projectId`, 128), readThreads: grant.readThreads };
      }),
    };
  }

  /** The member names one of its projects for a grant (`relay.project`). */
  projectFor(payload: unknown): { name: string } {
    const projectId = text((payload as { projectId?: unknown } | null)?.projectId, 'projectId', 128);
    const project = this.core.journal.getProject(projectId);
    if (!project || project.archived || project.kind === 'drafts') throw refused(`no unarchived project ${projectId}`);
    return { name: project.name.slice(0, 200) };
  }

  /** The whole copy `via` keeps of its contacts for this core (`relay.mirror`). */
  mirrored(via: string, payload: unknown): { ok: true } {
    const list = (payload as { contacts?: unknown } | null)?.contacts;
    if (!Array.isArray(list) || list.length > 32) throw invalidParams('mirror.contacts: expected up to 32 contacts');
    this.replace(via, list.map((entry, index) => this.checkEntry(entry, `mirror.contacts[${index}]`)), true);
    return { ok: true };
  }

  /** The copy a relayed request carries (`relay.in`): the contact as it stands now. */
  adopt(via: string, value: unknown): RelayedEntry {
    const entry = this.checkEntry(value, 'relay.contact');
    this.replace(via, [entry], false);
    return entry;
  }

  /** `whole`: `entries` are every contact of `via`, so the others are gone. */
  private replace(via: string, entries: RelayedEntry[], whole: boolean): void {
    const before = this.stored();
    const kept = before.filter(entry => entry.via !== via || (!whole && !entries.some(next => next.coreId === entry.coreId)));
    const next = [...kept, ...entries.filter(entry => entry.grants.length > 0).map(entry => ({ ...entry, via }))];
    if (JSON.stringify(before) === JSON.stringify(next)) return;
    this.core.journal.setSetting(MIRROR, next);
    this.contacts.reset();
    // What the member no longer opens: its replies end and its letters go nowhere.
    for (const old of before.filter(entry => entry.via === via)) {
      const now = next.find(entry => entry.via === via && entry.coreId === old.coreId);
      if (!now) { if (whole || entries.some(entry => entry.coreId === old.coreId)) this.contacts.projectsClosed(old.coreId, null); continue; }
      const dropped = old.grants.filter(grant => !now.grants.some(kept => kept.projectId === grant.projectId)).map(grant => grant.projectId);
      if (dropped.length > 0) this.contacts.projectsClosed(old.coreId, dropped);
    }
  }

  private warn(member: CoordinationPeer, error: unknown): void {
    if (!this.closed) this.core.log('info', `contacts: ${member.name} did not answer for a contact (${messageOf(error)})`, { source: 'contacts' });
  }

  beginClose(): void { this.closed = true; }
  settled(): Promise<unknown> { return Promise.allSettled([...this.pending]); }
}

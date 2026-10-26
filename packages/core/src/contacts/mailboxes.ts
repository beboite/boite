/**
 * A group member may carry its own contact traffic for another member's
 * conversation. The external contact sees a virtual mailbox on its known
 * core; the initiating conversation keeps the actual letters and delivery.
 * Mailboxes never own a provider, a token, or a real conversation.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { AgentContact, AgentLetter, ContactRequest, CoordinationPeer, RpcParams, RpcResult } from '@boite/contracts';
import type { Core } from '../core.ts';
import { checkRemoteContact, checkTranscript, checkMatchExtras } from '../coordination-lookup.ts';
import { address, LETTER_TTL_MS, RESIDENT_LETTER_TTL_MS, same, text } from '../coordination-letter.ts';
import { PeerRefusal, type Operation } from '../coordination-wire.ts';
import { refused, unavailable, messageOf, RpcFailure } from '../errors.ts';
import { REPLY_WINDOW_MS } from './reach.ts';
import { checkNormalizedRemote, gitRemoteOf } from './git-remote.ts';

type ContactSummary = RpcResult<'collaboration.contacts'>[number];
interface SourceRoute { threadId: string; coreId: string; via: string; name: string; stamp: string; admission: number }
interface Mailbox { id: string; source: AgentContact; coreId: string; name: string; contactAt: number; stamp: string; sentAt: number; notified?: boolean }
interface StoredLetter { mailbox: string; direction: string; wire: AgentLetter; canonical: AgentLetter; fingerprint: string; route?: SourceRoute }
interface Row { mailbox: string; direction: string; data: string }
const SOURCES = 'contacts:source-routes';
const MAILBOXES = 'contacts:mailboxes';
const PREFIX = 'cmb_';

export class ContactMailboxes {
  private initialized = false;
  private closed = false;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly busy = new Set<string>();
  private readonly attempts = new Map<string, number>();
  private readonly off: () => void;
  private prunedAt = 0;

  constructor(private readonly core: Core) {
    this.off = core.bus.onAny(name => {
      if (name === 'contacts.updated' || name === 'group.updated') queueMicrotask(() => this.tick());
    });
  }

  private self(): string { return this.core.coordination.card().coreId; }
  private sources(): SourceRoute[] { return this.core.journal.getSetting(SOURCES) as SourceRoute[] ?? []; }
  private mailboxes(): Mailbox[] { return this.core.journal.getSetting(MAILBOXES) as Mailbox[] ?? []; }
  private member(coreId: string): CoordinationPeer {
    const peer = this.core.group.peers().find(entry => entry.coreId === coreId);
    if (!peer) throw refused('route: expected a current member of this owner\'s group');
    return peer;
  }
  private stamp(coreId: string): string {
    this.member(coreId);
    const group = this.core.group.view('owner')!;
    return JSON.stringify([group.id, group.cores.find(entry => entry.coreId === group.self)?.epoch, group.cores.find(entry => entry.coreId === coreId)?.epoch]);
  }
  private source(threadId: string, sending = false): AgentContact {
    this.core.coordination.checkLookupAccess(threadId, true);
    const from = this.core.coordination.describe(threadId);
    const config = this.core.coordination.config(threadId);
    if (sending && config.paused) throw refused('coordination paused by the owner');
    return from;
  }
  private contact(coreId: string): CoordinationPeer {
    const peer = this.core.contacts.peers().find(entry => entry.coreId === coreId);
    if (!peer) throw refused('route.contact: expected a contact of this gateway');
    return peer;
  }
  private remember(threadId: string, via: string, contact: ContactSummary, admission: number): SourceRoute {
    const routes = this.sources();
    const route: SourceRoute = { threadId, coreId: contact.coreId, via, name: contact.name, stamp: this.stamp(via), admission };
    this.core.journal.setSetting(SOURCES, [...routes.filter(entry => entry.threadId !== threadId || entry.coreId !== contact.coreId), route]);
    return route;
  }
  route(threadId: string, coreId: string): SourceRoute | undefined {
    const found = this.sources().find(entry => entry.threadId === threadId && entry.coreId === coreId);
    if (!found) return undefined;
    try { return found.stamp === this.stamp(found.via) ? found : undefined; } catch { return undefined; }
  }
  async contacts(threadId: string): Promise<RpcResult<'collaboration.contacts'>> {
    const local = this.core.contacts.forThread(threadId);
    const config = this.core.coordination.config(threadId);
    if (config.mode === 'off' || !config.remote) return [];
    const from = this.source(threadId);
    const replies = await Promise.all(this.core.group.peers().sort((a, b) => a.coreId.localeCompare(b.coreId)).map(async peer => {
      try {
        const stamp = this.stamp(peer.coreId);
        const contacts = await this.core.coordination.request(peer, 'contact.route', { action: 'contacts', from }) as (ContactSummary & { admission: number })[];
        if (!Array.isArray(contacts) || contacts.length > 32 || this.stamp(peer.coreId) !== stamp) return [];
        return contacts.map(contact => {
          if (!Number.isSafeInteger(contact.admission) || !['connected', 'connecting', 'offline'].includes(contact.link)) throw refused('route.contact: expected its admission and link state');
          return { via: peer.coreId, admission: contact.admission, contact: { coreId: text(contact.coreId, 'route.contact.coreId', 100), name: text(contact.name, 'route.contact.name', 200), projects: Array.isArray(contact.projects) ? contact.projects.filter(name => typeof name === 'string').slice(0, 256) : [], link: contact.link } };
        });
      } catch { return []; }
    }));
    this.source(threadId);
    const result = [...local];
    const offered = replies.flat();
    for (const { via, contact, admission } of offered) {
      // A contact that opened this core's projects through that member is listed already, and still asked through a mailbox.
      const relayed = this.core.coordination.trusted().find(peer => peer.coreId === contact.coreId);
      if (contact.coreId === this.self() || (relayed && !this.core.contacts.isRelayPeer(relayed))) continue;
      // Each listing refreshes the route's admission; another gateway replaces it only once its own stops offering the contact.
      const existing = this.route(threadId, contact.coreId);
      if (existing && existing.via !== via && offered.some(entry => entry.via === existing.via && entry.contact.coreId === contact.coreId)) continue;
      this.remember(threadId, via, contact, admission);
      if (!result.some(entry => entry.coreId === contact.coreId)) result.push(contact);
    }
    return result;
  }
  async resolve(threadId: string, coreId: string): Promise<SourceRoute | undefined> {
    let route = this.route(threadId, coreId);
    if (!route) { await this.contacts(threadId); route = this.route(threadId, coreId); }
    return route;
  }
  private async request(route: SourceRoute, body: Record<string, unknown>): Promise<unknown> {
    if (route.stamp !== this.stamp(route.via)) throw refused('route: group admission changed');
    const answer = await this.core.coordination.request(this.member(route.via), 'contact.route', { ...body, admission: route.admission });
    if (route.stamp !== this.stamp(route.via)) throw refused('route: group admission changed');
    return answer;
  }
  async directory(threadId: string): Promise<AgentContact[]> {
    const local = new Set(this.core.coordination.trusted().map(peer => peer.coreId));
    const contacts = await this.contacts(threadId);
    const from = this.source(threadId);
    const results = await Promise.all(contacts.filter(contact => !local.has(contact.coreId)).map(async contact => {
      const route = this.route(threadId, contact.coreId)!;
      try {
        const entries = await this.request(route, { action: 'lookup', from, coreId: contact.coreId, operation: 'directory', payload: {} }) as AgentContact[];
        if (!Array.isArray(entries) || entries.length > 100) return [];
        return entries.map(entry => checkRemoteContact(entry, { coreId: contact.coreId, name: contact.name, url: '', publicKey: '' }));
      } catch { return []; }
    }));
    this.source(threadId);
    return results.flat();
  }
  async read(threadId: string, coreId: string, payload: unknown): Promise<RpcResult<'collaboration.read'>> {
    const route = await this.resolve(threadId, coreId);
    if (!route) throw refused('destination machine is not trusted for coordination');
    const result = await this.request(route, { action: 'lookup', from: this.source(threadId), coreId, operation: 'read', payload }) as RpcResult<'collaboration.read'>;
    this.source(threadId);
    const contact = checkRemoteContact(result.contact, { coreId, name: route.name, url: '', publicKey: '' });
    if (contact.threadId !== (payload as { threadId: string }).threadId) throw refused('transcript of another thread');
    return { contact, ...checkTranscript(result) };
  }
  async search(threadId: string, words: string[]): Promise<RpcResult<'collaboration.search'>['matches']> {
    const contacts = await this.contacts(threadId);
    const direct = new Set(this.core.coordination.trusted().map(peer => peer.coreId));
    const results = await Promise.all(contacts.filter(contact => !direct.has(contact.coreId) && this.route(threadId, contact.coreId)).map(async contact => {
      const route = this.route(threadId, contact.coreId)!;
      try {
        const entries = await this.request(route, { action: 'lookup', from: this.source(threadId), coreId: contact.coreId, operation: 'search', payload: { words } }) as RpcResult<'collaboration.search'>['matches'];
        if (!Array.isArray(entries) || entries.length > 100) return [];
        return entries.map(entry => ({ ...checkRemoteContact(entry, { coreId: contact.coreId, name: contact.name, url: '', publicKey: '' }), ...checkMatchExtras(entry) }));
      } catch { return []; }
    }));
    this.source(threadId);
    return results.flat();
  }
  async relay(letter: AgentLetter): Promise<AgentLetter> {
    const route = this.route(letter.from.threadId, letter.to.coreId);
    if (!route) throw refused('route: the group contact route is no longer available');
    const from = this.source(letter.from.threadId, letter.status === 'queued');
    try { this.core.contacts.reach.checkSendTier(letter.from.threadId); }
    catch (error) { throw new PeerRefusal(messageOf(error)); }
    const answer = await this.request(route, { action: 'deliver', from, letter, receipt: letter.status !== 'queued' }) as AgentLetter | { retry: true };
    if ('retry' in answer) throw unavailable('The contact is unreachable; retrying until expiry');
    return answer;
  }
  mayReceive(letter: AgentLetter): boolean | null {
    const provenance = this.rows("id = ? AND direction = 'source'", letter.id)[0]?.route;
    if (!provenance) return null;
    const route = this.route(letter.to.threadId, letter.from.coreId);
    return route !== undefined && route.via === provenance.via && route.stamp === provenance.stamp && route.admission === provenance.admission;
  }

  private revokeSource(route: SourceRoute, reason: string): void {
    this.core.journal.setSetting(SOURCES, this.sources().filter(entry => entry.threadId !== route.threadId || entry.coreId !== route.coreId || entry.via !== route.via));
    this.core.coordination.rejectRoutedLetters(route.threadId, route.coreId, reason);
  }

  async ask(params: RpcParams<'collaboration.ask'>): Promise<ContactRequest> {
    const input = text(params.contact, 'contact', 200);
    const local = this.core.contacts.list().some(contact => contact.coreId === input || contact.name.toLowerCase() === input.toLowerCase() || contact.name.replace(/\s+/g, '-').toLowerCase() === input.toLowerCase());
    if (local) return this.core.contacts.ask(params);
    const contacts = await this.contacts(params.threadId);
    const wanted = input.toLowerCase();
    const found = contacts.filter(contact => contact.coreId === input || contact.name.toLowerCase() === wanted || contact.name.replace(/\s+/g, '-').toLowerCase() === wanted);
    if (found.length !== 1) throw refused('contact: expected one unambiguous contact from boite threads contacts');
    const route = this.route(params.threadId, found[0]!.coreId);
    if (!route) throw refused('route: the group contact route is no longer available');
    const from = this.source(params.threadId, true);
    this.core.contacts.reach.checkSendTier(params.threadId);
    const gitRemote = gitRemoteOf(this.core.threads.require(params.threadId).cwd);
    const answer = await this.request(route, { action: 'ask', from, coreId: route.coreId, id: randomUUID(), text: text(params.text, 'text'), ...(gitRemote ? { gitRemote } : {}) }) as ContactRequest;
    this.source(params.threadId);
    return { ...answer, from, coreId: route.coreId, contact: route.name };
  }

  /** Only a sealed request from a current group member reaches this handler. */
  async handle(peer: CoordinationPeer, payload: unknown): Promise<unknown> {
    this.member(peer.coreId);
    const p = payload as { action?: string; from?: AgentContact; coreId?: string; operation?: Operation; payload?: unknown; letter?: AgentLetter; receipt?: boolean; id?: string; text?: string; gitRemote?: string; admission?: number };
    if (p?.action === 'revoke') {
      const route = this.route(text(p.id, 'route.threadId', 128), text(p.coreId, 'route.coreId', 100));
      if (route?.via === peer.coreId && route.admission === p.admission) this.revokeSource(route, 'The gateway contact route was revoked');
      return { ok: true };
    }
    if (p?.action === 'return') {
      const letter = p.letter!;
      const route = this.route(address(letter.to, 'letter.to').threadId, address(letter.from, 'letter.from').coreId);
      if (!route || route.via !== peer.coreId || route.admission !== p.admission || letter.to.coreId !== this.self()) throw refused('route: no matching initiating conversation');
      const stored = this.store(route.via, 'source', letter, letter);
      this.save({ ...stored, route });
      return this.core.coordination.receiveRouted(letter, route.name);
    }
    const from = checkRemoteContact(p?.from as AgentContact, peer);
    if (p.action === 'contacts') return this.core.contacts.available().map(contact => ({ ...contact, admission: this.core.contacts.find(contact.coreId)!.addedAt }));
    const contactId = p.action === 'deliver' ? address(p.letter?.to as AgentContact, 'letter.to').coreId : text(p.coreId, 'route.coreId', 100);
    if (this.core.contacts.find(contactId)?.addedAt !== p.admission) throw refused('route: the gateway contact admission changed; discover its contacts again');
    if (p.action === 'lookup') {
      const contact = this.contact(text(p.coreId, 'route.coreId', 100));
      if (!['directory', 'search', 'read'].includes(p.operation ?? '')) throw refused('route.operation: expected directory, search or read');
      const stamp = this.stamp(peer.coreId);
      const addedAt = this.core.contacts.find(contact.coreId)!.addedAt;
      let answer: unknown;
      try { answer = await this.core.coordination.request(contact, p.operation!, p.payload); }
      catch (error) { if (error instanceof PeerRefusal) throw refused(error.message); throw error; }
      if (this.stamp(peer.coreId) !== stamp || this.core.contacts.find(contact.coreId)?.addedAt !== addedAt) throw refused('route: group admission or contact changed during lookup');
      return answer;
    }
    if (p.action === 'ask') {
      this.core.contacts.reach.checkAttestedTier(from.agent);
      const contact = this.contact(text(p.coreId, 'route.coreId', 100));
      const box = this.mailbox(from, contact);
      const id = text(p.id, 'route.ask.id', 100);
      const asks = this.core.journal.getSetting('contacts:mailbox-asks') as Record<string, ContactRequest> ?? {};
      const key = `${box.id}/${id}`;
      if (asks[key]) return asks[key];
      const request = this.core.contacts.askFrom({ ...from, coreId: this.self(), threadId: box.id }, contact.coreId, text(p.text, 'route.ask.text'), p.gitRemote === undefined ? undefined : checkNormalizedRemote(p.gitRemote, 'route.ask.gitRemote'));
      this.core.journal.setSetting('contacts:mailbox-asks', { ...asks, [key]: request });
      return request;
    }
    if (p.action !== 'deliver') throw refused('route.action: expected contacts, lookup, ask, deliver or return');
    const canonical = p.letter!;
    if (!same(address(canonical.from, 'letter.from'), from)) throw refused('letter.from: expected the authenticated initiating conversation');
    this.core.contacts.reach.checkAttestedTier(from.agent);
    this.timestamps(canonical, LETTER_TTL_MS);
    const contact = this.contact(address(canonical.to, 'letter.to').coreId);
    const box = this.mailbox(from, contact, canonical.createdAt);
    const wire: AgentLetter = { ...canonical, from: { ...from, coreId: this.self(), threadId: box.id }, contact: { coreId: contact.coreId, name: contact.name } };
    const stored = this.store(box.id, 'out', wire, canonical);
    const currentWire = { ...stored.wire, from: wire.from };
    let answer: AgentLetter;
    try { answer = await this.core.coordination.request(contact, p.receipt ? 'receipt' : 'deliver', p.receipt ? { id: wire.id, fromThreadId: box.id } : currentWire) as AgentLetter; }
    catch (error) {
      if (error instanceof PeerRefusal) throw refused(error.message);
      return { retry: true };
    }
    this.valid(box);
    if (!answer || answer.id !== wire.id || !same(answer.from, wire.from) || !same(answer.to, wire.to)) throw refused('route: invalid delivery receipt');
    this.save({ ...stored, wire: answer });
    return { ...answer, from: canonical.from, to: canonical.to };
  }

  private mailbox(source: AgentContact, contact: CoordinationPeer, sentAt = Date.now()): Mailbox {
    const boxes = this.mailboxes();
    const stamp = this.stamp(source.coreId);
    const contactAt = this.core.contacts.find(contact.coreId)!.addedAt;
    const existing = boxes.find(box => box.source.coreId === source.coreId && box.source.threadId === source.threadId && box.coreId === contact.coreId && box.stamp === stamp && box.contactAt === contactAt);
    const box: Mailbox = { id: existing?.id ?? `${PREFIX}${randomUUID()}`, source, coreId: contact.coreId, name: contact.name, contactAt, stamp, sentAt: Math.max(existing?.sentAt ?? 0, sentAt) };
    this.core.journal.setSetting(MAILBOXES, [...boxes.filter(entry => entry.id !== box.id), box]);
    return box;
  }
  private valid(box: Mailbox): void {
    this.admitted(box);
    if (Date.now() - box.sentAt > REPLY_WINDOW_MS) throw refused('route: contact reply window ended');
  }
  private admitted(box: Mailbox): void {
    if (box.stamp !== this.stamp(box.source.coreId) || this.core.contacts.find(box.coreId)?.addedAt !== box.contactAt) throw refused('route: mailbox admission ended');
  }
  answer(request: ContactRequest, name: string, body: string): boolean {
    if (!request.from.threadId.startsWith(PREFIX)) return false;
    const box = this.mailboxes().find(entry => entry.id === request.from.threadId && entry.coreId === request.coreId);
    if (!box) return true;
    try { this.valid(box); } catch { return true; }
    const now = Date.now();
    const wire: AgentLetter = { id: randomUUID(), origin: 'contact', from: { coreId: box.coreId, threadId: request.id, title: `Answer to your request to ${name}`.slice(0, 200), machine: name, resources: '', status: 'idle', mode: 'brief' }, to: { coreId: this.self(), threadId: box.id }, toTitle: box.source.title, text: body, replyTo: null, createdAt: now, expiresAt: now + RESIDENT_LETTER_TTL_MS, status: 'received', error: null, contact: { coreId: box.coreId, name } };
    this.store(box.id, 'in', wire, { ...wire, to: { coreId: box.source.coreId, threadId: box.source.threadId } });
    queueMicrotask(() => this.tick());
    return true;
  }
  receive(letter: AgentLetter, peer: CoordinationPeer): AgentLetter | null {
    if (typeof letter?.to?.threadId !== 'string' || !letter.to.threadId.startsWith(PREFIX)) return null;
    const box = this.mailboxes().find(entry => entry.id === letter.to.threadId && entry.coreId === peer.coreId);
    if (!box || letter.to.coreId !== this.self()) throw refused('letter.to: unknown contact mailbox');
    this.valid(box);
    const from = checkRemoteContact(letter.from, this.contact(peer.coreId));
    this.core.contacts.reach.checkAttestedTier(from.agent);
    this.timestamps(letter, LETTER_TTL_MS);
    if (letter.replyTo !== null && !this.rows("mailbox = ? AND direction = 'out' AND id = ?", box.id, letter.replyTo).length) throw refused('replyTo: expected a letter sent from this contact mailbox');
    const accepted: AgentLetter = { ...letter, from, text: text(letter.text, 'letter.text'), status: 'received', error: null, contact: { coreId: box.coreId, name: box.name } };
    delete accepted.origin;
    const canonical = { ...accepted, to: { coreId: box.source.coreId, threadId: box.source.threadId }, toTitle: box.source.title, toProject: box.source.project, toMachine: box.source.machine };
    const stored = this.store(box.id, 'in', accepted, canonical);
    queueMicrotask(() => this.tick());
    return stored.wire;
  }
  received(id: string): AgentLetter | null { return this.rows("id = ? AND direction = 'in'", id)[0]?.wire ?? null; }
  private timestamps(letter: AgentLetter, ttl: number): void {
    text(letter.id, 'letter.id', 100);
    if (!Number.isSafeInteger(letter.createdAt) || !Number.isSafeInteger(letter.expiresAt) || letter.createdAt > Date.now() + 60_000 || letter.expiresAt <= Date.now() || letter.expiresAt > letter.createdAt + ttl) throw refused('message expired or timestamps invalid');
  }
  private init(): void {
    if (this.initialized) return;
    this.core.journal.db.exec('CREATE TABLE IF NOT EXISTS contact_route_letters (id TEXT NOT NULL, mailbox TEXT NOT NULL, direction TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(id, mailbox, direction))');
    this.core.journal.db.exec("CREATE INDEX IF NOT EXISTS contact_route_pending ON contact_route_letters(direction, json_extract(data, '$.wire.status'))");
    this.initialized = true;
  }
  private rows(where = '1 = 1', ...params: (string | number)[]): StoredLetter[] {
    this.init();
    return (this.core.journal.db.query(`SELECT mailbox, direction, data FROM contact_route_letters WHERE ${where}`).all(...params) as Row[]).map(row => JSON.parse(row.data) as StoredLetter);
  }
  private save(letter: StoredLetter): void {
    this.init();
    this.core.journal.db.query('INSERT OR REPLACE INTO contact_route_letters VALUES (?, ?, ?, ?)').run(letter.wire.id, letter.mailbox, letter.direction, JSON.stringify(letter));
  }
  private store(mailbox: string, direction: string, wire: AgentLetter, canonical: AgentLetter): StoredLetter {
    const fingerprint = createHash('sha256').update(JSON.stringify([wire.id, wire.from.coreId, wire.from.threadId, wire.to, wire.text, wire.replyTo])).digest('hex');
    const existing = this.rows('mailbox = ? AND direction = ? AND id = ?', mailbox, direction, wire.id)[0];
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw refused('message id already used for different content');
      return existing;
    }
    const stored = { mailbox, direction, wire, canonical, fingerprint };
    this.save(stored);
    return stored;
  }
  tick(): void {
    if (this.closed) return;
    if (this.initialized && Date.now() - this.prunedAt > 3_600_000) {
      this.prunedAt = Date.now();
      this.core.journal.db.query("DELETE FROM contact_route_letters WHERE json_extract(data, '$.wire.createdAt') < ?").run(Date.now() - 30 * 24 * 3_600_000);
    }
    for (const route of this.sources()) if (!this.route(route.threadId, route.coreId)) this.revokeSource(route, 'The group contact route was revoked');
    for (const box of this.mailboxes()) {
      if (box.notified || this.busy.has(box.id)) continue;
      try { this.admitted(box); continue; } catch { /* Invalidated mail is withdrawn from its actual conversation too. */ }
      this.busy.add(box.id);
      const job = this.revokeMailbox(box).finally(() => { this.busy.delete(box.id); this.pending.delete(job); });
      this.pending.add(job);
    }
    if (!this.mailboxes().length) return;
    // A queued provider wake can return an uncertain receipt; refresh it until settled.
    const letters = this.rows("direction = 'in' AND json_extract(data, '$.wire.status') IN ('received', 'uncertain') ORDER BY json_extract(data, '$.wire.createdAt')");
    const ids = new Set(letters.map(letter => letter.wire.id));
    for (const id of this.attempts.keys()) if (!ids.has(id)) this.attempts.delete(id);
    // Pending receipts must not keep newer replies behind the same oldest batch.
    const next = letters.sort((a, b) => (this.attempts.get(a.wire.id) ?? 0) - (this.attempts.get(b.wire.id) ?? 0)).slice(0, 4 + this.busy.size);
    for (const letter of next) {
      if (this.busy.has(letter.wire.id)) continue;
      this.attempts.set(letter.wire.id, performance.now());
      this.busy.add(letter.wire.id);
      const job = this.forward(letter).finally(() => { this.busy.delete(letter.wire.id); this.pending.delete(job); });
      this.pending.add(job);
    }
  }
  private async revokeMailbox(box: Mailbox): Promise<void> {
    try {
      await this.core.coordination.request(this.member(box.source.coreId), 'contact.route', { action: 'revoke', id: box.source.threadId, coreId: box.coreId, admission: box.contactAt });
      if (!this.closed) this.core.journal.setSetting(MAILBOXES, this.mailboxes().map(entry => entry.id === box.id ? { ...entry, notified: true } : entry));
    } catch { /* The durable mailbox retries notification while its source is offline. */ }
  }
  private async forward(letter: StoredLetter): Promise<void> {
    try {
      const box = this.mailboxes().find(entry => entry.id === letter.mailbox);
      if (!box) throw refused('route: mailbox removed');
      this.valid(box);
      if (letter.wire.expiresAt <= Date.now()) { this.save({ ...letter, wire: { ...letter.wire, status: 'expired' } }); return; }
      const answer = await this.core.coordination.request(this.member(box.source.coreId), 'contact.route', { action: 'return', letter: letter.canonical, admission: box.contactAt }) as AgentLetter;
      if (this.closed) return;
      this.valid(box);
      if (!answer || answer.id !== letter.wire.id || !same(answer.from, letter.canonical.from) || !same(answer.to, letter.canonical.to)) throw refused('route: invalid initiating conversation receipt');
      this.save({ ...letter, wire: { ...letter.wire, status: answer.status, error: answer.error } });
    } catch (error) {
      if (!this.closed && (error instanceof PeerRefusal || error instanceof RpcFailure)) this.save({ ...letter, wire: { ...letter.wire, status: 'rejected', error: messageOf(error) } });
    }
  }
  beginClose(): void { if (!this.closed) { this.closed = true; this.off(); } }
  async close(): Promise<void> { this.beginClose(); await Promise.allSettled(this.pending); }
}

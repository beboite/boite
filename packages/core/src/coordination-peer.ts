/*
 * The answering side of coordination: a request another core signed is
 * checked (signature, seal, time, nonce, rate) and answered with what that
 * core may reach. A machine of the group, a hand-made link and a contact each
 * reach their own part; `coordination.ts` asks, this file answers.
 */
import { verify } from 'node:crypto';
import type { AgentContact, AgentLetter, CoordinationPeer } from '@boite/contracts';
import { text } from './coordination-letter.ts';
import { checkRemoteContact, searchContacts, searchWords, transcript } from './coordination-lookup.ts';
import { boundedBody, BOT_OPERATIONS, type BotOperation, type Envelope } from './coordination-wire.ts';
import { pack, SEALED, sealResponse, unpack, type Sealing } from './group/seal.ts';
import type { Core } from './core.ts';
import { invalidParams, refused, RpcFailure } from './errors.ts';
import { receiveProject } from './contacts/project-relay.ts';
import { redactSharedText, redactSharedContact } from './contacts/file-policy.ts';
import { machineSettingChanged, readMachineSetting } from './threads/group-spawn.ts';
import { policedRoutes } from './coordination-group.ts';

/** What the desk reads of the coordination it answers for. */
export interface PeerSide {
  closed(): boolean;
  selfId(): string;
  trusted(): CoordinationPeer[];
  peers(): CoordinationPeer[];
  signature(input: Buffer): Buffer;
  /** This core's threads open to other machines. */
  directory(): AgentContact[];
  /** The threads of the projects opened to that contact. */
  contactDirectory(coreId: string): AgentContact[];
  receive(letter: AgentLetter, peer: CoordinationPeer): AgentLetter;
  /** A letter this core received, by id. */
  received(id: string): AgentLetter | null;
}

/** A transcript request, checked field by field. */
function readParams(value: unknown): { threadId: string; limit: number; before: number | undefined } {
  const payload = value as { threadId?: unknown; limit?: unknown; before?: unknown } | null;
  const threadId = text(payload?.threadId, 'read.threadId', 128);
  const limit = payload?.limit === undefined ? 30 : payload.limit;
  if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 100) throw invalidParams('read.limit: expected 1 to 100');
  if (payload?.before !== undefined && !Number.isSafeInteger(payload.before)) throw invalidParams('read.before: expected a timestamp');
  return { threadId, limit: limit as number, before: payload?.before as number | undefined };
}

export class PeerDesk {
  /** Request nonces seen in the last two minutes, by sender. */
  private readonly nonces = new Map<string, number>();
  private readonly rates = new Map<string, { since: number; count: number; floor?: number }>();

  constructor(private readonly core: Core, private readonly side: PeerSide) {}

  async http(request: Request): Promise<Response> {
    if (this.side.closed() || request.method !== 'POST' || request.headers.has('origin')) return new Response('forbidden', { status: 403 });
    const id = request.headers.get('x-boite-peer');
    // A machine its group removed still signs with a key this core knows, so it can be told and leave.
    const known = this.side.trusted().find(p => p.coreId === id);
    // A contact another member holds never speaks to this core itself: that member does, for it.
    const peer = (known && !this.core.contacts.isRelayPeer(known) ? known : undefined) ?? this.core.group.removedPeer(id);
    if (!peer) return new Response('unknown peer', { status: 403 });
    // These HTTP requests bypass the owner RPC gate, including ones carried by an existing link.
    try { policedRoutes(this.core, peer); }
    catch { return new Response('forbidden', { status: 403 }); }
    let envelope: Envelope;
    let sealing: Sealing | null = null;
    try {
      let raw = await boundedBody(request.body);
      const now = Date.now(); // once the body is in: a request held open is not judged by the time it began
      let signature = request.headers.get('x-boite-signature') ?? '';
      if (signature === SEALED) {
        const opened = this.core.group.unseal(raw, peer.coreId);
        sealing = { responseKey: opened.responseKey, context: opened.context };
        ({ body: raw, signature } = unpack(opened.plaintext));
      }
      if (!verify(null, Buffer.from(raw), peer.publicKey, Buffer.from(signature, 'base64'))) throw new Error('invalid signature');
      envelope = JSON.parse(raw) as Envelope;
      if (envelope.from !== peer.coreId || envelope.to !== this.side.selfId() || !Number.isSafeInteger(envelope.at) || Math.abs(now - envelope.at) > 60_000) throw new Error('invalid envelope');
      text(envelope.nonce, 'nonce', 100);
      text(envelope.operation, 'operation', 64);
      for (const [id, at] of this.nonces) if (now - at > 120_000) this.nonces.delete(id);
      const key = `${peer.coreId}:${envelope.nonce}`;
      if (this.nonces.has(key)) throw new Error('replayed request');
      const rate = this.rates.get(peer.coreId) ?? { since: now, count: 0 };
      if (envelope.at <= (rate.floor ?? 0)) throw new Error('replayed request');
      if (now - rate.since > 60_000) { rate.since = now; rate.count = 0; }
      this.rates.set(peer.coreId, rate);
      // Remembered before the quota decides, so a request recorded and sent again never spends the member's allowance, in this minute or,
      // turned away here, in the next. Up to three times the quota by name; past that by date, nothing as old being taken again: bounded either way.
      if (++rate.count <= 360) this.nonces.set(key, now);
      else rate.floor = Math.max(rate.floor ?? 0, envelope.at);
      // A member that sent a signed request is up, even past its quota: the next tick offers it the roster, whatever its wait.
      this.core.group.backoff.heard(peer.coreId);
      if (rate.count > 120) return this.signed({nonce: envelope.nonce, error: 'peer rate limit'}, 429, sealing);
    } catch { return new Response('invalid signed message', { status: 403 }); }
    const groupOnly = envelope.operation === 'group.sync' || envelope.operation === 'group.push' || envelope.operation === 'contact.route'
      || envelope.operation === 'thread.start' || envelope.operation.startsWith('setting.') || envelope.operation.startsWith('bot.'); // the group's own: sealed, from a member
    if (this.core.group.removedPeer(peer.coreId) !== null && (groupOnly || !this.side.trusted().some(p => p.coreId === peer.coreId))) {
      return this.signed({ nonce: envelope.nonce, error: 'this machine was removed from the group', gone: true }, 410, sealing);
    }
    // A machine trusted through the group alone speaks sealed, and the roster is never exchanged readable. So does a contact.
    const contact = this.core.contacts.has(peer.coreId) && !this.side.peers().some(p => p.coreId === peer.coreId);
    if (sealing === null && (groupOnly || !this.side.peers().some(p => p.coreId === peer.coreId))) {
      return this.signed({ nonce: envelope.nonce, error: contact ? 'contacts exchange sealed requests only' : 'machines of a group exchange sealed requests only' }, 400);
    }
    // Reading an unsigned body cannot hold an update. Admission may have won
    // during that await, so authenticated processing must enter the same gate.
    if (this.side.closed() || this.core.stopping) return new Response('the core is stopping', { status: 503 });
    return this.core.router.trackRequest(async () => {
      let result: unknown;
      let error: string | undefined;
      let status = 200;
      try {
        // A revoke while the body streamed wins before any data is read or changed.
        const currentPeer = this.side.trusted().find(p => p.coreId === peer.coreId);
        if (!currentPeer) throw refused('peer permission revoked');
        policedRoutes(this.core, currentPeer, envelope.operation);
        const member = sealing !== null && this.core.group.peers().some(p => p.coreId === peer.coreId);
        if (contact && groupOnly) throw refused('operation: a contact takes no part in this core\'s group');
        if (!contact && envelope.operation.startsWith('contact.') && envelope.operation !== 'contact.route') throw refused('operation: only a contact sends contact operations');
        if (!member && envelope.operation.startsWith('relay.')) throw refused('operation: only a machine of this core\'s group relays for a contact');
        if (!member && envelope.operation === 'thread.start') throw refused('operation: only a machine of this core\'s group starts threads here');
        if (!member && envelope.operation.startsWith('setting.')) throw refused('operation: only a machine of this core\'s group reads or announces its settings');
        if (!member && envelope.operation.startsWith('bot.')) throw refused('operation: only a machine of this core\'s group looks after projects here');
        if (contact) result = await this.contact(currentPeer, envelope.operation, envelope.payload, false);
        else if (envelope.operation === 'contact.route') result = await this.core.coordination.mailboxes.handle(currentPeer, envelope.payload);
        else if (envelope.operation === 'directory') result = this.side.directory();
        else if (envelope.operation === 'deliver') result = this.side.receive(envelope.payload as AgentLetter, peer);
        else if (envelope.operation === 'search') {
          const words = searchWords(((envelope.payload as { words?: unknown })?.words as string[] | undefined)?.join?.(' '));
          result = searchContacts(this.core.journal.db, this.side.directory(), words, currentPeer.readThreads === true);
        } else if (envelope.operation === 'read') {
          if (!currentPeer.readThreads) throw refused('agents on this machine are not allowed to read conversations; enable their access in Machines on the destination');
          const { threadId, limit, before } = readParams(envelope.payload);
          const entry = this.side.directory().find(a => a.threadId === threadId);
          if (!entry) throw refused('read.threadId: not a thread open to other machines');
          result = { contact: entry, ...transcript(this.core.journal.db, threadId, limit, before, id => this.core.journal.streamingMessage(id)) };
        } else if (envelope.operation === 'receipt') result = this.receipt(peer.coreId, envelope.payload);
        else if (envelope.operation === 'group.sync') result = this.core.group.receive(peer, envelope.payload);
        else if (envelope.operation === 'group.push') result = this.core.push.relayed(peer, envelope.payload);
        else if (envelope.operation === 'relay.project') result = this.core.contacts.members.projectFor(envelope.payload);
        else if (envelope.operation === 'relay.mirror') result = this.core.contacts.members.mirrored(peer.coreId, envelope.payload);
        else if (envelope.operation === 'relay.out') result = await this.core.contacts.members.outbound(peer, envelope.payload);
        else if (envelope.operation === 'relay.in') {
          // A member answers for a contact it is linked to: what it asks is the contact's, under that contact's name here.
          const request = envelope.payload as { contact?: unknown; operation?: unknown; payload?: unknown } | null;
          const relayed = this.core.contacts.members.adopt(peer.coreId, request?.contact);
          const as = this.core.contacts.peers().find(p => p.coreId === relayed.coreId);
          if (!as || relayed.grants.length === 0) throw refused('nothing of this machine is opened to that contact any more');
          result = await this.contact(as, request?.operation as string, request?.payload, true);
        } else if (envelope.operation === 'thread.start') result = await this.core.threads.spawns.startFor(currentPeer, envelope.payload);
        else if (envelope.operation === 'setting.read') result = readMachineSetting(this.core, envelope.payload);
        else if (envelope.operation === 'setting.changed') result = machineSettingChanged(this.core, currentPeer, envelope.payload);
        else if ((BOT_OPERATIONS as readonly string[]).includes(envelope.operation)) result = await this.core.workforce.group.peer(currentPeer, envelope.operation as BotOperation, envelope.payload);
        else throw invalidParams(member ? 'operation: expected directory, deliver, receipt, search, read, group.sync, group.push, relay.*, thread.start, setting.* or bot.*' : 'operation: expected directory, deliver, receipt, search, read, group.sync or group.push');
        // An asynchronous contact lookup must not return data after access was withdrawn.
        policedRoutes(this.core, currentPeer, envelope.operation);
      } catch (reason) {
        result = undefined;
        status = reason instanceof RpcFailure ? 400 : 500;
        error = reason instanceof RpcFailure ? reason.message : 'Machine could not process the request';
      }
      return this.signed({ nonce: envelope.nonce, result, error }, status, sealing);
    });
  }

  /** A letter this core received from `coreId`, by id. */
  private receipt(coreId: string, payload: unknown): AgentLetter {
    const receipt = payload as { id: string; fromThreadId: string };
    const letter = this.side.received(text(receipt?.id, 'receipt.id', 100));
    if (!letter || letter.from.coreId !== coreId || letter.from.threadId !== receipt.fromThreadId) throw refused('unknown receipt');
    return letter;
  }

  /**
   * What a contact may ask: the projects opened to it and nothing else. On the
   * machine it is linked to, the projects other members opened to it as well
   * (`contacts/members.ts`); `relayed`, asked by that machine for the contact.
   */
  private async contact(peer: CoordinationPeer, operation: string, payload: unknown, relayed: boolean): Promise<unknown> {
    this.core.policy.assert(this.core.policy.networkOff('contacts'), 'network.contacts');
    const members = this.core.contacts.members;
    if (operation === 'contact.project') return receiveProject(this.core, peer.coreId, payload, relayed);
    if (this.core.sharedProjects.hasContact(peer.coreId) && ['directory', 'search', 'read'].includes(operation)) throw refused('operation: associated projects require scoped contact.project queries');
    if (operation === 'directory') {
      const local = this.side.contactDirectory(peer.coreId).map(redactSharedContact);
      return relayed ? local : [...local, ...await members.directory(peer.coreId)].sort((a, b) => (b.activeAt ?? 0) - (a.activeAt ?? 0)).slice(0, 100);
    }
    if (operation === 'deliver') {
      const letter = payload as AgentLetter;
      const at = relayed ? null : members.locate(peer.coreId, letter?.to?.coreId === this.side.selfId() ? letter.to.threadId : undefined);
      return at ? members.deliver(peer.coreId, at, letter) : this.side.receive(letter, peer);
    }
    if (operation === 'search') {
      const words = searchWords(((payload as { words?: unknown })?.words as string[] | undefined)?.join?.(' '));
      // Chat is searched only where the owner let the contact read conversations.
      const open = this.side.contactDirectory(peer.coreId).map(redactSharedContact);
      const readable = open.filter(entry => this.core.contacts.reach.mayRead(peer.coreId, entry.threadId));
      const closed = open.filter(entry => !this.core.contacts.reach.mayRead(peer.coreId, entry.threadId));
      const local = [...searchContacts(this.core.journal.db, readable, words, true, redactSharedText), ...searchContacts(this.core.journal.db, closed, words, false, redactSharedText)];
      return (relayed ? local : [...local, ...await members.search(peer.coreId, words)]).slice(0, 100);
    }
    if (operation === 'read') {
      const { threadId, limit, before } = readParams(payload);
      const at = relayed ? null : members.locate(peer.coreId, threadId);
      if (at) return members.read(peer.coreId, at, { limit, before });
      const entry = this.side.contactDirectory(peer.coreId).find(a => a.threadId === threadId);
      if (!entry) throw refused('read.threadId: not a thread of a project opened to you');
      if (!this.core.contacts.reach.mayRead(peer.coreId, threadId)) throw refused('read.threadId: this owner has not let you read the conversations of that project (readThreads)');
      return { contact: redactSharedContact(entry), ...transcript(this.core.journal.db, threadId, limit, before, id => this.core.journal.streamingMessage(id), redactSharedText) };
    }
    if (operation === 'receipt') {
      // A malformed receipt is refused here, before any member is asked.
      const receipt = payload as { id?: unknown; fromThreadId?: unknown } | null;
      text(receipt?.id, 'receipt.id', 100);
      text(receipt?.fromThreadId, 'receipt.fromThreadId', 128);
      try { return this.receipt(peer.coreId, payload); }
      catch (error) { if (relayed || !(error instanceof RpcFailure)) throw error; }
      return members.receipt(peer.coreId, payload);
    }
    if (!relayed && operation === 'contact.sync') return this.core.contacts.synced(peer.coreId, payload);
    if (!relayed && operation === 'contact.ask') {
      const ask = payload as { from?: AgentContact } | null;
      return this.core.contacts.asked(peer.coreId, ask, checkRemoteContact(ask?.from as AgentContact, peer));
    }
    if (!relayed && operation === 'contact.answer') {
      const threads = (payload as { threads?: unknown } | null)?.threads;
      if (threads !== undefined && (!Array.isArray(threads) || threads.length > 100)) throw invalidParams('answer.threads: expected up to 100 agents');
      return this.core.contacts.answered(peer.coreId, payload, ((threads ?? []) as AgentContact[]).map(entry => checkRemoteContact(entry, peer)));
    }
    throw invalidParams(relayed ? 'operation: expected directory, deliver, receipt, search or read' : 'operation: expected directory, deliver, receipt, search, read, contact.sync, contact.ask or contact.answer');
  }
  /** The answer, signed, and sealed back to the asker when its request came sealed. */
  private signed(reply: { nonce: string; result?: unknown; error?: string | undefined; gone?: true }, status: number, sealing: Sealing | null = null): Response {
    const raw = JSON.stringify(reply);
    const signature = this.side.signature(Buffer.from(raw)).toString('base64');
    const body = sealing === null ? raw : sealResponse(pack(raw, signature), sealing.responseKey, sealing.context);
    return new Response(body, { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-boite-signature': sealing === null ? signature : SEALED } });
  }
}

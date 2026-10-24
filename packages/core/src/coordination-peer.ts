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
import { boundedBody, type Envelope } from './coordination-wire.ts';
import { pack, SEALED, sealResponse, unpack, type Sealing } from './group/seal.ts';
import type { Core } from './core.ts';
import { invalidParams, refused, RpcFailure } from './errors.ts';
import { redactSharedText, redactSharedContact } from './contacts/file-policy.ts';

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

export class PeerDesk {
  /** Request nonces seen in the last two minutes, by sender. */
  private readonly nonces = new Map<string, number>();
  private readonly rates = new Map<string, { since: number; count: number; floor?: number }>();

  constructor(private readonly core: Core, private readonly side: PeerSide) {}

  async http(request: Request): Promise<Response> {
    if (this.side.closed() || request.method !== 'POST' || request.headers.has('origin')) return new Response('forbidden', { status: 403 });
    const id = request.headers.get('x-boite-peer');
    // A machine its group removed still signs with a key this core knows, so it can be told and leave.
    const peer = this.side.trusted().find(p => p.coreId === id) ?? this.core.group.removedPeer(id);
    if (!peer) return new Response('unknown peer', { status: 403 });
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
      if (rate.count > 120) return new Response('peer rate limit', { status: 429 });
    } catch { return new Response('invalid signed message', { status: 403 }); }
    const groupOnly = envelope.operation === 'group.sync' || envelope.operation === 'group.push'; // the group's own: sealed, from a member
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
        if (contact && groupOnly) throw refused('operation: a contact takes no part in this core\'s group');
        if (!contact && envelope.operation.startsWith('contact.')) throw refused('operation: only a contact sends contact operations');
        if (contact && this.core.sharedProjects.hasContact(peer.coreId) && ['directory', 'search', 'read'].includes(envelope.operation)) throw refused('operation: associated projects require scoped contact.project queries');
        if (envelope.operation === 'contact.project') result = await this.core.sharedProjects.receive(peer.coreId, envelope.payload);
        else if (envelope.operation === 'directory') result = contact ? this.side.contactDirectory(peer.coreId).map(redactSharedContact) : this.side.directory();
        else if (envelope.operation === 'deliver') result = this.side.receive(envelope.payload as AgentLetter, peer);
        else if (envelope.operation === 'search') {
          const words = searchWords(((envelope.payload as { words?: unknown })?.words as string[] | undefined)?.join?.(' '));
          if (contact) {
            // Chat is searched only where the owner let the contact read conversations.
            const open = this.side.contactDirectory(peer.coreId).map(redactSharedContact);
            const readable = open.filter(entry => this.core.contacts.mayRead(peer.coreId, entry.threadId));
            const closed = open.filter(entry => !this.core.contacts.mayRead(peer.coreId, entry.threadId));
            result = [...searchContacts(this.core.journal.db, readable, words, true, redactSharedText), ...searchContacts(this.core.journal.db, closed, words, false, redactSharedText)].slice(0, 100);
          } else result = searchContacts(this.core.journal.db, this.side.directory(), words, currentPeer.readThreads === true);
        } else if (envelope.operation === 'read') {
          if (!contact && !currentPeer.readThreads) throw refused('agents on this machine are not allowed to read conversations; enable their access in Machines on the destination');
          const payload = envelope.payload as { threadId?: unknown; limit?: unknown; before?: unknown };
          const threadId = text(payload?.threadId, 'read.threadId', 128);
          const limit = payload.limit === undefined ? 30 : payload.limit;
          if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 100) throw invalidParams('read.limit: expected 1 to 100');
          if (payload.before !== undefined && !Number.isSafeInteger(payload.before)) throw invalidParams('read.before: expected a timestamp');
          const entry = (contact ? this.side.contactDirectory(peer.coreId) : this.side.directory()).find(a => a.threadId === threadId);
          if (!entry) throw refused(contact ? 'read.threadId: not a thread of a project opened to you' : 'read.threadId: not a thread open to other machines');
          if (contact && !this.core.contacts.mayRead(peer.coreId, threadId)) throw refused('read.threadId: this owner has not let you read the conversations of that project (readThreads)');
          result = { contact: contact ? redactSharedContact(entry) : entry, ...transcript(this.core.journal.db, threadId, limit as number, payload.before as number | undefined, id => this.core.journal.streamingMessage(id), contact ? redactSharedText : undefined) };
        }
        else if (envelope.operation === 'receipt') {
          const payload = envelope.payload as { id: string; fromThreadId: string };
          const letter = this.side.received(text(payload?.id, 'receipt.id', 100));
          if (!letter || letter.from.coreId !== peer.coreId || letter.from.threadId !== payload.fromThreadId) throw refused('unknown receipt');
          result = letter;
        } else if (envelope.operation === 'group.sync') result = this.core.group.receive(peer, envelope.payload);
        else if (envelope.operation === 'group.push') result = this.core.push.relayed(peer, envelope.payload);
        else if (envelope.operation === 'contact.sync') result = this.core.contacts.synced(peer.coreId, envelope.payload);
        else if (envelope.operation === 'contact.ask') {
          const payload = envelope.payload as { from?: AgentContact } | null;
          result = this.core.contacts.asked(peer.coreId, payload, checkRemoteContact(payload?.from as AgentContact, currentPeer));
        } else if (envelope.operation === 'contact.answer') {
          const threads = (envelope.payload as { threads?: unknown } | null)?.threads;
          if (threads !== undefined && (!Array.isArray(threads) || threads.length > 100)) throw invalidParams('answer.threads: expected up to 100 agents');
          result = this.core.contacts.answered(peer.coreId, envelope.payload, ((threads ?? []) as AgentContact[]).map(entry => checkRemoteContact(entry, currentPeer)));
        } else throw invalidParams(contact ? 'operation: expected directory, deliver, receipt, search, read, contact.sync, contact.ask or contact.answer' : 'operation: expected directory, deliver, receipt, search, read, group.sync or group.push');
      } catch (reason) {
        status = reason instanceof RpcFailure ? 400 : 500;
        error = reason instanceof RpcFailure ? reason.message : 'Machine could not process the request';
      }
      return this.signed({ nonce: envelope.nonce, result, error }, status, sealing);
    });
  }
  /** The answer, signed, and sealed back to the asker when its request came sealed. */
  private signed(reply: { nonce: string; result?: unknown; error?: string | undefined; gone?: true }, status: number, sealing: Sealing | null = null): Response {
    const raw = JSON.stringify(reply);
    const signature = this.side.signature(Buffer.from(raw)).toString('base64');
    const body = sealing === null ? raw : sealResponse(pack(raw, signature), sealing.responseKey, sealing.context);
    return new Response(body, { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-boite-signature': sealing === null ? signature : SEALED } });
  }
}

import type { AgentAddress, AgentContact, AgentMatch, AgentTranscript, CoordinationConfig, CoordinationPeer } from '@boite/contracts';
import type { Core } from './core.ts';
import { checkMatchExtras, checkRemoteContact, checkTranscript, PARTIAL, partialList, partialName, searchContacts, searchWords, transcript } from './coordination-lookup.ts';
import { address, same } from './coordination-letter.ts';
import { PeerRefusal } from './coordination-wire.ts';
import type { ContactMailboxes } from './contacts/mailboxes.ts';
import { projectCoordination } from './contacts/project-coordination.ts';
import { invalidParams, refused } from './errors.ts';

/** What the lookups read from the coordination that owns them. */
export interface LookupSide {
  selfId(): string;
  config(threadId: string): CoordinationConfig;
  trusted(): CoordinationPeer[];
  localReach(threadId: string): AgentContact[];
  contact(threadId: string, resident?: boolean): AgentContact;
  checkLookupAccess(threadId: string, remote: boolean): void;
  readonly mailboxes: ContactMailboxes;
}

/**
 * The directory, search and transcript reads across this machine, trusted
 * machines and contacts reached through the group. A machine or route that
 * does not answer is named in `unavailable`, never folded into an empty list.
 */
export class CoordinationLookups {
  constructor(private readonly core: Core, private readonly side: LookupSide) {}
  async directory(threadId: string): Promise<{ agents: AgentContact[]; unavailable: string[] }> {
    const thread = this.core.threads.require(threadId);
    const config = this.side.config(threadId);
    if (thread.archived || config.mode === 'off') return { agents: [], unavailable: [] };
    const agents = this.side.localReach(threadId).filter(a => a.threadId !== threadId);
    const unavailable: string[] = [];
    if (config.remote) {
      const found = await Promise.all(this.side.trusted().map(async peer => {
        try {
          const remote = partialList(await projectCoordination(this.core, threadId, peer, 'directory', { partial: PARTIAL }));
          if (!this.side.trusted().some(p => p.coreId === peer.coreId)) throw new Error('peer revoked');
          return { peer, contacts: remote.entries.map(a => checkRemoteContact(a as AgentContact, peer)), missing: remote.unavailable };
        } catch { return { peer, contacts: null, missing: 0 }; }
      }));
      const routed = await this.side.mailboxes.directory(threadId);
      // Trust is read after the last await: a peer revoked while the routed lookup was pending is named, not listed.
      const trusted = new Set(this.side.trusted().map(peer => peer.coreId));
      for (const result of found) {
        if (result.contacts === null || !trusted.has(result.peer.coreId)) unavailable.push(result.peer.name);
        else {
          agents.push(...result.contacts);
          if (result.missing > 0) unavailable.push(partialName(result.peer.name, result.missing));
        }
      }
      agents.push(...routed.entries);
      unavailable.push(...routed.unavailable);
    }
    // Permissions may change while a remote directory is in flight.
    this.side.checkLookupAccess(threadId, config.remote);
    const reachable = new Set(this.side.localReach(threadId).map(contact => contact.threadId));
    const localCoreId = this.side.selfId();
    // A group member that is down fails both its own directory and the contact routes asked of it: it is named once.
    return { agents: agents.filter(contact => contact.coreId !== localCoreId || reachable.has(contact.threadId)), unavailable: [...new Set(unavailable)] };
  }
  /** Every contact this thread may reach on each trusted machine, in parallel; a machine that fails is named, not fatal. */
  private async remoteAll<T>(threadId: string, operation: 'search' | 'read', payload: unknown, check: (answer: unknown, peer: CoordinationPeer) => T, peers = this.side.trusted()): Promise<{ results: T[]; unavailable: string[] }> {
    const config = this.side.config(threadId);
    if (!config.remote || config.mode === 'off') return { results: [], unavailable: [] };
    const found = await Promise.all(peers.map(async peer => {
      try {
        const answer = await projectCoordination(this.core, threadId, peer, operation, payload);
        if (!this.side.trusted().some(p => p.coreId === peer.coreId)) throw new Error('peer revoked');
        return { peer, result: check(answer, peer), failed: null };
      } catch (error) { return { peer, result: null, failed: error instanceof PeerRefusal ? `${peer.name} (${error.message})` : peer.name }; }
    }));
    this.side.checkLookupAccess(threadId, true);
    // A peer that answered early may have been revoked while another one was pending.
    for (const entry of found) {
      if (!this.side.trusted().some(peer => peer.coreId === entry.peer.coreId)) {
        entry.result = null;
        entry.failed = entry.peer.name;
      }
    }
    return { results: found.flatMap(entry => entry.result === null ? [] : [entry.result]), unavailable: found.flatMap(entry => entry.failed === null ? [] : [entry.failed]) };
  }
  /** Contacts here and on trusted machines whose fields or chat contain every word of the query. */
  async search(threadId: string, query: string): Promise<{ matches: AgentMatch[]; unavailable: string[] }> {
    const words = searchWords(query);
    const config = this.side.config(threadId);
    if (this.core.threads.require(threadId).archived || config.mode === 'off') return { matches: [], unavailable: [] };
    const own = this.side.localReach(threadId).filter(a => a.threadId !== threadId);
    const matches = searchContacts(this.core.journal.db, own, words);
    const remote = await this.remoteAll(threadId, 'search', { words, partial: PARTIAL }, (answer, peer) => {
      const list = partialList(answer);
      return { peer, missing: list.unavailable, matches: list.entries.map(match => ({ ...checkRemoteContact(match as AgentContact, peer), ...checkMatchExtras(match as { matched?: unknown; excerpts?: unknown }) })) };
    });
    const routed = config.remote ? await this.side.mailboxes.search(threadId, words) : { entries: [], unavailable: [] };
    this.side.checkLookupAccess(threadId, config.remote);
    const reachable = new Set(this.side.localReach(threadId).map(contact => contact.threadId));
    const trusted = new Set(this.side.trusted().map(peer => peer.coreId));
    const remoteMatches = remote.results.flatMap(result => result.matches);
    const partial = remote.results.flatMap(result => result.missing > 0 ? [partialName(result.peer.name, result.missing)] : []);
    return {
      matches: [...matches.filter(match => reachable.has(match.threadId)), ...remoteMatches.filter(match => trusted.has(match.coreId)), ...routed.entries],
      unavailable: [...new Set([...remote.unavailable, ...partial, ...routed.unavailable, ...remoteMatches.filter(match => !trusted.has(match.coreId)).map(match => match.machine)])],
    };
  }
  /** Another reachable contact's conversation, text and tool names only. */
  async read(threadId: string, target: AgentAddress, limit = 30, before?: number): Promise<AgentTranscript> {
    const to = address(target, 'target');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw invalidParams('limit: expected 1 to 100');
    if (before !== undefined && !Number.isSafeInteger(before)) throw invalidParams('before: expected a timestamp');
    const config = this.side.config(threadId);
    const resident = to.coreId === this.side.selfId() && this.core.workforce.projects.over(threadId, to.threadId) !== null;
    if (this.core.threads.require(threadId).archived || (config.mode === 'off' && !resident)) throw refused('coordination is disabled for this thread');
    if (to.coreId === this.side.selfId()) {
      const contact = (resident ? this.side.contact(to.threadId, true) : undefined) ?? this.side.localReach(threadId).find(a => same(a, to)) ?? (to.threadId === threadId ? this.side.contact(threadId) : undefined);
      if (!contact) throw refused(`target: ${to.threadId} is not a contact this thread may reach; see boite threads`);
      return { contact, ...transcript(this.core.journal.db, to.threadId, limit, before, id => this.core.journal.streamingMessage(id)) };
    }
    const peer = this.side.trusted().find(p => p.coreId === to.coreId);
    if (!config.remote) throw refused('cross-machine coordination is disabled for this thread');
    if (!peer) return this.side.mailboxes.read(threadId, to.coreId, { threadId: to.threadId, limit, ...(before === undefined ? {} : { before }) });
    const { results, unavailable } = await this.remoteAll(threadId, 'read', { threadId: to.threadId, limit, ...(before === undefined ? {} : { before }) }, (answer, from) => {
      const raw = answer as { contact?: AgentContact } | null;
      const contact = checkRemoteContact(raw?.contact as AgentContact, from);
      if (contact.threadId !== to.threadId) throw new Error('transcript of another thread');
      return { contact, ...checkTranscript(answer) };
    }, [peer]);
    this.side.checkLookupAccess(threadId, true);
    if (!this.side.trusted().some(current => current.coreId === peer.coreId)) throw refused('target.coreId: machine permission revoked');
    if (!results[0]) throw refused(`${unavailable[0] ?? peer.name} did not answer the read`);
    return results[0];
  }}

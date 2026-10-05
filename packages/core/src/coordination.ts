import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign, verify } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultCoordinationConfig } from '@boite/contracts';
import type { AgentAddress, AgentContact, AgentLetter, AgentMatch, AgentTranscript, CoordinationBridgeResponse, CoordinationConfig, CoordinationPeer, CoordinationView, RpcParams } from '@boite/contracts';
import { checkMatchExtras, checkTranscript, searchContacts, searchWords, transcript } from './coordination-lookup.ts';
import { CoordinationBridge } from './coordination-bridge.ts';
import { dropGroupRead, groupPeers, migrateGroupPeer } from './coordination-group.ts';
import { address, coordinationGuide, coordinationUrl, LETTER_TTL_MS, letterPrompt, same, STEWARD_LETTER_TTL_MS, text } from './coordination-letter.ts';
import { boundedBody, firstAnswer, MAX_BODY, PeerGone, PeerRefusal, post, ROUTE, settle, type Answer } from './coordination-wire.ts';
import { pack, SEALED, sealResponse, unpack, type Sealing } from './group/seal.ts';
import type { Core } from './core.ts';
import { invalidParams, messageOf, refused, RpcFailure, unavailable } from './errors.ts';

const HOUR = 3_600_000;
/** How long a delivered, expired, rejected or uncertain letter stays in the journal. */
export const LETTER_RETENTION_MS = 30 * 24 * HOUR;
/** Marks a pause the core applied by itself, as opposed to the owner's in Communication settings. */
const AUTO_PAUSE_PREFIX = 'coordination-autopause:';
/** The sweep's idle probes, each one read on the status index: letters it still has work for. */
export const SWEEP_PROBES = [
  "SELECT 1 FROM coordination_letters WHERE status IN ('queued', 'received') LIMIT 1",
  // An uncertain letter is never replayed. Only an outgoing one is asked about again, until it expires.
  "SELECT 1 FROM coordination_letters WHERE status = 'uncertain' AND direction = 'out' AND created_at > ? AND json_extract(data, '$.expiresAt') > ? LIMIT 1",
] as const;
/** The longest `collaboration.wait`: a CLI call stays under its five-minute RPC deadline. */
export const WAIT_MAX_MS = 300_000;
export { coordinationUrl, letterPrompt, STEWARD_LETTER_TTL_MS };
type Row = { data: string; fingerprint: string | null };
type Operation = 'directory' | 'deliver' | 'receipt' | 'search' | 'read' | 'group.sync';
type Envelope = { from: string; to: string; at: number; nonce: string; operation: Operation; payload: unknown };

export class Coordination {
  readonly bridge = new CoordinationBridge();
  private key: ReturnType<typeof createPrivateKey> | null = null;
  private publicKey = '';
  private coreId = '';
  private closed = false;
  /** Releases local acknowledgement waits before driver teardown can reject them. */
  private readonly localWaits = new Set<() => void>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly delivering = new Set<string>();
  private readonly nonces = new Map<string, number>();
  private readonly rates = new Map<string, { since: number; count: number; floor?: number }>();
  private readonly attempts = new Map<string, number>();
  /** Agents blocked in `collaboration.wait`, by thread. */
  private readonly waiters = new Map<string, Set<{ from: AgentAddress | null; done: (letters: AgentLetter[]) => void }>>();
  private ticking = false;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly off: () => void;
  /** When the sweep last pruned the wake log and old letters; both are hourly bookkeeping. */
  private swept = 0;

  constructor(private readonly core: Core) {
    // A restart keeps idle contacts reachable, but never replays pending work automatically.
    core.journal.validateVisibleThreadJson();
    const candidates = core.journal.db.query(`SELECT settings.key, settings.value, threads.rowid FROM settings JOIN threads ON settings.key = 'coordination:' || threads.id
      WHERE threads.id NOT IN (SELECT thread_id FROM thread_deletions) AND (typeof(settings.value) <> 'text' OR NOT json_valid(settings.value))
      ORDER BY threads.rowid`).all() as { key: string; value: string; rowid: number }[];
    // Find the real parser error now; report it after the preceding recovery writes.
    const invalidConfig = candidates.find(({ value }) => { try { JSON.parse(value); return false; } catch { return true; } });
    const interrupted = core.journal.db.query(`SELECT id, status, rowid FROM threads WHERE id NOT IN (SELECT thread_id FROM thread_deletions)
      AND (? IS NULL OR rowid <= ?) AND (status IN ('queued', 'running', 'waiting') OR rowid = ?
        OR id IN (SELECT thread_id FROM coordination_letters WHERE status IN ('queued', 'received', 'uncertain')))
      ORDER BY rowid`).all(invalidConfig?.rowid ?? null, invalidConfig?.rowid ?? null, invalidConfig?.rowid ?? null) as { id: string; status: string; rowid: number }[];
    for (const thread of interrupted) {
      if (thread.rowid === invalidConfig?.rowid) core.journal.getSetting(invalidConfig.key);
      const pending = core.journal.db.query("SELECT 1 FROM coordination_letters WHERE thread_id = ? AND (status IN ('queued', 'received') OR (status = 'uncertain' AND json_extract(data, '$.error') = 'Queued for provider delivery')) LIMIT 1").get(thread.id);
      if (pending || ['queued', 'running', 'waiting'].includes(thread.status)) this.pause(thread.id);
    }
    // A thread that finishes a turn can take its waiting letters now, not at the next sweep.
    this.off = core.bus.onAny((name, payload) => {
      if (name === 'turn.finished' && !this.closed) this.kick((payload as { threadId: string }).threadId);
    });
    // The sweep remains for expiry, remote retries and a steer a driver was not ready for.
    this.timer = setInterval(() => { void this.tick(); }, 2000);
    this.timer.unref?.();
  }

  /** Delivery to one thread once the current synchronous work (a journal write, a turn end) is done. */
  private kick(threadId: string): void {
    queueMicrotask(() => {
      if (this.closed || this.core.journal.isClosed()) return;
      const job = this.deliver(threadId).catch(error => { if (!this.closed) this.core.log('warn', `coordination ${threadId}: ${messageOf(error)}`); });
      this.pending.add(job);
      void job.finally(() => this.pending.delete(job));
    });
  }

  private identityKey(): void {
    if (this.key) return;
    const file = join(this.core.dataDir, 'coordination-key.pem');
    if (!existsSync(file)) {
      const pair = generateKeyPairSync('ed25519');
      writeFileSync(file, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
    }
    this.key = createPrivateKey(readFileSync(file));
    this.publicKey = createPublicKey(this.key).export({ type: 'spki', format: 'pem' }).toString();
    this.coreId = createHash('sha256').update(this.publicKey).digest('hex');
  }
  identity(): CoordinationPeer {
    this.identityKey();
    return { coreId: this.coreId, name: this.core.info().hostname ?? 'Boite', url: coordinationUrl(this.core.settings.get().publicUrl || this.core.baseUrl()), publicKey: this.publicKey };
  }
  private self(threadId: string): AgentAddress { this.identityKey(); return { coreId: this.coreId, threadId }; }
  /** This core's identity without an address: what a group lists and signs with. */
  card(): { coreId: string; publicKey: string } { this.identityKey(); return { coreId: this.coreId, publicKey: this.publicKey }; }
  signature(input: Buffer): Buffer { this.identityKey(); return sign(null, input, this.key!); }
  /** The links the owner made by hand, each with its own permissions. A group's members are trusted too, and listed by the group. */
  peers(): CoordinationPeer[] { return (this.core.journal.getSetting('coordination:peers') as CoordinationPeer[] | undefined) ?? []; }
  /**
   * Every machine a letter may cross to: the hand-made links first, so the
   * permissions the owner set on one win, then the members of this core's group.
   */
  trusted(): CoordinationPeer[] {
    const manual = this.peers();
    return [...manual, ...groupPeers(this.core).filter(peer => !manual.some(known => known.coreId === peer.coreId))];
  }
  async check(coreId: string): Promise<{ ok: true }> {
    const peer = this.trusted().find(p => p.coreId === coreId);
    if (!peer) throw refused('machine is not trusted for coordination');
    try { await this.exchange(peer, 'directory', {}); }
    catch (error) {
      if (error instanceof RpcFailure) throw error;
      const source = this.core.info().hostname ?? 'Boite';
      this.core.log('warn', `agent link ${source} -> ${peer.name} at ${peer.url}: ${messageOf(error)}`);
      throw unavailable(`${source} could not verify the agent link to ${peer.name} at ${peer.url}. Check that both machines can reach each other's HTTPS address.`);
    }
    return { ok: true };
  }
  trust(peer: CoordinationPeer): CoordinationPeer {
    if (!peer) throw invalidParams('peer: expected a public contact card');
    const publicKey = text(peer.publicKey, 'peer.publicKey', 1000);
    const parsed = createPublicKey(publicKey);
    if (parsed.asymmetricKeyType !== 'ed25519') throw invalidParams('peer.publicKey: expected Ed25519');
    const canonical = parsed.export({ type: 'spki', format: 'pem' }).toString();
    const coreId = createHash('sha256').update(canonical).digest('hex');
    if (coreId !== peer.coreId || coreId === this.self('').coreId) throw invalidParams('peer.coreId: expected the other machine public key fingerprint');
    for (const field of ['readThreads', 'viaClient'] as const) if (peer[field] !== undefined && typeof peer[field] !== 'boolean') throw invalidParams(`peer.${field}: expected a boolean`);
    const previous = this.peers().find(p => p.coreId === coreId);
    const checked = { coreId, name: text(peer.name, 'peer.name', 100), url: coordinationUrl(peer.url), publicKey: canonical,
      readThreads: peer.readThreads ?? previous?.readThreads ?? false,
      viaClient: peer.viaClient ?? previous?.viaClient ?? false };
    const peers = this.peers().filter(p => p.coreId !== coreId);
    if (peers.length >= 32) throw refused('at most 32 coordination peers');
    this.core.journal.setSetting('coordination:peers', [...peers, checked]);
    if (this.core.group.peers().some(peer => peer.coreId === coreId)) migrateGroupPeer(this.core, checked);
    return checked;
  }
  untrust(coreId: string, preserveGroupRead = false): { ok: true } {
    if (!preserveGroupRead) dropGroupRead(this.core, coreId);
    this.core.journal.setSetting('coordination:peers', this.peers().filter(p => p.coreId !== coreId));
    // Still a member of this core's group: its letters keep crossing.
    if (this.trusted().some(p => p.coreId === coreId)) return { ok: true };
    this.bridge.revoke(coreId);
    const queued = this.rows("status = 'uncertain'").map(row => JSON.parse(row.data) as AgentLetter)
      .filter(letter => letter.error === 'Queued for provider delivery' && (letter.from.coreId === coreId || letter.to.coreId === coreId));
    for (const threadId of new Set(queued.map(letter => letter.to.threadId))) this.core.threads.stopQueuedCoordination(threadId);
    for (const row of this.rows("status IN ('queued', 'received')")) {
      const letter = JSON.parse(row.data) as AgentLetter;
      if (letter.from.coreId === coreId || letter.to.coreId === coreId) this.update(letter, 'rejected', 'Machine permission revoked');
    }
    return { ok: true };
  }
  config(threadId: string): CoordinationConfig {
    const saved = this.core.journal.getSetting(`coordination:${threadId}`) as CoordinationConfig | undefined;
    if (saved) return saved;
    // Persistent identities have their own group and mission permissions.
    if (this.core.journal.getThread(threadId)?.agentSessionId) return { ...defaultCoordinationConfig(), mode: 'off', remote: false };
    return defaultCoordinationConfig();
  }
  private saveConfig(threadId: string, config: CoordinationConfig): void {
    this.core.journal.setSetting(`coordination:${threadId}`, config);
    this.core.bus.emit('collaboration.changed', { threadId });
  }
  configure(threadId: string, config: CoordinationConfig): CoordinationView {
    const thread = this.core.threads.require(threadId);
    if (thread.agentSessionId) throw refused('persistent agent sessions collaborate through their group or mission');
    if (thread.archived) throw refused('coordination requires an unarchived thread');
    if (!config || !['off', 'brief', 'team'].includes(config.mode) || typeof config.resources !== 'string' || config.resources.length > 500 || typeof config.remote !== 'boolean' || typeof config.paused !== 'boolean') throw invalidParams('config: expected mode off/brief/team, resources up to 500 characters, remote and paused booleans');
    // The owner's own choice, pause included, is never lifted by a later message.
    this.core.journal.deleteSetting(`${AUTO_PAUSE_PREFIX}${threadId}`);
    this.saveConfig(threadId, { mode: config.mode, resources: config.resources, remote: config.remote, paused: config.paused });
    if (config.paused) this.core.threads.stopQueuedCoordination(threadId);
    if (config.mode === 'off' || !config.remote) {
      const queued = this.rows("thread_id = ? AND status = 'uncertain'", threadId).map(row => JSON.parse(row.data) as AgentLetter)
        .filter(letter => letter.error === 'Queued for provider delivery' && (config.mode === 'off' || !this.inProject(letter)));
      for (const target of new Set(queued.filter(letter => letter.to.coreId === this.self('').coreId).map(letter => letter.to.threadId))) {
        this.core.threads.stopQueuedCoordination(target);
      }
    }
    if (config.mode === 'off') {
      for (const row of this.rows("thread_id = ? AND status IN ('queued', 'received')", threadId)) this.update(JSON.parse(row.data), 'rejected', 'Coordination disabled');
    } else if (!config.remote) {
      for (const row of this.rows("thread_id = ? AND status IN ('queued', 'received')", threadId)) {
        const letter = JSON.parse(row.data) as AgentLetter;
        if (!this.inProject(letter)) this.update(letter, 'rejected', 'Cross-project or cross-machine coordination disabled');
      }
    }
    return this.get(threadId);
  }
  /** A pause the core applies by itself (Stop, a restart, a failed wake). It lasts until the user's next message. */
  pause(threadId: string): void {
    const config = this.config(threadId);
    if (config.mode === 'off' || config.paused) return;
    this.core.journal.setSetting(`${AUTO_PAUSE_PREFIX}${threadId}`, true);
    this.saveConfig(threadId, { ...config, paused: true });
  }
  /** The user wrote to the thread again: a pause the core applied by itself ends, the owner's stays. */
  resumeForUser(threadId: string): void {
    if (!this.core.journal.getSetting(`${AUTO_PAUSE_PREFIX}${threadId}`)) return;
    this.core.journal.deleteSetting(`${AUTO_PAUSE_PREFIX}${threadId}`);
    const config = this.config(threadId);
    if (config.paused) this.saveConfig(threadId, { ...config, paused: false });
  }
  get(threadId: string): CoordinationView {
    this.core.threads.require(threadId);
    const config = this.config(threadId);
    return {
      self: this.self(threadId), config,
      messages: this.rows('thread_id = ? ORDER BY created_at DESC LIMIT 100', threadId).map(r => this.withProjects(JSON.parse(r.data) as AgentLetter)).reverse(),
      sent: this.count(threadId, 'out'), sendLimit: null,
      wakes: (this.core.journal.db.query('SELECT count(*) AS n FROM coordination_wakes WHERE thread_id = ? AND at > ?').get(threadId, Date.now() - HOUR) as { n: number }).n,
      wakeLimit: null,
    };
  }
  private count(threadId: string, direction: string): number {
    return (this.core.journal.db.query('SELECT count(*) AS n FROM coordination_letters WHERE thread_id = ? AND direction = ? AND created_at > ?').get(threadId, direction, Date.now() - HOUR) as { n: number }).n;
  }
  private projectName(threadId: string): string | undefined {
    const projectId = this.core.journal.getThread(threadId)?.projectId;
    return projectId ? this.core.journal.getProject(projectId)?.name.slice(0, 200) : undefined;
  }
  /** Old local letters predate project metadata. Fill it without rewriting history. */
  private withProjects(letter: AgentLetter): AgentLetter {
    const local = this.coreId;
    return { ...letter,
      from: letter.from.coreId === local && letter.from.project === undefined ? { ...letter.from, project: this.projectName(letter.from.threadId) } : letter.from,
      toProject: letter.toProject ?? (letter.to.coreId === local ? this.projectName(letter.to.threadId) : undefined),
    };
  }
  /** `steward`: a steward and the threads it looks after reach each other whatever their communication settings say. */
  private contact(threadId: string, steward = false): AgentContact {
    const thread = this.core.threads.require(threadId);
    const config = this.config(threadId);
    if (thread.archived || (config.mode === 'off' && !steward)) throw refused('recipient is unavailable or coordination is disabled');
    const project = thread.projectId === null ? null : this.core.journal.getProject(thread.projectId);
    return {
      ...this.self(threadId), title: thread.title.slice(0, 200), machine: this.core.info().hostname ?? 'Boite', resources: config.resources, status: thread.status, mode: config.mode,
      ...(project ? { project: project.name.slice(0, 200) } : {}),
      agent: `${thread.providerId}${thread.model ? ` ${thread.model}` : ''}`.slice(0, 200),
      branch: thread.branch === null ? null : thread.branch.slice(0, 200),
      activeAt: thread.updatedAt,
      lastCompletedAt: this.core.journal.lastCompletedAt(threadId),
      projectArchived: project?.archived === true,
      paused: config.paused,
    };
  }
  /** Reachable threads, the most recently active first: an old thread never hides a live one. */
  private localDirectory(projectId?: string): AgentContact[] {
    return this.core.journal.listThreads(projectId)
      .filter(t => !t.archived && this.config(t.id).mode !== 'off' && (projectId !== undefined || this.config(t.id).remote))
      .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 100).map(t => this.contact(t.id));
  }
  /** What this thread may reach on its own core: its project, and every remote-enabled thread when it is one too. */
  private localReach(threadId: string): AgentContact[] {
    const thread = this.core.threads.require(threadId);
    const config = this.config(threadId);
    if (thread.archived || config.mode === 'off') return [];
    const local = thread.projectId === null ? [] : this.localDirectory(thread.projectId);
    if (config.remote) for (const contact of this.localDirectory()) if (!local.some(a => same(a, contact))) local.push(contact);
    return local;
  }
  /** Only access permissions invalidate a pending lookup; pausing delivery does not revoke reads. */
  private checkLookupAccess(threadId: string, remote: boolean): void {
    const thread = this.core.threads.require(threadId);
    const config = this.config(threadId);
    if (thread.archived || config.mode === 'off' || (remote && !config.remote)) {
      throw refused('coordination permissions changed; retry the lookup', {
        field: 'threadId', threadId, expected: remote ? 'an unarchived thread with remote coordination enabled' : 'an unarchived thread with coordination enabled',
      });
    }
  }
  async directory(threadId: string): Promise<{ agents: AgentContact[]; unavailable: string[] }> {
    const thread = this.core.threads.require(threadId);
    const config = this.config(threadId);
    if (thread.archived || config.mode === 'off') return { agents: [], unavailable: [] };
    const agents = this.localReach(threadId).filter(a => a.threadId !== threadId);
    const unavailable: string[] = [];
    if (config.remote) {
      const found = await Promise.all(this.trusted().map(async peer => {
        try {
          const remote = await this.exchange(peer, 'directory', {}) as AgentContact[];
          if (!this.trusted().some(p => p.coreId === peer.coreId)) throw new Error('peer revoked');
          if (!Array.isArray(remote) || remote.length > 100) throw new Error('invalid remote directory');
          return { peer, contacts: remote.map(a => this.checkContact(a, peer)) };
        } catch { return { peer, contacts: null }; }
      }));
      for (const result of found) {
        if (result.contacts === null || !this.trusted().some(peer => peer.coreId === result.peer.coreId)) unavailable.push(result.peer.name);
        else agents.push(...result.contacts);
      }
    }
    // Permissions may change while a remote directory is in flight.
    this.checkLookupAccess(threadId, config.remote);
    const reachable = new Set(this.localReach(threadId).map(contact => contact.threadId));
    const localCoreId = this.self('').coreId;
    return { agents: agents.filter(contact => contact.coreId !== localCoreId || reachable.has(contact.threadId)), unavailable };
  }
  private checkContact(contact: AgentContact, peer: CoordinationPeer): AgentContact {
    if (!contact || contact.coreId !== peer.coreId || !['brief', 'team'].includes(contact.mode) || !['idle', 'queued', 'running', 'waiting', 'error'].includes(contact.status)) throw invalidParams('agent: invalid remote contact');
    const optional = (value: unknown) => typeof value === 'string' && value.length <= 200 ? value : undefined;
    const project = optional(contact.project);
    const agent = optional(contact.agent);
    const branch = optional(contact.branch);
    return {
      ...address(contact, 'agent'), title: text(contact.title, 'agent.title', 200), machine: peer.name, resources: typeof contact.resources === 'string' && contact.resources.length <= 500 ? contact.resources : '', status: contact.status, mode: contact.mode,
      ...(project === undefined ? {} : { project }), ...(agent === undefined ? {} : { agent }),
      ...(branch === undefined ? {} : { branch }), ...(Number.isSafeInteger(contact.activeAt) ? { activeAt: contact.activeAt } : {}),
      ...(contact.lastCompletedAt === null || Number.isSafeInteger(contact.lastCompletedAt) && contact.lastCompletedAt! >= 0 ? { lastCompletedAt: contact.lastCompletedAt } : {}),
      ...(typeof contact.projectArchived === 'boolean' ? { projectArchived: contact.projectArchived } : {}),
      ...(typeof contact.paused === 'boolean' ? { paused: contact.paused } : {}),
    };
  }
  /** Every contact this thread may reach on each trusted machine, in parallel; a machine that fails is named, not fatal. */
  private async remoteAll<T>(threadId: string, operation: 'search' | 'read', payload: unknown, check: (answer: unknown, peer: CoordinationPeer) => T, peers = this.trusted()): Promise<{ results: T[]; unavailable: string[] }> {
    const config = this.config(threadId);
    if (!config.remote || config.mode === 'off') return { results: [], unavailable: [] };
    const found = await Promise.all(peers.map(async peer => {
      try {
        const answer = await this.exchange(peer, operation, payload);
        if (!this.trusted().some(p => p.coreId === peer.coreId)) throw new Error('peer revoked');
        return { peer, result: check(answer, peer), failed: null };
      } catch (error) { return { peer, result: null, failed: error instanceof PeerRefusal ? `${peer.name} (${error.message})` : peer.name }; }
    }));
    this.checkLookupAccess(threadId, true);
    // A peer that answered early may have been revoked while another one was pending.
    for (const entry of found) {
      if (!this.trusted().some(peer => peer.coreId === entry.peer.coreId)) {
        entry.result = null;
        entry.failed = entry.peer.name;
      }
    }
    return { results: found.flatMap(entry => entry.result === null ? [] : [entry.result]), unavailable: found.flatMap(entry => entry.failed === null ? [] : [entry.failed]) };
  }
  /** Contacts here and on trusted machines whose fields or chat contain every word of the query. */
  async search(threadId: string, query: string): Promise<{ matches: AgentMatch[]; unavailable: string[] }> {
    const words = searchWords(query);
    const config = this.config(threadId);
    if (this.core.threads.require(threadId).archived || config.mode === 'off') return { matches: [], unavailable: [] };
    const own = this.localReach(threadId).filter(a => a.threadId !== threadId);
    const matches = searchContacts(this.core.journal.db, own, words);
    const remote = await this.remoteAll(threadId, 'search', { words }, (answer, peer) => {
      if (!Array.isArray(answer) || answer.length > 100) throw new Error('invalid remote search');
      return answer.map(match => ({ ...this.checkContact(match, peer), ...checkMatchExtras(match) }));
    });
    this.checkLookupAccess(threadId, config.remote);
    const reachable = new Set(this.localReach(threadId).map(contact => contact.threadId));
    const trusted = new Set(this.trusted().map(peer => peer.coreId));
    const remoteMatches = remote.results.flat();
    return {
      matches: [...matches.filter(match => reachable.has(match.threadId)), ...remoteMatches.filter(match => trusted.has(match.coreId))],
      unavailable: [...new Set([...remote.unavailable, ...remoteMatches.filter(match => !trusted.has(match.coreId)).map(match => match.machine)])],
    };
  }
  /** Another reachable contact's conversation, text and tool names only. */
  async read(threadId: string, target: AgentAddress, limit = 30, before?: number): Promise<AgentTranscript> {
    const to = address(target, 'target');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw invalidParams('limit: expected 1 to 100');
    if (before !== undefined && !Number.isSafeInteger(before)) throw invalidParams('before: expected a timestamp');
    const config = this.config(threadId);
    const stewarded = to.coreId === this.self('').coreId && this.core.stewards.over(threadId, to.threadId) !== null;
    if (this.core.threads.require(threadId).archived || (config.mode === 'off' && !stewarded)) throw refused('coordination is disabled for this thread');
    if (to.coreId === this.self('').coreId) {
      const contact = (stewarded ? this.contact(to.threadId, true) : undefined) ?? this.localReach(threadId).find(a => same(a, to)) ?? (to.threadId === threadId ? this.contact(threadId) : undefined);
      if (!contact) throw refused(`target: ${to.threadId} is not a contact this thread may reach; see boite agents list`);
      return { contact, ...transcript(this.core.journal.db, to.threadId, limit, before) };
    }
    const peer = this.trusted().find(p => p.coreId === to.coreId);
    if (!peer) throw refused('target.coreId: not this core nor a machine trusted for coordination');
    if (!config.remote) throw refused('cross-machine coordination is disabled for this thread');
    const { results, unavailable } = await this.remoteAll(threadId, 'read', { threadId: to.threadId, limit, ...(before === undefined ? {} : { before }) }, (answer, from) => {
      const raw = answer as { contact?: AgentContact } | null;
      const contact = this.checkContact(raw?.contact as AgentContact, from);
      if (contact.threadId !== to.threadId) throw new Error('transcript of another thread');
      return { contact, ...checkTranscript(answer) };
    }, [peer]);
    this.checkLookupAccess(threadId, true);
    if (!this.trusted().some(current => current.coreId === peer.coreId)) throw refused('target.coreId: machine permission revoked');
    if (!results[0]) throw refused(`${unavailable[0] ?? peer.name} did not answer the read`);
    return results[0];
  }
  /**
   * Blocks until an incoming message (from `from` when given) arrives or the
   * timeout passes. What it returns counts as delivered: the agent read it in
   * its tool output, so no hook or steer injects it again.
   */
  wait(threadId: string, from: AgentAddress | undefined, timeoutMs: number): Promise<{ letters: AgentLetter[] }> {
    this.contact(threadId);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > WAIT_MAX_MS) throw invalidParams(`timeoutMs: expected 0 to ${WAIT_MAX_MS}`);
    const sender = from === undefined ? null : address(from, 'from');
    const ready = this.claim(threadId, sender);
    if (ready.length > 0 || timeoutMs === 0) return Promise.resolve({ letters: ready });
    return new Promise(resolve => {
      const set = this.waiters.get(threadId) ?? new Set();
      this.waiters.set(threadId, set);
      const waiter = { from: sender, done: (letters: AgentLetter[]) => { clearTimeout(timer); set.delete(waiter); if (set.size === 0) this.waiters.delete(threadId); resolve({ letters }); } };
      const timer = setTimeout(() => waiter.done([]), timeoutMs);
      set.add(waiter);
    });
  }
  /** Received letters for this thread, from one sender or any, marked delivered. */
  private claim(threadId: string, from: AgentAddress | null): AgentLetter[] {
    const letters = this.rows("thread_id = ? AND direction = 'in' AND status = 'received' ORDER BY created_at", threadId)
      .map(r => JSON.parse(r.data) as AgentLetter)
      .filter(letter => letter.expiresAt > Date.now() && this.mayReceive(letter) && (from === null || same(letter.from, from)));
    if (letters.length > 0) this.restoreProject(threadId);
    for (const letter of letters) this.update(letter, 'delivered');
    return letters.map(letter => ({ ...letter, status: 'delivered' as const }));
  }
  /** A waiting agent takes the letter that just arrived; true when one did. */
  private handToWaiter(letter: AgentLetter): boolean {
    for (const waiter of this.waiters.get(letter.to.threadId) ?? []) {
      if (waiter.from !== null && !same(waiter.from, letter.from)) continue;
      const letters = this.claim(letter.to.threadId, waiter.from);
      if (letters.length === 0) return false;
      waiter.done(letters);
      return true;
    }
    return false;
  }
  async send(params: RpcParams<'collaboration.send'>): Promise<AgentLetter> {
    const to = address(params.to, 'to');
    const local = to.coreId === this.self('').coreId;
    const { asSteward, toSteward } = this.core.stewards.between(local, params.threadId, to.threadId);
    const from = this.contact(params.threadId, asSteward || toSteward);
    const config = this.config(params.threadId);
    if (config.paused) throw refused('coordination paused by the owner');
    const body = text(params.text, 'text');
    const requestId = text(params.requestId, 'requestId', 128);
    const fingerprint = createHash('sha256').update(JSON.stringify([to, body, params.replyTo ?? null])).digest('hex');
    const existing = this.core.journal.db.query('SELECT data, fingerprint FROM coordination_letters WHERE thread_id = ? AND request_id = ?').get(params.threadId, requestId) as Row | null;
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw refused('requestId already used for different content');
      return JSON.parse(existing.data) as AgentLetter;
    }
    if (same(from, to)) throw refused('an agent cannot message itself');
    let toTitle: string;
    let toProject: string | undefined;
    let toMachine: string | undefined;
    if (to.coreId === from.coreId) {
      if (!asSteward && !toSteward && this.core.threads.require(to.threadId).projectId !== this.core.threads.require(from.threadId).projectId && !(config.remote && this.config(to.threadId).remote)) throw refused('both threads must enable coordination across projects');
      const target = this.contact(to.threadId, asSteward || toSteward);
      toTitle = target.title;
      toProject = target.project;
      toMachine = target.machine;
    } else {
      if (!config.remote) throw refused('cross-machine coordination is disabled for this thread');
      const peer = this.trusted().find(p => p.coreId === to.coreId);
      if (!peer) throw refused('destination machine is not trusted for coordination');
      // No directory round trip on send: a disconnected recipient can receive after reconnect.
      toTitle = to.threadId;
      toMachine = peer.name;
    }
    if (params.replyTo) {
      const previous = this.rows('id = ? AND thread_id = ?', params.replyTo, params.threadId)[0];
      if (!previous) throw refused('replyTo must name a message in this thread');
      const letter = JSON.parse(previous.data) as AgentLetter;
      if (!same(letter.from, to) || !same(letter.to, from)) throw refused('replyTo must name an incoming message from this recipient');
    }
    // Recheck budgets after all validation, before the synchronous durable write.
    const createdAt = Date.now();
    const letter: AgentLetter = { ...(asSteward ? { origin: 'steward' as const } : {}), id: randomUUID(), from, to, toTitle, toProject, toMachine, text: body, replyTo: params.replyTo ?? null, createdAt, expiresAt: createdAt + (asSteward || toSteward ? STEWARD_LETTER_TTL_MS : LETTER_TTL_MS), status: 'queued', error: null };
    this.core.journal.append({ type: 'coordination.sent', threadId: from.threadId, version: 1, payload: letter }, () => this.put(letter, 'out', from.threadId, requestId, fingerprint));
    this.core.threads.runner.noteMail(from.threadId, letter.createdAt);
    this.changed(from.threadId);
    if (to.coreId === from.coreId) {
      try { this.receive(letter); } catch (error) { this.update(letter, 'rejected', messageOf(error)); }
    } else queueMicrotask(() => { void this.tick(); });
    return this.find(letter.id, 'out')!;
  }
  private receive(letter: AgentLetter, peer?: CoordinationPeer): AgentLetter {
    if (!letter || typeof letter !== 'object') throw invalidParams('letter: expected an agent message');
    text(letter.id, 'letter.id', 100);
    address(letter.to, 'letter.to');
    if (letter.to.coreId !== this.self('').coreId) throw refused('message belongs to another core');
    // Only this core marks a letter as the steward's or a notice, and only while the grant holds. A remote origin is never believed.
    const { asSteward, toSteward } = this.core.stewards.between(!peer, letter.from.threadId, letter.to.threadId);
    if (!peer && letter.origin === 'steward' && !asSteward) throw refused('the steward grant no longer covers this thread');
    const target = this.contact(letter.to.threadId, asSteward || toSteward);
    const config = this.config(target.threadId);
    const from = peer ? this.checkContact(letter.from, peer) : this.contact(letter.from.threadId, asSteward || toSteward);
    if (peer && !config.remote) throw refused('recipient has not enabled cross-machine coordination');
    for (const row of this.rows('id = ?', letter.id)) {
      const known = JSON.parse(row.data) as AgentLetter;
      if (!same(known.from, from) || !same(known.to, target) || known.text !== letter.text || known.replyTo !== letter.replyTo) throw refused('message id already used for different content');
    }
    const existing = this.find(letter.id, 'in');
    if (existing) {
      if (!same(existing.from, from) || !same(existing.to, target) || existing.text !== letter.text || existing.replyTo !== letter.replyTo) throw refused('message id already used for different content');
      return existing;
    }
    if (!Number.isSafeInteger(letter.createdAt) || !Number.isSafeInteger(letter.expiresAt) || letter.createdAt > Date.now() + 60_000 || letter.expiresAt <= Date.now() || letter.expiresAt > letter.createdAt + (asSteward || toSteward ? STEWARD_LETTER_TTL_MS : LETTER_TTL_MS)) throw refused('message expired or timestamps invalid');
    const origin = asSteward ? 'steward' as const : toSteward && letter.origin === 'notice' ? 'notice' as const : undefined;
    const accepted: AgentLetter = { ...(origin ? { origin } : {}), id: letter.id, from, to: this.self(target.threadId), toTitle: target.title, toProject: target.project, toMachine: target.machine, text: text(letter.text, 'letter.text'), replyTo: letter.replyTo === null ? null : text(letter.replyTo, 'letter.replyTo', 100), createdAt: Date.now(), expiresAt: letter.expiresAt, status: 'received', error: null };
    this.core.journal.append({ type: 'coordination.received', threadId: target.threadId, version: 1, payload: accepted }, () => this.put(accepted, 'in', target.threadId));
    this.core.threads.runner.noteMail(target.threadId, accepted.createdAt);
    this.update(accepted, 'received');
    if (!this.handToWaiter(accepted)) this.kick(target.threadId);
    return this.find(accepted.id, 'in') ?? accepted;
  }
  private rows(where: string, ...params: (string | number)[]): Row[] { return this.core.journal.db.query(`SELECT data, fingerprint FROM coordination_letters WHERE ${where}`).all(...params) as Row[]; }
  private find(id: string, direction: string): AgentLetter | null {
    const row = this.rows('id = ? AND direction = ?', id, direction)[0];
    return row ? JSON.parse(row.data) as AgentLetter : null;
  }
  private put(letter: AgentLetter, direction: string, threadId: string, requestId: string | null = null, fingerprint: string | null = null): void {
    this.core.journal.db.query('INSERT INTO coordination_letters (id, thread_id, direction, status, created_at, request_id, fingerprint, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(letter.id, threadId, direction, letter.status, letter.createdAt, requestId, fingerprint, JSON.stringify(letter));
  }
  private update(letter: AgentLetter, status: AgentLetter['status'], error: string | null = null): void {
    const next = { ...letter, status, error };
    this.core.journal.append({ type: 'coordination.status', threadId: letter.to.coreId === this.self('').coreId ? letter.to.threadId : letter.from.threadId, version: 1, payload: { id: letter.id, status, error } }, () => {
      // Each endpoint retains its own send or receipt time when acknowledgement metadata arrives.
      this.core.journal.db.query("UPDATE coordination_letters SET status = ?, data = json_set(?, '$.createdAt', created_at) WHERE id = ?").run(status, JSON.stringify(next), letter.id);
    });
    for (const endpoint of [letter.from, letter.to]) if (endpoint.coreId === this.coreId) this.changed(endpoint.threadId);
  }
  private changed(threadId: string): void { this.core.bus.emit('collaboration.changed', { threadId }); }

  /** A notice the core sends a steward: a letter from one of its threads, received like any other. `key` makes it land once. */
  notice(stewardId: string, fromThreadId: string, body: string, key: string): AgentLetter | null {
    const id = createHash('sha256').update(key).digest('hex').slice(0, 32), createdAt = Date.now();
    return this.closed ? null : this.find(id, 'in') ?? this.receive({ origin: 'notice', id, from: this.contact(fromThreadId, true), to: this.self(stewardId), toTitle: '',
      text: body, replyTo: null, createdAt, expiresAt: createdAt + STEWARD_LETTER_TTL_MS, status: 'queued', error: null });
  }
  /** A revoked steward's undelivered letters and notices go nowhere. */
  stewardRevoked(stewardId: string): void {
    const pending = this.rows("status IN ('queued', 'received') AND json_extract(data, '$.origin') IN ('steward', 'notice')").map(row => JSON.parse(row.data) as AgentLetter);
    for (const letter of pending.filter(l => l.from.threadId === stewardId || l.to.threadId === stewardId)) this.update(letter, 'rejected', 'Steward grant revoked');
  }

  instructions(threadId: string): string {
    const config = this.config(threadId);
    return config.mode === 'off' ? '' : coordinationGuide(config.paused);
  }

  /** Hook delivery: one batch at a provider's next safe tool boundary. */
  take(threadId: string, turnId: string): string | null {
    // Off and paused hold ordinary letters through mayReceive; a steward's still pass.
    if (this.delivering.has(threadId)) return null;
    const letters = this.inbox(threadId);
    if (!letters.length) return null;
    this.restoreProject(threadId);
    const prompt = letterPrompt(letters);
    this.core.threads.noteCoordination(threadId, turnId, prompt);
    for (const letter of letters) this.update(letter, 'delivered');
    return prompt;
  }
  private inbox(threadId: string): AgentLetter[] {
    return this.rows("thread_id = ? AND direction = 'in' AND status = 'received' ORDER BY created_at LIMIT 4", threadId).map(r => JSON.parse(r.data) as AgentLetter).filter(letter => letter.expiresAt > Date.now() && this.mayReceive(letter));
  }
  private inProject(letter: AgentLetter): boolean {
    if (letter.from.coreId !== this.self('').coreId || letter.to.coreId !== this.coreId) return false;
    const from = this.core.journal.getThread(letter.from.threadId);
    const to = this.core.journal.getThread(letter.to.threadId);
    return from !== null && to !== null && from.projectId === to.projectId;
  }
  private mayReceive(letter: AgentLetter): boolean {
    const thread = this.core.journal.getThread(letter.to.threadId);
    if (!thread || thread.archived) return false;
    const stewarded = this.core.stewards.mayReceive(letter, letter.from.coreId === this.self('').coreId, this.config(letter.to.threadId).paused);
    if (stewarded !== null) return stewarded;
    const recipient = this.config(letter.to.threadId);
    if (recipient.mode === 'off' || recipient.paused) return false;
    if (letter.from.coreId !== this.self('').coreId) return recipient.remote && this.trusted().some(peer => peer.coreId === letter.from.coreId);
    const sender = this.config(letter.from.threadId);
    if (sender.mode === 'off') return false;
    return this.inProject(letter) || (recipient.remote && sender.remote);
  }
  queuedCancelled(threadId: string): void {
    for (const row of this.rows("thread_id = ? AND direction = 'in' AND status = 'uncertain'", threadId)) {
      const letter = JSON.parse(row.data) as AgentLetter;
      if (letter.error === 'Queued for provider delivery') this.update(letter, 'received');
    }
  }
  /** Recheck a queued batch immediately before it crosses the provider boundary. */
  prepareWake(threadId: string, turnId: string): boolean {
    const letters = this.rows("thread_id = ? AND direction = 'in' AND status = 'uncertain'", threadId)
      .map(row => JSON.parse(row.data) as AgentLetter).filter(letter => letter.error === 'Queued for provider delivery');
    if (!letters.length || this.closed || letters.some(letter => letter.expiresAt <= Date.now() || !this.mayReceive(letter))) return false;
    this.restoreProject(threadId);
    for (const letter of letters) this.update(letter, 'uncertain', `Awaiting provider turn ${turnId}`);
    return true;
  }
  private async steer(threadId: string, prompt: string): Promise<{ submitted: boolean } | null> {
    if (this.closed) return null;
    const stopped = Promise.withResolvers<null>();
    const cancel = () => stopped.resolve(null);
    this.localWaits.add(cancel);
    try {
      return await Promise.race([
        this.core.threads.steer(threadId, prompt).then(submitted => ({ submitted })),
        stopped.promise,
      ]);
    } finally { this.localWaits.delete(cancel); }
  }
  /** Restore on actual provider delivery, after pause, expiry and permission checks. */
  private restoreProject(threadId: string): void {
    const projectId = this.core.threads.require(threadId).projectId;
    if (projectId !== null && this.core.journal.getProject(projectId)?.archived) this.core.projects.archive(projectId, false);
  }
  private async deliver(threadId: string): Promise<void> {
    if (this.closed || this.delivering.has(threadId)) return;
    const thread = this.core.journal.getThread(threadId);
    if (!thread || thread.archived || thread.status === 'error' || thread.status === 'waiting' || thread.status === 'queued') return;
    const letters = this.inbox(threadId);
    if (!letters.length) return;
    this.delivering.add(threadId);
    try {
      const prompt = letterPrompt(letters);
      if (thread.status === 'running') {
        if (!this.core.threads.canSteer(threadId)) return;
        this.restoreProject(threadId);
        for (const letter of letters) this.update(letter, 'uncertain', 'Awaiting provider acknowledgement');
        try {
          const result = await this.steer(threadId, prompt);
          if (result === null || this.closed || this.core.journal.isClosed()) return;
          for (const letter of letters) {
            const current = this.find(letter.id, 'in');
            if (current?.status === 'uncertain' && current.error === 'Awaiting provider acknowledgement') this.update(current, result.submitted ? 'delivered' : 'received');
          }
        } catch (error) {
          if (this.closed || this.core.journal.isClosed()) return;
          for (const letter of letters) {
            const current = this.find(letter.id, 'in');
            if (current?.status === 'uncertain' && current.error === 'Awaiting provider acknowledgement') this.update(current, 'uncertain', messageOf(error));
          }
        }
      } else {
        // One transaction records the wake, message states and scheduled turn.
        this.core.journal.db.transaction(() => {
          for (const letter of letters) this.update(letter, 'uncertain', 'Queued for provider delivery');
          this.core.journal.db.query('INSERT INTO coordination_wakes VALUES (?, ?)').run(threadId, Date.now());
          this.core.threads.startTurn(threadId, prompt, [], undefined, 'coordination');
        })();
      }
    } catch (error) {
      if (!this.closed && !this.core.journal.isClosed()) {
        this.pause(threadId); this.core.log('warn', `coordination ${threadId}: ${messageOf(error)}`);
      }
    }
    finally { this.delivering.delete(threadId); }
  }
  /** A scheduled coordination turn reached its driver; no claim that the model read it. */
  submitted(threadId: string, turnId: string): void {
    for (const row of this.rows("thread_id = ? AND direction = 'in' AND status = 'uncertain'", threadId)) {
      const letter = JSON.parse(row.data) as AgentLetter;
      if (letter.error === `Awaiting provider turn ${turnId}`) this.update(letter, 'delivered');
    }
  }
  private async tick(): Promise<void> {
    if (this.closed || this.ticking) return;
    this.ticking = true;
    const job = this.work();
    this.pending.add(job);
    try { await job; } catch (error) { if (!this.closed) this.core.log('warn', `coordination: ${messageOf(error)}`); }
    finally { this.pending.delete(job); this.ticking = false; }
  }
  private async work(): Promise<void> {
    const now = Date.now();
    if (now - this.swept >= HOUR) {
      this.swept = now;
      this.core.journal.db.query('DELETE FROM coordination_wakes WHERE at < ?').run(now - HOUR);
      // A settled letter has nothing left to deliver or acknowledge: its expiry is 15
      // minutes, a receipt asks only for a letter that has not expired, and a thread
      // shows its last 100. An uncertain letter is settled too: it is never replayed,
      // and a month later no receipt will tell what became of it.
      this.core.journal.db.query("DELETE FROM coordination_letters WHERE status IN ('delivered', 'expired', 'rejected', 'uncertain') AND created_at < ?").run(now - LETTER_RETENTION_MS);
    }
    // Nothing waits on the sweep: a probe or two on the status index, then back to sleep.
    const db = this.core.journal.db;
    if (!db.query(SWEEP_PROBES[0]).get() && !db.query(SWEEP_PROBES[1]).get(now - LETTER_TTL_MS, now)) return;
    for (const row of this.rows("status IN ('queued', 'received') AND json_extract(data, '$.expiresAt') <= ?", Date.now())) this.update(JSON.parse(row.data), 'expired', 'Message expired before delivery');
    const threads = this.core.journal.db.query("SELECT DISTINCT thread_id FROM coordination_letters WHERE direction = 'in' AND status = 'received'").all() as { thread_id: string }[];
    for (const { thread_id } of threads) {
      if (this.closed) return;
      // One slow provider must not block delivery to every other local agent.
      if (this.delivering.size >= 4) break;
      const job = this.deliver(thread_id);
      this.pending.add(job);
      void job.finally(() => this.pending.delete(job));
    }
    const outgoing = this.rows("direction = 'out' AND status IN ('queued', 'received', 'uncertain') AND json_extract(data, '$.expiresAt') > ?", Date.now())
      .map(row => JSON.parse(row.data) as AgentLetter).filter(letter => letter.to.coreId !== this.self('').coreId);
    const ids = new Set(outgoing.map(l => l.id));
    for (const id of this.attempts.keys()) if (!ids.has(id)) this.attempts.delete(id);
    const next = outgoing.sort((a, b) => (this.attempts.get(a.id) ?? 0) - (this.attempts.get(b.id) ?? 0)).slice(0, 4);
    await Promise.all(next.map(letter => this.relay(letter)));
  }

  private async relay(letter: AgentLetter): Promise<void> {
      this.attempts.set(letter.id, Date.now());
      const sender = this.core.journal.getThread(letter.from.threadId);
      if (!sender || sender.archived) { this.update(letter, 'rejected', 'Thread archived or removed'); return; }
      const config = this.config(letter.from.threadId);
      const peer = this.trusted().find(p => p.coreId === letter.to.coreId);
      if (!peer || !config.remote || config.mode === 'off') { this.update(letter, 'rejected', 'Machine permission revoked'); return; }
      if (config.paused && letter.status === 'queued') return;
      try {
        const answer = await this.exchange(peer, letter.status === 'queued' ? 'deliver' : 'receipt', letter.status === 'queued' ? letter : { id: letter.id, fromThreadId: letter.from.threadId }) as AgentLetter;
        if (this.closed) return;
        if (!this.trusted().some(p => p.coreId === peer.coreId) || !this.config(letter.from.threadId).remote) { this.update(letter, 'rejected', 'Machine permission revoked'); return; }
        if (!answer || answer.id !== letter.id || !same(answer.from, letter.from) || !same(answer.to, letter.to) || !['received', 'delivered', 'uncertain', 'expired', 'rejected'].includes(answer.status)) throw new Error('invalid delivery receipt');
        const title = text(answer.toTitle, 'receipt.toTitle', 200);
        const error = answer.error === null ? null : text(answer.error, 'receipt.error', 4000);
        const projectName = answer.toProject === undefined ? undefined : text(answer.toProject, 'receipt.toProject', 200);
        if (letter.status !== answer.status || letter.error !== error || letter.toTitle !== title || letter.toProject !== projectName || letter.toMachine !== peer.name) this.update({ ...letter, toTitle: title, toProject: projectName, toMachine: peer.name }, answer.status, error);
      } catch (error) {
        if (this.closed) return;
        // Transport failures remain retryable; signed explicit refusals are terminal.
        if (error instanceof PeerRefusal) this.update(letter, 'rejected', error.message);
        else if (letter.error !== 'Machine unreachable; retrying until expiry') this.update(letter, letter.status, 'Machine unreachable; retrying until expiry');
      }
  }

  /** One signed request to a member of this core's group. */
  request(peer: CoordinationPeer, operation: Operation, payload: unknown): Promise<unknown> { return this.exchange(peer, operation, payload); }

  /**
   * A member of a group answers on several addresses and this core cannot know
   * which one reaches it today: the one that answered last is asked first, the
   * others when it fails or stays silent, and the first verified reply counts
   * (`firstAnswer`). When none answers, the owner's app relays, if it holds
   * both machines.
   */
  private async exchange(peer: CoordinationPeer, operation: Operation, payload: unknown): Promise<unknown> {
    this.identityKey();
    // Signed and sealed anew for every address tried, the owner's app included: the same request sent twice
    // is a replay at a machine both addresses lead to, refused there, and every operation bears being asked twice.
    const routes = this.core.group.routes(peer.coreId);
    const attempt = async (url: string | null): Promise<Answer> => {
      const nonce = randomUUID();
      const body = JSON.stringify({ from: this.coreId, to: peer.coreId, at: Date.now(), nonce, operation, payload } satisfies Envelope);
      const signed = sign(null, Buffer.from(body), this.key!).toString('base64');
      const sealing = this.core.group.sealFor(peer.coreId, pack(body, signed));
      // Begun for a member of the group, it ends sealed or not at all: this core may have left the group between two attempts.
      if (routes !== null && sealing === null) throw new Error('no longer in the group this request was for');
      const wire = sealing === null ? body : sealing.body;
      const signature = sealing === null ? signed : SEALED;
      if (url !== null) return post(url, this.coreId, peer.publicKey, wire, signature, nonce, sealing);
      const response = await this.bridge.request(peer.coreId, { fromCoreId: this.coreId, toCoreId: peer.coreId, body: wire, signature });
      return settle(null, peer.publicKey, nonce, response.status, response.body, response.signature, sealing);
    };
    let answer: Answer;
    if (routes === null) answer = await attempt(this.bridge.available(peer.coreId) || peer.viaClient ? null : peer.url);
    else {
      try { answer = await firstAnswer(routes, attempt); }
      catch (error) {
        if (this.bridge.available(peer.coreId)) answer = await attempt(null);
        else throw error instanceof AggregateError ? error.errors[0] ?? new Error('peer unreachable') : error;
      }
    }
    if (answer.url !== null) this.core.group.reached(peer.coreId, answer.url);
    if (answer.gone) throw new PeerGone('removed from the group');
    if (answer.refusal !== undefined) throw new PeerRefusal(answer.refusal);
    return answer.result;
  }
  async http(request: Request): Promise<Response> {
    if (this.closed || request.method !== 'POST' || request.headers.has('origin')) return new Response('forbidden', { status: 403 });
    const id = request.headers.get('x-boite-peer');
    // A machine its group removed still signs with a key this core knows, so it can be told and leave.
    const peer = this.trusted().find(p => p.coreId === id) ?? this.core.group.removedPeer(id);
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
      if (envelope.from !== peer.coreId || envelope.to !== this.self('').coreId || !Number.isSafeInteger(envelope.at) || Math.abs(now - envelope.at) > 60_000) throw new Error('invalid envelope');
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
      if (rate.count > 120) return new Response('peer rate limit', { status: 429 });
    } catch { return new Response('invalid signed message', { status: 403 }); }
    if (this.core.group.removedPeer(peer.coreId) !== null && (envelope.operation === 'group.sync' || !this.trusted().some(p => p.coreId === peer.coreId))) {
      return this.signed({ nonce: envelope.nonce, error: 'this machine was removed from the group', gone: true }, 410, sealing);
    }
    // A machine trusted through the group alone speaks sealed, and the roster is never exchanged readable.
    if (sealing === null && (envelope.operation === 'group.sync' || !this.peers().some(p => p.coreId === peer.coreId))) {
      return this.signed({ nonce: envelope.nonce, error: 'machines of a group exchange sealed requests only' }, 400);
    }
    // Reading an unsigned body cannot hold an update. Admission may have won
    // during that await, so authenticated processing must enter the same gate.
    if (this.closed || this.core.stopping) return new Response('the core is stopping', { status: 503 });
    return this.core.router.trackRequest(() => {
      let result: unknown;
      let error: string | undefined;
      let status = 200;
      try {
        // A revoke while the body streamed wins before any data is read or changed.
        const currentPeer = this.trusted().find(p => p.coreId === peer.coreId);
        if (!currentPeer) throw refused('peer permission revoked');
        if (envelope.operation === 'directory') result = this.localDirectory();
        else if (envelope.operation === 'deliver') result = this.receive(envelope.payload as AgentLetter, peer);
        else if (envelope.operation === 'search') {
          const words = searchWords(((envelope.payload as { words?: unknown })?.words as string[] | undefined)?.join?.(' '));
          result = searchContacts(this.core.journal.db, this.localDirectory(), words, currentPeer.readThreads === true);
        } else if (envelope.operation === 'read') {
          if (!currentPeer.readThreads) throw refused('agents on this machine are not allowed to read conversations; enable their access in Machines on the destination');
          const payload = envelope.payload as { threadId?: unknown; limit?: unknown; before?: unknown };
          const threadId = text(payload?.threadId, 'read.threadId', 128);
          const limit = payload.limit === undefined ? 30 : payload.limit;
          if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 100) throw invalidParams('read.limit: expected 1 to 100');
          if (payload.before !== undefined && !Number.isSafeInteger(payload.before)) throw invalidParams('read.before: expected a timestamp');
          const contact = this.localDirectory().find(a => a.threadId === threadId);
          if (!contact) throw refused('read.threadId: not a thread open to other machines');
          result = { contact, ...transcript(this.core.journal.db, threadId, limit as number, payload.before as number | undefined) };
        }
        else if (envelope.operation === 'receipt') {
          const payload = envelope.payload as { id: string; fromThreadId: string };
          const letter = this.find(text(payload?.id, 'receipt.id', 100), 'in');
          if (!letter || letter.from.coreId !== peer.coreId || letter.from.threadId !== payload.fromThreadId) throw refused('unknown receipt');
          result = letter;
        } else if (envelope.operation === 'group.sync') result = this.core.group.receive(peer, envelope.payload);
        else throw invalidParams('operation: expected directory, deliver, receipt, search, read or group.sync');
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
    const signature = this.signature(Buffer.from(raw)).toString('base64');
    const body = sealing === null ? raw : sealResponse(pack(raw, signature), sealing.responseKey, sealing.context);
    return new Response(body, { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-boite-signature': sealing === null ? signature : SEALED } });
  }
  /** The owner app forwards the original signed envelope, without changing any peer permission. */
  async forward(params: RpcParams<'collaboration.bridge.forward'>): Promise<CoordinationBridgeResponse> {
    const coreId = text(params.coreId, 'coreId', 100);
    if (typeof params.body !== 'string' || Buffer.byteLength(params.body) > MAX_BODY) throw invalidParams('body: expected at most 262144 bytes');
    if (typeof params.signature !== 'string' || params.signature.length > 1000) throw invalidParams('signature: expected at most 1000 characters');
    const response = await this.http(new Request(`http://127.0.0.1${ROUTE}`, { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-boite-peer': coreId, 'x-boite-signature': params.signature }, body: params.body }));
    return { status: response.status, body: await boundedBody(response.body), signature: response.headers.get('x-boite-signature') ?? '' };
  }
  beginClose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const cancel of this.localWaits) cancel();
    this.localWaits.clear();
    this.bridge.close();
    clearInterval(this.timer); this.off();
    for (const set of [...this.waiters.values()]) for (const waiter of [...set]) waiter.done([]);
  }
  async close(): Promise<void> { this.beginClose(); await Promise.allSettled([...this.pending]); }
}

export function registerCoordination(core: Core): void {
  core.router.register('collaboration.get', p => core.coordination.get(p.threadId));
  core.router.register('collaboration.configure', p => core.coordination.configure(p.threadId, p.config));
  core.router.register('collaboration.directory', p => core.coordination.directory(p.threadId));
  core.router.register('collaboration.send', p => core.coordination.send(p));
  core.router.register('collaboration.search', p => core.coordination.search(p.threadId, p.query));
  core.router.register('collaboration.read', p => core.coordination.read(p.threadId, p.target, p.limit, p.before));
  core.router.register('collaboration.wait', p => core.coordination.wait(p.threadId, p.from, p.timeoutMs));
  core.router.register('collaboration.identity', () => core.coordination.identity());
  core.router.register('collaboration.peers', () => core.coordination.peers());
  core.router.register('collaboration.check', p => core.coordination.check(p.coreId));
  core.router.register('collaboration.trust', p => core.coordination.trust(p.peer));
  core.router.register('collaboration.untrust', p => core.coordination.untrust(p.coreId));
  core.router.register('collaboration.bridge.register', (p, ctx) => {
    if (!core.coordination.trusted().some(peer => peer.coreId === p.coreId)) throw refused('coreId: expected a machine trusted for coordination');
    return core.coordination.bridge.register(p.coreId, p.enabled, ctx.connection);
  });
  core.router.register('collaboration.bridge.forward', p => core.coordination.forward(p));
  core.router.register('collaboration.bridge.reply', (p, ctx) => core.coordination.bridge.reply(p.requestId, p.response, ctx.connection));
}

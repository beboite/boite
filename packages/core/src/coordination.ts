import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { threadActive, defaultCoordinationConfig, TEAM_LETTERS_PER_BATCH } from '@boite/contracts';
import type { AgentAddress, AgentContact, AgentLetter, AgentMatch, AgentTranscript, ContactRequest, CoordinationBridgeResponse, CoordinationConfig, CoordinationPeer, CoordinationView, RpcParams, ThreadStatus } from '@boite/contracts';
import { checkRemoteContact } from './coordination-lookup.ts';
import { CoordinationLookups } from './coordination-directory.ts';
import { PeerDesk } from './coordination-peer.ts';
import { CoordinationBridge } from './coordination-bridge.ts';
import { dropGroupRead, policedRoutes, policyAllowsLetter } from './coordination-group.ts';
import { address, coordinationGuide, coordinationUrl, LETTER_TTL_MS, letterPrompt, RESIDENT_LETTER_TTL_MS, same, text } from './coordination-letter.ts';
import { projectName, senderContext, withProjects, withRelations } from './coordination-relation.ts';
import { firstAnswer, PeerGone, PeerRefusal, post, settle, type Answer, type Envelope, type Operation } from './coordination-wire.ts';
import { checkTailnetName } from './contacts/invite.ts';
import { outgoingContact, incomingContact } from './contacts/human-letters.ts';
import {contactMailGate, protectLetters} from './contacts/letter-scopes.ts';
import type { Connection } from './router.ts';
import { pack, SEALED } from './group/seal.ts';
import type { Core } from './core.ts';
import { invalidParams, messageOf, refused, RpcFailure, unavailable } from './errors.ts';
import { isAgentHeld } from './agents/runtime.ts';
import { ContactMailboxes } from './contacts/mailboxes.ts';
import { forwardCoordination } from './coordination-rpc.ts';
import { trustCoordination, trustedCoordinationPeers } from './coordination-trust.ts';
import { TeamLetters } from './coordination-team.ts';

const HOUR = 3_600_000;
/** How long a delivered, expired, rejected or uncertain letter stays in the journal. */
export const LETTER_RETENTION_MS = 30 * 24 * HOUR;
/** Marks a pause the core applied by itself, as opposed to the owner's in Communication settings. */
const AUTO_PAUSE_PREFIX = 'coordination-autopause:';
/** Letters one hook, steer or wake hands over. */
const BATCH = 4;
/** The sweep's idle probes, each one read on the status index: letters it still has work for. */
export const SWEEP_PROBES = [
  "SELECT 1 FROM coordination_letters WHERE status IN ('queued', 'received') LIMIT 1",
  // An uncertain letter is never replayed. Only an outgoing one is asked about again, until it expires.
  "SELECT 1 FROM coordination_letters WHERE status = 'uncertain' AND direction = 'out' AND created_at > ? AND json_extract(data, '$.expiresAt') > ? LIMIT 1",
] as const;
/** The longest `collaboration.wait`: a CLI call stays under its five-minute RPC deadline. */
export const WAIT_MAX_MS = 300_000;
export { coordinationUrl, letterPrompt, RESIDENT_LETTER_TTL_MS };
type Row = { data: string; fingerprint: string | null };

export class Coordination {
  readonly bridge = new CoordinationBridge();
  readonly mailboxes: ContactMailboxes;
  readonly teamLetters: TeamLetters;
  readonly #lookups: CoordinationLookups;
  #key: ReturnType<typeof createPrivateKey> | null = null;
  #publicKey = '';
  #coreId = '';
  #closed = false;
  /** Releases local acknowledgement waits before driver teardown can reject them. */
  readonly #localWaits = new Set<() => void>();
  readonly #pending = new Set<Promise<unknown>>();
  readonly #delivering = new Set<string>();
  /** The letters `admit` let through, while their sink records them. */
  #admitting: Set<string> | null = null;
  /** Answers other cores' signed requests. */
  private readonly desk: PeerDesk;
  readonly #attempts = new Map<string, number>();
  /** Agents blocked in `collaboration.wait`, by thread. */
  readonly #waiters = new Map<string, Set<{ from: AgentAddress | null; done: (letters: AgentLetter[]) => void; fail: (error: unknown) => void }>>();
  #ticking = false;
  readonly #timer: ReturnType<typeof setInterval>;
  readonly #off: () => void;
  /** When the sweep last pruned the wake log and old letters; both are hourly bookkeeping. */
  private swept = 0;

  /** `threadJsonChecked`: the core already validated visible thread JSON at this start. */
  readonly #core: Core;
  constructor(core: Core, threadJsonChecked = false) {
    this.#core = core;
    this.mailboxes = new ContactMailboxes(core);
    this.teamLetters = new TeamLetters(core, { rows: (where, ...params) => this.rows(where, ...params), update: (letter, status, error) => this.update(letter, status, error), accept: letter => this.acceptLetter(letter),
      receive: (letter, threadId) => this.#core.journal.append({ type: 'coordination.received', threadId, version: 1, payload: letter }, () => this.#put(letter, 'in', threadId)),
      kick: threadId => this.#kick(threadId), changed: threadId => this.#changed(threadId), handToWaiter: threadId => this.#handToWaiter(threadId, null), self: threadId => this.#self(threadId) });
    this.#lookups = new CoordinationLookups(core, {
      selfId: () => this.#self('').coreId, config: threadId => this.config(threadId), trusted: () => this.trusted(), localReach: threadId => this.#localReach(threadId),
      contact: (threadId, resident) => this.#contact(threadId, resident), checkLookupAccess: (threadId, remote) => this.checkLookupAccess(threadId, remote), mailboxes: this.mailboxes,
    });
    this.desk = new PeerDesk(core, {
      closed: () => this.#closed, selfId: () => this.#self('').coreId, trusted: () => this.trusted(), peers: () => this.peers(), signature: input => this.signature(input),
      directory: () => this.localDirectory(), contactDirectory: coreId => this.contactDirectory(coreId), receive: (letter, peer) => this.mailboxes.receive(letter, peer) ?? this.#receive(letter, peer), received: id => this.#find(id, 'in') ?? this.mailboxes.received(id),
    });
    // A restart keeps idle contacts reachable, but never replays pending work automatically.
    if (!threadJsonChecked) core.journal.validateVisibleThreadJson();
    const candidates = core.journal.db.query(`SELECT settings.key, settings.value, threads.rowid FROM settings JOIN threads ON settings.key = 'coordination:' || threads.id
      WHERE threads.id NOT IN (SELECT thread_id FROM thread_deletions) AND (typeof(settings.value) <> 'text' OR NOT json_valid(settings.value))
      ORDER BY threads.rowid`).all() as { key: string; value: string; rowid: number }[];
    // Find the real parser error now; report it after the preceding recovery writes.
    const invalidConfig = candidates.find(({ value }) => { try { JSON.parse(value); return false; } catch { return true; } });
    const interrupted = core.journal.db.query(`SELECT id, status, rowid FROM threads WHERE id NOT IN (SELECT thread_id FROM thread_deletions)
      AND (? IS NULL OR rowid <= ?) AND (status IN ('queued', 'running', 'waiting') OR rowid = ?
        OR id IN (SELECT thread_id FROM coordination_letters WHERE status IN ('queued', 'received', 'uncertain')))
      ORDER BY rowid`).all(invalidConfig?.rowid ?? null, invalidConfig?.rowid ?? null, invalidConfig?.rowid ?? null) as { id: string; status: ThreadStatus; rowid: number }[];
    for (const thread of interrupted) {
      if (thread.rowid === invalidConfig?.rowid) core.journal.getSetting(invalidConfig.key);
      const pending = core.journal.db.query("SELECT 1 FROM coordination_letters WHERE thread_id = ? AND (status IN ('queued', 'received') OR (status = 'uncertain' AND json_extract(data, '$.error') = 'Queued for provider delivery')) LIMIT 1").get(thread.id);
      if (pending || threadActive(thread.status)) this.pause(thread.id, 'restart');
    }
    // A thread that finishes a turn can take its waiting letters now, not at the next sweep.
    this.#off = core.bus.onAny((name, payload) => {
      if (name === 'turn.finished' && !this.#closed) this.#kick((payload as { threadId: string }).threadId);
    });
    // The sweep remains for expiry, remote retries and a steer a driver was not ready for.
    this.#timer = setInterval(() => { void this.tick(); }, 2000);
    this.#timer.unref?.();
  }

  /** Delivery to one thread once the current synchronous work (a journal write, a turn end) is done. */
  #kick(threadId: string): void {
    queueMicrotask(() => {
      if (this.#closed || this.#core.journal.isClosed()) return;
      const job = this.deliver(threadId).catch(error => { if (!this.#closed) this.#core.log('warn', `coordination ${threadId}: ${messageOf(error)}`); });
      this.#pending.add(job);
      void job.finally(() => this.#pending.delete(job));
    });
  }

  #identityKey(): void {
    if (this.#key) return;
    const file = join(this.#core.dataDir, 'coordination-key.pem');
    if (!existsSync(file)) {
      const pair = generateKeyPairSync('ed25519');
      writeFileSync(file, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
    }
    this.#key = createPrivateKey(readFileSync(file));
    this.#publicKey = createPublicKey(this.#key).export({ type: 'spki', format: 'pem' }).toString();
    this.#coreId = createHash('sha256').update(this.#publicKey).digest('hex');
  }
  identity(): CoordinationPeer {
    this.#identityKey();
    return { coreId: this.#coreId, name: this.#core.info().hostname ?? 'Boite', url: coordinationUrl(this.#core.settings.get().publicUrl || this.#core.baseUrl()), publicKey: this.#publicKey };
  }
  #self(threadId: string): AgentAddress { this.#identityKey(); return { coreId: this.#coreId, threadId }; }
  /** This core's identity without an address: what a group lists and signs with. */
  card(): { coreId: string; publicKey: string } { this.#identityKey(); return { coreId: this.#coreId, publicKey: this.#publicKey }; }
  signature(input: Buffer): Buffer { this.#identityKey(); return sign(null, input, this.#key!); }
  /** The links the owner made by hand, each with its own permissions. A group's members are trusted too, and listed by the group. */
  peers(): CoordinationPeer[] { return (this.#core.journal.getSetting('coordination:peers') as CoordinationPeer[] | undefined) ?? []; }
  trusted(): CoordinationPeer[] { return trustedCoordinationPeers(this.#core); }
  async check(coreId: string): Promise<{ ok: true }> {
    const peer = this.trusted().find(p => p.coreId === coreId);
    if (!peer) throw refused('machine is not trusted for coordination');
    try { await this.exchange(peer, 'directory', {}); }
    catch (error) {
      if (error instanceof RpcFailure) throw error;
      const source = this.#core.info().hostname ?? 'Boite';
      this.#core.log('warn', `agent link ${source} -> ${peer.name} at ${peer.url}: ${messageOf(error)}`, { source: 'coordination', event: 'coordination.link-failed' });
      throw unavailable(`${source} could not verify the agent link to ${peer.name} at ${peer.url}. Check that both machines can reach each other's HTTPS address.`);
    }
    return { ok: true };
  }
  trust(peer: CoordinationPeer): CoordinationPeer { return trustCoordination(this.#core, peer); }
  untrust(coreId: string, preserveGroupRead = false): { ok: true } {
    if (!preserveGroupRead) dropGroupRead(this.#core, coreId);
    this.#core.journal.setSetting('coordination:peers', this.peers().filter(p => p.coreId !== coreId));
    // Still a member of this core's group: its letters keep crossing.
    if (this.trusted().some(p => p.coreId === coreId)) return { ok: true };
    this.bridge.revoke(coreId);
    const queued = this.rows("status = 'uncertain'").map(row => JSON.parse(row.data) as AgentLetter)
      .filter(letter => letter.error === 'Queued for provider delivery' && (letter.from.coreId === coreId || letter.to.coreId === coreId));
    for (const threadId of new Set(queued.map(letter => letter.to.threadId))) this.#core.threads.stopQueuedCoordination(threadId);
    for (const row of this.rows("status IN ('queued', 'received')")) {
      const letter = JSON.parse(row.data) as AgentLetter;
      if (letter.from.coreId === coreId || letter.to.coreId === coreId) this.update(letter, 'rejected', 'Machine permission revoked');
    }
    return { ok: true };
  }
  config(threadId: string): CoordinationConfig {
    const saved = this.#core.journal.getSetting(`coordination:${threadId}`) as CoordinationConfig | undefined;
    if (saved) return saved;
    // A bot's thread starts on like any other: it finds, reads and messages threads without the owner turning it on,
    // and still reaches the threads of its projects as theirs (`resident` letters) whatever this says.
    return defaultCoordinationConfig();
  }
  #saveConfig(threadId: string, config: CoordinationConfig): void {
    this.#core.journal.setSetting(`coordination:${threadId}`, config);
    this.#core.bus.emit('collaboration.changed', { threadId });
  }
  configure(threadId: string, config: CoordinationConfig): CoordinationView {
    const thread = this.#core.threads.require(threadId);
    if (thread.archived) throw refused('coordination requires an unarchived thread');
    if (!config || !['off', 'brief', 'team'].includes(config.mode) || typeof config.resources !== 'string' || config.resources.length > 500 || typeof config.remote !== 'boolean' || typeof config.paused !== 'boolean') throw invalidParams('config: expected mode off/brief/team, resources up to 500 characters, remote and paused booleans');
    // The owner's own choice, pause included, is never lifted by a later message.
    this.#core.journal.deleteSetting(`${AUTO_PAUSE_PREFIX}${threadId}`);
    this.#saveConfig(threadId, { mode: config.mode, resources: config.resources, remote: config.remote, paused: config.paused });
    // Team letters answer to their team (`docs/teams.md`), not to this switch: their wakes and inbox stay.
    if (config.paused && !this.teamLetters.onlyQueued(threadId)) this.#core.threads.stopQueuedCoordination(threadId);
    if (config.mode === 'off' || !config.remote) {
      const queued = this.rows("thread_id = ? AND status = 'uncertain'", threadId).map(row => JSON.parse(row.data) as AgentLetter)
        .filter(letter => !letter.team && letter.error === 'Queued for provider delivery' && (config.mode === 'off' || !this.#inProject(letter)));
      for (const target of new Set(queued.filter(letter => letter.to.coreId === this.#self('').coreId).map(letter => letter.to.threadId))) {
        this.#core.threads.stopQueuedCoordination(target);
      }
    }
    for (const row of config.mode === 'off' || !config.remote ? this.rows("thread_id = ? AND status IN ('queued', 'received')", threadId) : []) {
      const letter = JSON.parse(row.data) as AgentLetter;
      if (letter.team) continue;
      if (config.mode === 'off') this.update(letter, 'rejected', 'Coordination disabled');
      else if (!this.#inProject(letter)) this.update(letter, 'rejected', 'Cross-project or cross-machine coordination disabled');
    }
    return this.get(threadId);
  }
  /**
   * A pause the core applies by itself (Stop, a restart, a failed wake). It lasts until the user's next message;
   * after a restart or a failed wake, another agent's next letter ends it too, so a crashed thread can be woken.
   */
  pause(threadId: string, reason: 'stop' | 'restart' | 'failure' = 'stop'): void {
    const config = this.config(threadId);
    if (config.mode === 'off') return;
    if (config.paused) {
      // Stop over a restart's or a failed wake's pause makes it Stop's; the owner's pause carries no reason and stays as it is.
      if (reason === 'stop' && this.#wakesForAgent(threadId)) this.#core.journal.setSetting(`${AUTO_PAUSE_PREFIX}${threadId}`, reason);
      return;
    }
    this.#core.journal.setSetting(`${AUTO_PAUSE_PREFIX}${threadId}`, reason);
    this.#saveConfig(threadId, { ...config, paused: true });
  }
  /** The user wrote to the thread again: a pause the core applied by itself ends, the owner's stays. */
  resumeForUser(threadId: string): void {
    if (!this.#core.journal.getSetting(`${AUTO_PAUSE_PREFIX}${threadId}`)) return;
    this.#core.journal.deleteSetting(`${AUTO_PAUSE_PREFIX}${threadId}`);
    const config = this.config(threadId);
    if (config.paused) this.#saveConfig(threadId, { ...config, paused: false });
  }
  /** A pause another agent's letter ends: a restart's or a failed wake's, not Stop's or the owner's. One saved before reasons were recorded reads as a restart's. */
  #wakesForAgent(threadId: string): boolean {
    const reason = this.#core.journal.getSetting(`${AUTO_PAUSE_PREFIX}${threadId}`);
    return Boolean(reason) && reason !== 'stop';
  }
  /**
   * The owner trusted the contact mail a held wake refused, or let held mail through: a failure's pause ends,
   * Stop's and the owner's stay, and the letters go again, to an agent waiting for them first.
   */
  resumeTrusted(threadId: string): void {
    this.#resumeForAgent(threadId);
    this.#handToWaiter(threadId, null);
    this.#kick(threadId);
  }
  /** The owner refused contact mail held for it: its sender reads why. */
  refuseHeld(letter: AgentLetter, reason: string): void { this.update(letter, 'rejected', reason); }
  #resumeForAgent(threadId: string): void {
    if (this.#wakesForAgent(threadId)) this.resumeForUser(threadId);
  }
  get(threadId: string): CoordinationView {
    this.#core.threads.require(threadId);
    const config = this.config(threadId);
    return {
      self: this.#self(threadId), config,
      messages: withRelations(this.#core, this.#self('').coreId, threadId, this.rows('thread_id = ? ORDER BY created_at DESC LIMIT 100', threadId).map(r => withProjects(this.#core, this.#coreId, JSON.parse(r.data) as AgentLetter)).reverse()),
      sent: this.#count(threadId, 'out'), sendLimit: null,
      wakes: (this.#core.journal.db.query('SELECT count(*) AS n FROM coordination_wakes WHERE thread_id = ? AND at > ?').get(threadId, Date.now() - HOUR) as { n: number }).n,
      wakeLimit: null,
    };
  }
  #count(threadId: string, direction: string): number {
    return (this.#core.journal.db.query('SELECT count(*) AS n FROM coordination_letters WHERE thread_id = ? AND direction = ? AND created_at > ?').get(threadId, direction, Date.now() - HOUR) as { n: number }).n;
  }
  /** `resident`: a persistent agent reaches the threads of its projects whatever their communication settings, or its own, say. */
  #contact(threadId: string, resident = false): AgentContact {
    const thread = this.#core.threads.require(threadId);
    const config = this.config(threadId);
    // A team chat is no contact: its posts reach only its members, through the team.
    if (thread.archived || thread.teamId || (config.mode === 'off' && !resident)) throw refused('recipient is unavailable or coordination is disabled');
    const project = thread.projectId === null ? null : this.#core.journal.getProject(thread.projectId);
    return {
      ...this.#self(threadId), title: thread.title.slice(0, 200), machine: this.#core.info().hostname ?? 'Boite', resources: config.resources, status: thread.status, mode: config.mode,
      ...(project ? { project: project.name.slice(0, 200) } : {}),
      agent: `${thread.providerId}${thread.model ? ` ${thread.model}` : ''}`.slice(0, 200),
      branch: thread.branch === null ? null : thread.branch.slice(0, 200),
      activeAt: thread.updatedAt,
      lastCompletedAt: this.#core.journal.lastCompletedAt(threadId),
      projectArchived: project?.archived === true,
      // Paused for a sender only when its letter would wait: one a restart left ends with that letter.
      paused: config.paused && !this.#wakesForAgent(threadId),
    };
  }
  /** This thread as the directory lists it: what a contact request names as its sender. */
  describe(threadId: string): AgentContact { return this.#contact(threadId); }
  /**
   * What a contact's agents see: the threads of the projects opened to it,
   * each still under its own settings (on, and open to other machines).
   */
  contactDirectory(coreId: string): AgentContact[] {
    return this.#core.contacts.reach.granted(coreId).filter(projectId => this.#core.journal.getProject(projectId) !== null)
      .flatMap(projectId => this.localDirectory(projectId)).filter(contact => this.config(contact.threadId).remote)
      .sort((a, b) => (b.activeAt ?? 0) - (a.activeAt ?? 0)).slice(0, 100);
  }
  /** Reachable threads, the most recently active first: an old thread never hides a live one. */
  private localDirectory(projectId?: string): AgentContact[] {
    return this.#core.journal.listThreads(projectId)
      .filter(t => !t.archived && !t.teamId && this.config(t.id).mode !== 'off' && (projectId !== undefined || this.config(t.id).remote))
      .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 100).map(t => this.#contact(t.id));
  }
  /** What this thread may reach on its own core: its project, and every remote-enabled thread when it is one too. */
  #localReach(threadId: string): AgentContact[] {
    const thread = this.#core.threads.require(threadId);
    const config = this.config(threadId);
    if (thread.archived || config.mode === 'off') return [];
    const local = thread.projectId === null ? [] : this.localDirectory(thread.projectId);
    if (config.remote) for (const contact of this.localDirectory()) if (!local.some(a => same(a, contact))) local.push(contact);
    return local;
  }
  /** Only access permissions invalidate a pending lookup; pausing delivery does not revoke reads. */
  checkLookupAccess(threadId: string, remote: boolean): void {
    const thread = this.#core.threads.require(threadId);
    const config = this.config(threadId);
    if (thread.archived || config.mode === 'off' || (remote && !config.remote)) {
      throw refused('coordination permissions changed; retry the lookup', {
        field: 'threadId', threadId, expected: remote ? 'an unarchived thread with remote coordination enabled' : 'an unarchived thread with coordination enabled',
      });
    }
  }
  directory(threadId: string): Promise<{ agents: AgentContact[]; unavailable: string[] }> { return this.#lookups.directory(threadId); }
  /** Contacts here and on trusted machines whose fields or chat contain every word of the query. */
  search(threadId: string, query: string): Promise<{ matches: AgentMatch[]; unavailable: string[] }> { return this.#lookups.search(threadId, query); }
  /** Another reachable contact's conversation, text and tool names only. */
  read(threadId: string, target: AgentAddress, limit = 30, before?: number): Promise<AgentTranscript> { return this.#lookups.read(threadId, target, limit, before); }
  /**
   * Blocks until an incoming message (from `from` when given) arrives or the
   * timeout passes. What it returns counts as delivered: the agent read it in
   * its tool output, so no hook or steer injects it again.
   */
  wait(threadId: string, from: AgentAddress | undefined, timeoutMs: number, connection?: Connection): Promise<{ letters: AgentLetter[] }> {
    this.#contact(threadId);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > WAIT_MAX_MS) throw invalidParams(`timeoutMs: expected 0 to ${WAIT_MAX_MS}`);
    const sender = from === undefined ? null : address(from, 'from');
    const ready = this.claim(threadId, sender);
    if (ready.length > 0 || timeoutMs === 0) return Promise.resolve({ letters: ready });
    return new Promise((resolve, reject) => {
      const set = this.#waiters.get(threadId) ?? new Set();
      this.#waiters.set(threadId, set);
      let off: (() => void) | undefined;
      const leave = () => { clearTimeout(timer); off?.(); set.delete(waiter); if (set.size === 0) this.#waiters.delete(threadId); };
      const waiter = { from: sender, done: (letters: AgentLetter[]) => { leave(); resolve({ letters }); }, fail: (error: unknown) => { leave(); reject(error); } };
      const timer = setTimeout(() => waiter.done([]), timeoutMs);
      set.add(waiter);
      // A departed CLI cannot read tool output; its waiter must leave the next letter for provider delivery.
      off = connection?.onClose?.(() => waiter.done([]));
    });
  }
  /** Received letters for this thread, from one sender or any, marked delivered. */
  private claim(threadId: string, from: AgentAddress | null): AgentLetter[] {
    return this.admit(threadId, this.#ready(threadId, Infinity, from), batch => {
      if (batch.length > 0) this.#restoreProject(threadId);
      // A waiter reads a team letter as rendered, never its raw triggers.
      const { texts } = this.teamLetters.render(threadId, batch, 'seen');
      for (const letter of batch) this.update(letter, 'delivered');
      return withRelations(this.#core, this.#self('').coreId, threadId, batch.map(letter => ({ ...letter, ...(texts.has(letter.id) ? { text: texts.get(letter.id)! } : {}), status: 'delivered' as const })));
    }, () => this.#ready(threadId, Infinity, from, true));
  }
  /**
   * A waiting agent takes the letter that just arrived, with what else it may read now. Mail held from
   * one waiter may still reach the next; a fault fails the waiter that read, never the letter's sender.
   */
  #handToWaiter(threadId: string, from: AgentAddress | null): void {
    for (const waiter of this.#waiters.get(threadId) ?? []) {
      if (from !== null && waiter.from !== null && !same(waiter.from, from)) continue;
      let letters: AgentLetter[];
      try { letters = this.claim(threadId, waiter.from); } catch (error) { waiter.fail(error); continue; }
      if (letters.length > 0) return waiter.done(letters);
    }
  }
  async send(params: RpcParams<'collaboration.send'>, human = false, connection?: Connection): Promise<AgentLetter> {
    const to = address(params.to, 'to');
    const local = to.coreId === this.#self('').coreId;
    const resident = local ? this.#core.workforce.projects.over(params.threadId, to.threadId) : null;
    let from = this.#contact(params.threadId, resident !== null);
    const config = this.config(params.threadId);
    if (config.paused) throw refused('coordination paused by the owner');
    const body = text(params.text, 'text');
    const requestId = text(params.requestId, 'requestId', 128);
    const fingerprint = createHash('sha256').update(JSON.stringify([to, body, params.replyTo ?? null, ...(human ? ['contact-human'] : [])])).digest('hex');
    const existing = this.#core.journal.db.query('SELECT data, fingerprint FROM coordination_letters WHERE thread_id = ? AND request_id = ?').get(params.threadId, requestId) as Row | null;
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw refused('requestId already used for different content');
      return JSON.parse(existing.data) as AgentLetter;
    }
    if (same(from, to)) throw refused('an agent cannot message itself');
    let toTitle: string;
    let toProject: string | undefined;
    let toMachine: string | undefined;
    if (to.coreId === from.coreId) {
      if (resident === null && this.#core.threads.require(to.threadId).projectId !== this.#core.threads.require(from.threadId).projectId && !(config.remote && this.config(to.threadId).remote)) throw refused('both threads must enable coordination across projects');
      const target = this.#contact(to.threadId, resident !== null);
      toTitle = target.title;
      toProject = target.project;
      toMachine = target.machine;
    } else {
      if (!config.remote) throw refused('cross-machine coordination is disabled for this thread');
      const peer = this.trusted().find(p => p.coreId === to.coreId);
      const route = peer ? undefined : await this.mailboxes.resolve(params.threadId, to.coreId);
      if (!peer && !route) throw refused('destination machine is not trusted for coordination');
      if (!human && (this.#core.contacts.isContact(to.coreId) || route)) this.#core.contacts.checkSendTier(params.threadId, to.coreId);
      from = this.#contact(params.threadId, resident !== null);
      if (!this.config(params.threadId).remote || this.config(params.threadId).paused) throw refused('coordination permissions changed; retry the send');
      // No directory round trip on send: a disconnected recipient can receive after reconnect.
      toTitle = to.threadId;
      toMachine = peer?.name ?? route!.name;
    }
    if (params.replyTo) {
      const previous = this.rows('id = ? AND thread_id = ?', params.replyTo, params.threadId)[0];
      if (!previous) throw refused('replyTo must name a message in this thread');
      const letter = JSON.parse(previous.data) as AgentLetter;
      if (!same(letter.from, to) || !same(letter.to, from)) throw refused('replyTo must name an incoming message from this recipient');
    }
    const provenance = await outgoingContact(this.#core, from, to, human, connection);
    this.#contact(params.threadId, resident !== null); if (this.config(params.threadId).paused) throw refused('coordination paused by the owner');
    if (to.coreId !== from.coreId && !this.config(params.threadId).remote) throw refused('coordination permissions changed; retry the send');
    const raced = this.rows('thread_id = ? AND request_id = ?', params.threadId, requestId)[0];
    if (raced) { if (raced.fingerprint !== fingerprint) throw refused('requestId already used for different content'); return JSON.parse(raced.data) as AgentLetter; }
    const createdAt = Date.now();
    const contact = this.#core.contacts.known(to.coreId) ?? this.mailboxes.route(params.threadId, to.coreId);
    const letter: AgentLetter = { ...(resident ? { origin: 'resident' as const } : {}), id: randomUUID(), from, to, toTitle, toProject, toMachine, text: body, replyTo: params.replyTo ?? null, createdAt, expiresAt: createdAt + (resident ? RESIDENT_LETTER_TTL_MS : LETTER_TTL_MS), status: 'queued', error: null,
      ...(contact ? { contact: { coreId: contact.coreId, name: contact.name } } : {}), ...provenance };
    this.#core.journal.append({ type: 'coordination.sent', threadId: from.threadId, version: 1, payload: letter }, () => this.#put(letter, 'out', from.threadId, requestId, fingerprint));
    // It may hear back from that contact for a while, even outside the projects opened to it.
    if (contact) this.#core.contacts.reach.noteSent(from.threadId, contact.coreId);
    this.#core.threads.runner.noteMail(from.threadId, letter.createdAt);
    // The thread's turns now report back to the agent that wrote to it, waking it only once it watches the thread.
    if (resident) this.#core.workforce.projects.follow(resident.id, to.threadId, 'touched');
    this.#changed(from.threadId);
    if (to.coreId === from.coreId) {
      try { this.#receive(letter); } catch (error) { this.update(letter, 'rejected', messageOf(error)); }
    } else queueMicrotask(() => { void this.tick(); });
    return this.#find(letter.id, 'out')!;
  }
  /** Called only after the gateway's sealed group envelope and the saved source route match. */
  receiveRouted(letter: AgentLetter, name: string): AgentLetter {
    return this.#receive(letter, { coreId: letter.from.coreId, name, url: '', publicKey: '' }, { coreId: letter.from.coreId, name });
  }
  #receive(letter: AgentLetter, peer?: CoordinationPeer, routed?: { coreId: string; name: string }): AgentLetter {
    if (!letter || typeof letter !== 'object') throw invalidParams('letter: expected an agent message');
    text(letter.id, 'letter.id', 100);
    address(letter.to, 'letter.to');
    if (letter.to.coreId !== this.#self('').coreId) throw refused('message belongs to another core');
    // Only this core marks a letter as a persistent agent's, and only while the project is entrusted to it. A remote origin is never believed.
    const resident = !peer && this.#core.workforce.projects.over(letter.from.threadId, letter.to.threadId) !== null;
    if (!peer && letter.origin === 'resident' && !resident) throw refused('the project is no longer entrusted to this bot');
    // A contact reaches the projects opened to it and the threads that wrote to it, nothing else: an unknown thread reads the same.
    const contact = routed ?? (peer ? this.#core.contacts.known(peer.coreId) : undefined);
    if (contact && !routed && !this.#core.contacts.mayReach(contact.coreId, letter.to.threadId)) throw refused('letter.to: not a thread of a project opened to you');
    const target = this.#contact(letter.to.threadId, resident);
    const config = this.config(target.threadId);
    const from = peer ? checkRemoteContact(letter.from, peer) : this.#contact(letter.from.threadId, resident);
    if (peer && !config.remote) throw refused('recipient has not enabled cross-machine coordination');
    const provenance = routed ? (letter.origin === 'contact-human' ? {origin: 'contact-human' as const, from: {...from, agent: undefined}} : {}) : incomingContact(this.#core, { ...letter, from }, peer);
    if (routed && letter.origin !== 'contact' && letter.origin !== 'contact-human') this.#core.contacts.checkAttestedTier(from.agent, contact?.coreId);
    for (const row of this.rows('id = ?', letter.id)) {
      const known = JSON.parse(row.data) as AgentLetter;
      if (!same(known.from, from) || !same(known.to, target) || known.text !== letter.text || known.replyTo !== letter.replyTo || (known.origin === 'contact-human') !== (letter.origin === 'contact-human')) throw refused('message id already used for different content');
    }
    const existing = this.#find(letter.id, 'in');
    if (existing) {
      if (!same(existing.from, from) || !same(existing.to, target) || existing.text !== letter.text || existing.replyTo !== letter.replyTo || (existing.origin === 'contact-human') !== (letter.origin === 'contact-human')) throw refused('message id already used for different content');
      return existing;
    }
    if (!Number.isSafeInteger(letter.createdAt) || !Number.isSafeInteger(letter.expiresAt) || letter.createdAt > Date.now() + 60_000 || letter.expiresAt <= Date.now() || letter.expiresAt > letter.createdAt + (resident || routed && letter.origin === 'contact' ? RESIDENT_LETTER_TTL_MS : LETTER_TTL_MS)) throw refused('message expired or timestamps invalid');
    const origin = resident ? 'resident' as const : routed && letter.origin === 'contact' ? 'contact' as const : undefined;
    const accepted: AgentLetter = { ...(origin ? { origin } : {}), id: letter.id, from, to: this.#self(target.threadId), toTitle: target.title, toProject: target.project, toMachine: target.machine, text: text(letter.text, 'letter.text'), replyTo: letter.replyTo === null ? null : text(letter.replyTo, 'letter.replyTo', 100), createdAt: Date.now(), expiresAt: letter.expiresAt, status: 'received', error: null,
      // The name this owner gave the contact, never the sender's word.
      ...(contact ? { contact: { coreId: contact.coreId, name: contact.name } } : {}), ...provenance };
    return this.acceptLetter(accepted);
  }
  /** Keeps a letter this core wrote or checked itself, once by its id, then hands it to a thread waiting for it or wakes its thread. */
  acceptLetter(letter: AgentLetter): AgentLetter {
    const threadId = letter.to.threadId, known = this.#find(letter.id, 'in');
    if (known) return known;
    this.#core.journal.append({ type: 'coordination.received', threadId, version: 1, payload: letter }, () => this.#put(letter, 'in', threadId));
    this.#core.threads.runner.noteMail(threadId, letter.createdAt);
    this.#resumeForAgent(threadId);
    this.update(letter, 'received');
    this.#handToWaiter(threadId, letter.from);
    const current = this.#find(letter.id, 'in');
    if (current?.status === 'received') this.#kick(threadId);
    return current ?? letter;
  }
  private rows(where: string, ...params: (string | number)[]): Row[] { return this.#core.journal.db.query(`SELECT data, fingerprint FROM coordination_letters WHERE ${where}`).all(...params) as Row[]; }
  #find(id: string, direction: string): AgentLetter | null {
    const row = this.rows('id = ? AND direction = ?', id, direction)[0];
    return row ? JSON.parse(row.data) as AgentLetter : null;
  }
  #put(letter: AgentLetter, direction: string, threadId: string, requestId: string | null = null, fingerprint: string | null = null): void {
    this.#core.journal.db.query('INSERT INTO coordination_letters (id, thread_id, direction, status, created_at, request_id, fingerprint, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(letter.id, threadId, direction, letter.status, letter.createdAt, requestId, fingerprint, JSON.stringify(letter));
  }
  private update(letter: AgentLetter, status: AgentLetter['status'], error: string | null = null): void {
    const before = letter.to.coreId === this.#coreId && (letter.status === 'received' || letter.status === 'uncertain' && letter.error === 'Queued for provider delivery');
    if (before && (status === 'delivered' || status === 'uncertain') && !this.#admitting?.has(letter.id)) throw new Error(`coordination: letter ${letter.id} reaches its agent only through admit`);
    const next = { ...letter, status, error };
    this.#core.journal.append({ type: 'coordination.status', threadId: letter.to.coreId === this.#self('').coreId ? letter.to.threadId : letter.from.threadId, version: 1, payload: { id: letter.id, status, error } }, () => {
      // Each endpoint retains its own send or receipt time when acknowledgement metadata arrives.
      this.#core.journal.db.query("UPDATE coordination_letters SET status = ?, data = json_set(?, '$.createdAt', created_at) WHERE id = ?").run(status, JSON.stringify(next), letter.id);
      // A team letter's snapshot is marked seen or released with its state (`teams/store.ts`).
      if (next.team && letter.to.coreId === this.#self('').coreId) this.#core.teams.letterChanged(next);
    });
    for (const endpoint of [letter.from, letter.to]) if (endpoint.coreId === this.#coreId) this.#changed(endpoint.threadId);
    // Mail held for the owner came or went: the owner's list of it changed.
    if (letter.contact && letter.to.coreId === this.#coreId && (status === 'received' || letter.status === 'received') && contactMailGate(this.#core, letter.to.threadId).held(letter)) this.#core.contacts.changed();
  }
  #changed(threadId: string): void { this.#core.bus.emit('collaboration.changed', { threadId }); }

  /** Letters a bot wrote to threads it no longer looks after go nowhere: this bot thread's, or with none those of other machines' bots (`agents/group-host.ts`). */
  residentRevoked(agentThreadId?: string, reason = 'The project is no longer entrusted to this bot'): void {
    const pending = this.rows("status IN ('queued', 'received') AND json_extract(data, '$.origin') = 'resident'").map(row => JSON.parse(row.data) as AgentLetter);
    const self = this.#self('').coreId;
    for (const letter of pending.filter(l => (agentThreadId === undefined ? l.from.coreId !== self : l.from.threadId === agentThreadId) && this.#core.workforce.projects.mayReceive(l, l.from.coreId === self) === false)) this.update(letter, 'rejected', reason);
  }

  /**
   * A contact's owner or core decided a project request (`collaboration.ask`):
   * this core writes the answer and preserves who made the decision.
   */
  contactAnswer(request: ContactRequest, name: string, threads: AgentContact[]): void {
    const threadId = request.from.threadId;
    const list = threads.slice(0, 20).map(entry => `${JSON.stringify(entry.title)} (${entry.machine.replace(/\s+/g, '-')}/${entry.threadId}${entry.status === 'idle' ? '' : `, ${entry.status}`})`);
    const responder = request.decidedBy === 'owner' ? name : `${name}'s Boite${request.decidedBy === 'match' || request.decidedBy === 'concierge' ? ' automatically' : ''}`;
    const body = request.status === 'accepted'
      ? `${responder} opened its project ${JSON.stringify(request.project?.name ?? '')} to you. ${list.length ? `Its threads: ${list.join('; ')}.` : 'No thread of it can be reached yet.'} Write to one with boite threads send <contact>/<thread-id> <text>; boite threads shows them.`
      : `${responder} refused your request: ${request.reason ?? 'no reason given'}`;
    if (this.mailboxes.answer(request, name, body.slice(0, 4000))) return;
    const thread = this.#core.journal.getThread(threadId);
    if (!thread || thread.archived) return;
    const now = Date.now();
    const from: AgentContact = { coreId: request.coreId, threadId: request.id, title: `Answer to your request to ${name}`.slice(0, 200), machine: name, resources: '', status: 'idle', mode: 'brief' };
    const letter: AgentLetter = { origin: 'contact', contact: { coreId: request.coreId, name }, id: randomUUID(), from, to: this.#self(threadId), toTitle: thread.title.slice(0, 200), toProject: projectName(this.#core, threadId),
      toMachine: this.#core.info().hostname ?? 'Boite', text: body.slice(0, 4000), replyTo: null, createdAt: now, expiresAt: now + RESIDENT_LETTER_TTL_MS, status: 'received', error: null };
    this.acceptLetter(letter);
  }

  /** A project closed to a contact: its letters waiting for threads it no longer reaches go nowhere. */
  rejectContactLetters(coreId: string, reason: string): void {
    const unreachable = (letter: AgentLetter): boolean => letter.from.coreId === coreId && !this.#core.contacts.reach.mayReach(coreId, letter.to.threadId);
    // A wake already queued for such a letter is stopped, and finds nothing left to deliver if it starts anyway.
    const queued = this.rows("direction = 'in' AND status = 'uncertain'").map(row => JSON.parse(row.data) as AgentLetter)
      .filter(letter => letter.error === 'Queued for provider delivery' && unreachable(letter));
    for (const letter of queued) this.update(letter, 'rejected', reason);
    for (const threadId of new Set(queued.map(letter => letter.to.threadId))) this.#core.threads.stopQueuedCoordination(threadId);
    for (const row of this.rows("direction = 'in' AND status IN ('queued', 'received')")) {
      const letter = JSON.parse(row.data) as AgentLetter;
      if (unreachable(letter)) this.update(letter, 'rejected', reason);
    }
  }
  /** A gateway withdrew only the contact mail it carried for this source. */
  rejectRoutedLetters(threadId: string, coreId: string, reason: string): void {
    let queued = false;
    for (const row of this.rows("thread_id = ? AND direction = 'in' AND status IN ('received', 'uncertain')", threadId)) {
      const letter = JSON.parse(row.data) as AgentLetter;
      if (letter.from.coreId !== coreId || this.mailboxes.mayReceive(letter) === null) continue;
      if (letter.status === 'uncertain' && letter.error !== 'Queued for provider delivery') continue;
      queued ||= letter.error === 'Queued for provider delivery';
      this.update(letter, 'rejected', reason);
    }
    if (queued) this.#core.threads.stopQueuedCoordination(threadId);
  }

  instructions(threadId: string): string {
    const config = this.config(threadId);
    return config.mode === 'off' ? '' : coordinationGuide(config.paused, config.remote && (this.#core.contacts.list().length > 0 || this.#core.contacts.members.relayed().length > 0 || this.#core.group.peers().length > 0));
  }

  /** Hook delivery: one batch at a provider's next safe tool boundary. */
  take(threadId: string, turnId: string): string | null {
    // Off and paused hold ordinary letters through mayReceive; a persistent agent's still pass.
    if (this.#delivering.has(threadId)) return null;
    const letters = this.#ready(threadId, BATCH);
    if (!letters.length) return null;
    return this.admit(threadId, letters, batch => {
      if (!batch.length) return null;
      this.#restoreProject(threadId);
      const { prompt } = this.teamLetters.render(threadId, batch, 'seen');
      this.#core.threads.noteCoordination(threadId, turnId, prompt);
      for (const letter of batch) this.update(letter, 'delivered');
      return prompt;
    }, () => this.#ready(threadId, BATCH, null, true));
  }
  /**
   * The oldest received letters this thread may take now, only its local mail
   * and the contact mail already cleared when `local`. Held ones (paused, off,
   * no longer permitted, waiting for the owner) stay in the inbox and never
   * hide those behind them.
   */
  #ready(threadId: string, limit: number, from: AgentAddress | null = null, local = false): AgentLetter[] {
    const letters: AgentLetter[] = [];
    let teams = 0;
    let gate: ReturnType<typeof contactMailGate> | undefined;
    const waits = (letter: AgentLetter) => Boolean(letter.contact) && ((gate ??= contactMailGate(this.#core, threadId)).held(letter) || local && !gate.cleared(letter));
    // Its own statement: a cached one left half read at the limit breaks the next selection.
    const statement = this.#core.journal.db.prepare("SELECT data FROM coordination_letters WHERE thread_id = ? AND direction = 'in' AND status = 'received' ORDER BY created_at");
    try {
      for (const row of statement.iterate(threadId) as Iterable<Row>) {
        const letter = JSON.parse(row.data) as AgentLetter;
        // A batch takes at most two team letters; the others wait for the next one.
        if (letter.expiresAt > Date.now() && !waits(letter) && (from === null || same(letter.from, from)) && this.#mayReceive(letter) && !(letter.team && teams++ >= TEAM_LETTERS_PER_BATCH)) letters.push(letter);
        if (letters.length >= limit) break;
      }
    } finally { statement.finalize(); }
    return letters;
  }
  /**
   * The one way a letter reaches its agent: a wait's tool output, a hook, a
   * steer or a wake. Contact mail gets its file protection first. Mail this
   * turn cannot protect stays in the inbox, where the turn's end kicks it
   * again, and `consume` gets the local mail `local` selects in its place, so
   * held contact letters never fill the batch; without `local` the whole batch
   * is refused. `update` refuses to deliver any letter `consume` was not given here.
   */
  private admit<T>(threadId: string, letters: AgentLetter[], consume: (batch: AgentLetter[]) => T, local?: (refusal: RpcFailure) => AgentLetter[], starting = false): T {
    let batch = letters;
    try { protectLetters(this.#core, threadId, batch, starting); } catch (error) {
      // Only a policy refusal holds mail back; anything else is a fault to report.
      if (!local || !(error instanceof RpcFailure) || !batch.some(letter => letter.contact)) throw error;
      batch = local(error);
    }
    const outer = this.#admitting;
    this.#admitting = new Set(batch.map(letter => letter.id));
    // The sink records its whole batch or nothing: a fault on one letter leaves none marked as read.
    try { return this.#core.bus.afterCommit(() => this.#core.journal.db.transaction(() => consume(batch))()); } finally { this.#admitting = outer; }
  }
  #inProject(letter: AgentLetter): boolean {
    if (letter.from.coreId !== this.#self('').coreId || letter.to.coreId !== this.#coreId) return false;
    const from = this.#core.journal.getThread(letter.from.threadId);
    const to = this.#core.journal.getThread(letter.to.threadId);
    return from !== null && to !== null && from.projectId === to.projectId;
  }
  #mayReceive(letter: AgentLetter): boolean {
    if (!policyAllowsLetter(this.#core, letter)) return false;
    const thread = this.#core.journal.getThread(letter.to.threadId);
    if (!thread || thread.archived) return false;
    // A team letter follows its team, not the thread's communication settings.
    if (letter.team) return this.#core.teams.mayReceive(letter);
    const resident = this.#core.workforce.projects.mayReceive(letter, letter.from.coreId === this.#self('').coreId);
    if (resident !== null) return resident;
    const recipient = this.config(letter.to.threadId);
    if (recipient.mode === 'off' || recipient.paused) return false;
    if (letter.from.coreId !== this.#self('').coreId) {
      if (!recipient.remote) return false;
      const routed = this.mailboxes.mayReceive(letter);
      if (routed !== null) return routed;
      if (this.#core.contacts.ownsAnswer(letter)) return true;
      const peer = this.trusted().find(peer => peer.coreId === letter.from.coreId);
      if (!peer) return false;
      try { incomingContact(this.#core, letter, peer); } catch { return false; }
      return !this.#core.contacts.isContact(letter.from.coreId) || this.#core.contacts.mayReach(letter.from.coreId, letter.to.threadId);
    }
    const sender = this.config(letter.from.threadId);
    if (sender.mode === 'off') return false;
    return this.#inProject(letter) || (recipient.remote && sender.remote);
  }
  /** A wake that never reached its provider puts its letters back, those it had already claimed for `turnId` too. */
  queuedCancelled(threadId: string, turnId?: string): void {
    for (const row of this.rows("thread_id = ? AND direction = 'in' AND status = 'uncertain'", threadId)) {
      const letter = JSON.parse(row.data) as AgentLetter;
      if (letter.error === 'Queued for provider delivery' || turnId && letter.error === `Awaiting provider turn ${turnId}`) this.update(letter, 'received');
    }
  }
  /** Recheck a queued batch immediately before it crosses the provider boundary. */
  prepareWake(threadId: string, turnId: string): boolean {
    const letters = this.rows("thread_id = ? AND direction = 'in' AND status = 'uncertain'", threadId)
      .map(row => JSON.parse(row.data) as AgentLetter).filter(letter => letter.error === 'Queued for provider delivery');
    if (!letters.length || this.#closed || letters.some(letter => letter.expiresAt <= Date.now() || !this.#mayReceive(letter))) return false;
    // The wake was scheduled for this batch: it crosses whole or not at all.
    return this.admit(threadId, letters, () => {
      this.#restoreProject(threadId);
      for (const letter of letters) this.update(letter, 'uncertain', `Awaiting provider turn ${turnId}`);
      return true;
    }, undefined, true);
  }
  async #steer(threadId: string, prompt: string): Promise<{ submitted: boolean } | null> {
    if (this.#closed) return null;
    const stopped = Promise.withResolvers<null>();
    const cancel = () => stopped.resolve(null);
    this.#localWaits.add(cancel);
    try {
      return await Promise.race([
        this.#core.threads.steer(threadId, prompt).then(submitted => ({ submitted })),
        stopped.promise,
      ]);
    } finally { this.#localWaits.delete(cancel); }
  }
  /** Restore on actual provider delivery, after pause, expiry and permission checks. */
  #restoreProject(threadId: string): void {
    const projectId = this.#core.threads.require(threadId).projectId;
    if (projectId !== null && this.#core.journal.getProject(projectId)?.archived) this.#core.projects.archive(projectId, false);
  }
  private async deliver(threadId: string): Promise<void> {
    if (this.#closed || this.#delivering.has(threadId)) return;
    const thread = this.#core.journal.getThread(threadId);
    // A thread whose last turn failed wakes like an idle one: each letter starts at most one turn, so a failing provider cannot loop.
    if (!thread || thread.archived || thread.status === 'waiting' || thread.status === 'queued') return;
    const ready = this.#ready(threadId, BATCH);
    if (!ready.length) return;
    this.#delivering.add(threadId);
    const local = () => this.#ready(threadId, BATCH, null, true);
    try {
      if (thread.status === 'running') {
        // A steer's team posts are in flight with its letters: seen once the provider takes them, released otherwise.
        const steered = this.admit(threadId, ready, batch => {
          if (!batch.length || !this.#core.threads.canSteer(threadId)) return null;
          this.#restoreProject(threadId);
          const { prompt } = this.teamLetters.render(threadId, batch, 'flight');
          for (const letter of batch) this.update(letter, 'uncertain', 'Awaiting provider acknowledgement');
          return { letters: batch, prompt };
        }, local);
        if (!steered) return;
        try {
          const result = await this.#steer(threadId, steered.prompt);
          if (result === null || this.#closed || this.#core.journal.isClosed()) return;
          for (const letter of steered.letters) {
            const current = this.#find(letter.id, 'in');
            if (current?.status === 'uncertain' && current.error === 'Awaiting provider acknowledgement') this.update(current, result.submitted ? 'delivered' : 'received');
          }
        } catch (error) {
          if (this.#closed || this.#core.journal.isClosed()) return;
          for (const letter of steered.letters) {
            const current = this.#find(letter.id, 'in');
            if (current?.status === 'uncertain' && current.error === 'Awaiting provider acknowledgement') this.update(current, 'uncertain', messageOf(error));
          }
        }
      } else {
        let held: RpcFailure | null = null;
        // One transaction records the wake, message states and scheduled turn.
        const woke = this.admit(threadId, ready, batch => batch.length > 0 && this.#core.journal.db.transaction(() => {
          const { prompt, channel } = this.teamLetters.render(threadId, batch, 'flight', true);
          for (const letter of batch) this.update(letter, 'uncertain', 'Queued for provider delivery');
          this.#core.journal.db.query('INSERT INTO coordination_wakes VALUES (?, ?)').run(threadId, Date.now());
          // An owner's team post wakes the bot as the owner's own message would: no bot pause or budget holds it.
          const owner = batch.some(letter => letter.team?.owner);
          const turn = this.#core.threads.startTurn(threadId, prompt, owner ? { kind: 'coordination', owner: true } : { kind: 'coordination' });
          // The wake's reply envelope: where its final answer goes, fixed now, whatever a steer brings later.
          if (channel) this.#core.teams.envelope(turn.id, threadId, channel);
          return true;
        })(), refusal => { held = refusal; return local(); });
        // No turn of an idle thread ends to retry its refused contact mail: the refusal pauses coordination until the owner's trust or message.
        // Mail held for the owner never gets here: `#ready` leaves it out until the owner delivers it.
        if (!woke && held) throw held;
      }
    } catch (error) {
      // A persistent agent that is paused or out of budget: its letters wait in the inbox for it.
      if (isAgentHeld(error)) { this.#core.agentRuntime.whenAdmitted(threadId, 'coordination', () => this.#kick(threadId)); return; }
      if (!this.#closed && !this.#core.journal.isClosed()) {
        this.pause(threadId, 'failure'); this.#core.log('warn', `coordination ${threadId}: ${messageOf(error)}`);
      }
    }
    finally { this.#delivering.delete(threadId); }
  }
  /** A scheduled coordination turn reached its driver; no claim that the model read it. */
  submitted(threadId: string, turnId: string): void {
    for (const row of this.rows("thread_id = ? AND direction = 'in' AND status = 'uncertain'", threadId)) {
      const letter = JSON.parse(row.data) as AgentLetter;
      if (letter.error === `Awaiting provider turn ${turnId}`) this.update(letter, 'delivered');
    }
  }
  private async tick(): Promise<void> {
    if (this.#closed || this.#ticking) return;
    this.#ticking = true;
    const job = this.#work();
    this.#pending.add(job);
    try { await job; } catch (error) { if (!this.#closed) this.#core.log('warn', `coordination: ${messageOf(error)}`); }
    finally { this.#pending.delete(job); this.#ticking = false; }
  }
  async #work(): Promise<void> {
    this.mailboxes.tick();
    const now = Date.now();
    if (now - this.swept >= HOUR) {
      this.swept = now;
      this.#core.journal.db.query('DELETE FROM coordination_wakes WHERE at < ?').run(now - HOUR);
      // A settled letter has nothing left to deliver or acknowledge: its expiry is 15
      // minutes, a receipt asks only for a letter that has not expired, and a thread
      // shows its last 100. An uncertain letter is settled too: it is never replayed,
      // and a month later no receipt will tell what became of it.
      this.#core.journal.db.query("DELETE FROM coordination_letters WHERE status IN ('delivered', 'expired', 'rejected', 'uncertain') AND created_at < ?").run(now - LETTER_RETENTION_MS);
    }
    // Nothing waits on the sweep: a probe or two on the status index, then back to sleep.
    const db = this.#core.journal.db;
    if (!db.query(SWEEP_PROBES[0]).get() && !db.query(SWEEP_PROBES[1]).get(now - LETTER_TTL_MS, now)) return;
    for (const row of this.rows("status IN ('queued', 'received') AND json_extract(data, '$.expiresAt') <= ?", Date.now())) this.update(JSON.parse(row.data), 'expired', 'Message expired before delivery');
    const threads = this.#core.journal.db.query("SELECT DISTINCT thread_id FROM coordination_letters WHERE direction = 'in' AND status = 'received'").all() as { thread_id: string }[];
    for (const { thread_id } of threads) {
      if (this.#closed) return;
      // One slow provider must not block delivery to every other local agent.
      if (this.#delivering.size >= 4) break;
      const job = this.deliver(thread_id);
      this.#pending.add(job);
      void job.finally(() => this.#pending.delete(job));
    }
    const outgoing = this.rows("direction = 'out' AND status IN ('queued', 'received', 'uncertain') AND json_extract(data, '$.expiresAt') > ?", Date.now())
      .map(row => JSON.parse(row.data) as AgentLetter).filter(letter => letter.to.coreId !== this.#self('').coreId);
    const ids = new Set(outgoing.map(l => l.id));
    for (const id of this.#attempts.keys()) if (!ids.has(id)) this.#attempts.delete(id);
    const next = outgoing.sort((a, b) => (this.#attempts.get(a.id) ?? 0) - (this.#attempts.get(b.id) ?? 0)).slice(0, 4);
    await Promise.all(next.map(letter => this.#relay(letter)));
  }

  async #relay(letter: AgentLetter): Promise<void> {
      this.#attempts.set(letter.id, Date.now());
      const sender = this.#core.journal.getThread(letter.from.threadId);
      if (!sender || sender.archived) { this.update(letter, 'rejected', 'Thread archived or removed'); return; }
      const config = this.config(letter.from.threadId);
      const peer = this.trusted().find(p => p.coreId === letter.to.coreId);
      const route = !peer ? this.mailboxes.route(letter.from.threadId, letter.to.coreId) : undefined;
      if ((!peer && !route) || !config.remote || config.mode === 'off') { this.update(letter, 'rejected', 'Machine permission revoked'); return; }
      if (config.paused && letter.status === 'queued') return;
      try {
        const answer = peer ? await this.exchange(peer, letter.status === 'queued' ? 'deliver' : 'receipt', letter.status === 'queued' ? letter : { id: letter.id, fromThreadId: letter.from.threadId }) as AgentLetter : await this.mailboxes.relay(letter);
        if (this.#closed) return;
        if ((peer ? !this.trusted().some(p => p.coreId === peer.coreId) : !this.mailboxes.route(letter.from.threadId, letter.to.coreId)) || !this.config(letter.from.threadId).remote) { this.update(letter, 'rejected', 'Machine permission revoked'); return; }
        if (!answer || answer.id !== letter.id || !same(answer.from, letter.from) || !same(answer.to, letter.to) || !['received', 'delivered', 'uncertain', 'expired', 'rejected'].includes(answer.status)) throw new Error('invalid delivery receipt');
        const title = text(answer.toTitle, 'receipt.toTitle', 200);
        const error = answer.error === null ? null : text(answer.error, 'receipt.error', 4000);
        const projectName = answer.toProject === undefined ? undefined : text(answer.toProject, 'receipt.toProject', 200);
        const machine = peer?.name ?? route!.name;
        if (letter.status !== answer.status || letter.error !== error || letter.toTitle !== title || letter.toProject !== projectName || letter.toMachine !== machine) this.update({ ...letter, toTitle: title, toProject: projectName, toMachine: machine }, answer.status, error);
      } catch (error) {
        if (this.#closed) return;
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
    this.#identityKey();
    const routes = policedRoutes(this.#core, peer, operation);
    // A contact another member of the group holds is asked through that member.
    if (this.#core.contacts.isRelayPeer(peer)) {
      const via = this.#core.contacts.members.via(peer.coreId);
      if (!via) throw unavailable(`${peer.name} is linked to a machine that left this group`);
      return this.#core.contacts.members.send(via, peer.coreId, operation, payload);
    }
    // Signed and sealed anew for every address tried, the owner's app included: the same request sent twice
    // is a replay at a machine both addresses lead to, refused there, and every operation bears being asked twice.
    // A contact this core hosts is reached only down the link its core keeps open.
    const contact = routes === null && this.#core.contacts.has(peer.coreId);
    if (contact && !this.#core.contacts.linked(peer.coreId)) throw unavailable(`${peer.name} is not linked right now; its core dials this one again by itself`);
    const attempt = async (url: string | null): Promise<Answer> => {
      policedRoutes(this.#core, peer, operation);
      const nonce = randomUUID();
      const body = JSON.stringify({ from: this.#coreId, to: peer.coreId, at: Date.now(), nonce, operation, payload } satisfies Envelope);
      const signed = sign(null, Buffer.from(body), this.#key!).toString('base64');
      const packed = pack(body, signed);
      const sealing = this.#core.group.sealFor(peer.coreId, packed) ?? (contact ? this.#core.contacts.sealFor(peer.coreId, packed) : null);
      // Begun for a member of the group, it ends sealed or not at all: this core may have left the group between two attempts.
      if (routes !== null && sealing === null) throw new Error('no longer in the group this request was for');
      if (contact && sealing === null) throw new Error('no longer a contact');
      const wire = sealing === null ? body : sealing.body;
      const signature = sealing === null ? signed : SEALED;
      if (url !== null) {
        // A contact's name is checked again at each request: its DNS answer may have left the tailnet since the join.
        if (contact) await checkTailnetName(url, 'contact.url');
        policedRoutes(this.#core, peer, operation);
        return post(url, this.#coreId, peer.publicKey, wire, signature, nonce, sealing);
      }
      const response = await this.bridge.request(peer.coreId, { fromCoreId: this.#coreId, toCoreId: peer.coreId, body: wire, signature });
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
    policedRoutes(this.#core, peer, operation);
    if (answer.url !== null) this.#core.group.reached(peer.coreId, answer.url);
    if (answer.gone) throw new PeerGone('removed from the group');
    if (answer.refusal !== undefined) throw new PeerRefusal(answer.refusal);
    return answer.result;
  }
  /** A signed request from another core, answered by the desk (`coordination-peer.ts`). */
  http(request: Request): Promise<Response> { return this.desk.http(request); }
  forward(params: RpcParams<'collaboration.bridge.forward'>): Promise<CoordinationBridgeResponse> { return forwardCoordination(this.#core, params); }
  beginClose(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const cancel of this.#localWaits) cancel();
    this.#localWaits.clear();
    this.bridge.close();
    this.mailboxes.beginClose();
    clearInterval(this.#timer); this.#off();
    for (const set of [...this.#waiters.values()]) for (const waiter of [...set]) waiter.done([]);
  }
  async close(): Promise<void> { this.beginClose(); await Promise.allSettled([...this.#pending, this.mailboxes.close()]); }
}

export { registerCoordination } from './coordination-rpc.ts';

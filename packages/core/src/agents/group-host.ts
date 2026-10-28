/*
 * This machine's side of a bot of another machine of the group that looks
 * after projects here (`group-bots.ts` is the bot's side). The owner turns
 * `groupBots` on in Settings, Machines; while it is off every `bot.*` request
 * is refused and nothing is sent. This machine's word is the one that counts:
 * the bot's core says which projects its owner entrusted (the lease), and this
 * one holds each request to those projects, to its own setting and to the
 * group as it stands now.
 *
 * What the bot may do here is what a bot of this machine does on a project
 * entrusted to it (`projects.ts`): list, read, steer with letters marked as
 * its own, answer questions, archive, mark done, stop, rename, move between
 * its projects, start a thread in one of them (`bot.start`, on the bot's desk
 * here at once). Deleting threads, tool permissions and settings are never
 * asked of this machine: there is no operation for them.
 *
 * Events go back by themselves: a turn of a thread it follows, any failed
 * turn, any question, a permission a followed thread waits on. They wait in a
 * bounded outbox per machine while it is away and leave once it answers.
 */
import type { AgentLetter, AgentSpawn, CoordinationPeer, PermissionRequest, ProjectId, ProjectThreadRow, QuestionRequest, ThreadId, ThreadSummary, Turn } from '@boite/contracts';
import type { Core } from '../core.ts';
import { RESIDENT_LETTER_TTL_MS } from '../coordination-letter.ts';
import { MAX_BODY, PeerRefusal, type BotOperation } from '../coordination-wire.ts';
import { invalidParams, messageOf, refused } from '../errors.ts';
import { checkStartFields } from '../threads/group-spawn.ts';
import type { Steward } from './projects.ts';

/** What this machine answers while its owner has not let the bots of the group look after its projects. */
export const GROUP_BOTS_OFF = 'groupBots is off on this machine';
const LEASE = 'group-bots:lease:';
const OUTBOX = 'group-bots:outbox:';
/** Events kept per machine while it is away; the oldest leave first. */
export const OUTBOX_MAX = 100;
const FLUSH_MS = 300;
const RETRY_MS = [5_000, 15_000, 60_000, 300_000];
const TEXT_MAX = 1_500;

/** What a bot's core says its owner entrusted here, saved per bot. `v` orders the leases one core sends. */
export interface BotLease {
  agentId: string;
  /** The bot's own thread on its machine: its letters here come from it. */
  threadId: ThreadId;
  name: string;
  projectIds: ProjectId[];
  /** The threads here on its desk: every turn they end goes back. */
  watched: ThreadId[];
  /**
   * Threads `bot.start` made here that the bot's core has not listed among its
   * own yet, kept only here: a lost answer or a restart of either side must not
   * leave one off the desk, so the leases the bot sends keep them watched and
   * a sync's answer gives them back, until a lease of the bot lists them.
   */
  started?: ThreadId[];
  v: number;
}

/** One event for one bot, as its core turns it into a fact. */
export interface BotEvent {
  agentId: string;
  kind: 'turn' | 'ask' | 'permission' | 'row';
  /** Unique per event: a retry never wakes the bot twice. */
  key: string;
  row: ProjectThreadRow;
  /** The bot started that thread and its core has not listed it yet: it goes on the desk there. */
  started?: true;
  status?: Turn['status'];
  answer?: string | null;
  question?: { id: string; text: string; options: { id: string; label: string }[] };
  permission?: { tool: string; description: string | null };
}

const cut = (value: string, max: number): string => (value.length > max ? `${value.slice(0, max - 20)}\n[Truncated.]` : value);
/** A sealed request grows by its encryption and base64: a batch keeps well under the body a member accepts. */
const BATCH_BYTES = Math.floor(MAX_BODY * 3 / 8);
/** The oldest events that fit one request; the rest go with the next. */
export function batchOf(events: BotEvent[]): BotEvent[] {
  const batch: BotEvent[] = [];
  let size = 0;
  for (const event of events) {
    const bytes = Buffer.byteLength(JSON.stringify(event));
    if (batch.length > 0 && size + bytes > BATCH_BYTES) break;
    batch.push(event);
    size += bytes;
  }
  return batch;
}
const textOf = (value: unknown, field: string, max: number): string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) throw invalidParams(`${field}: expected 1 to ${max} characters`);
  return value;
};
/** The options a bot picked: the question itself then checks they are its own. */
const optionIdsOf = (value: unknown): string[] => {
  if (!Array.isArray(value) || value.length > 64) throw invalidParams('bot.answer.optionIds: expected at most 64 option ids');
  return value.map((id, index) => textOf(id, `bot.answer.optionIds[${index}]`, 128));
};
/** A lease as the bot's core sent it, checked field by field. */
export function checkLease(value: unknown, field = 'lease'): BotLease {
  const raw = (value ?? {}) as Record<string, unknown>;
  const list = (entry: unknown, name: string, max: number): string[] => {
    if (!Array.isArray(entry) || entry.length > max) throw invalidParams(`${field}.${name}: expected at most ${max} ids`);
    return entry.map((id, index) => textOf(id, `${field}.${name}[${index}]`, 128));
  };
  if (typeof raw.v !== 'number' || !Number.isSafeInteger(raw.v)) throw invalidParams(`${field}.v: expected an integer`);
  return {
    agentId: textOf(raw.agentId, `${field}.agentId`, 160),
    threadId: textOf(raw.threadId, `${field}.threadId`, 128),
    name: textOf(raw.name, `${field}.name`, 100),
    projectIds: list(raw.projectIds, 'projectIds', 50),
    watched: list(raw.watched, 'watched', 200),
    v: raw.v,
  };
}

export class GroupBotHost {
  private readonly off: () => void;
  private closed = false;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly attempts = new Map<string, number>();
  private readonly sending = new Set<string>();
  private startup: ReturnType<typeof setTimeout> | null;

  constructor(private readonly core: Core) {
    this.off = core.bus.onAny((name, payload) => {
      if (this.closed || core.journal.isClosed()) return;
      try {
        if (name === 'turn.finished') this.onTurn(payload as Turn);
        else if (name === 'question.asked') this.onQuestion(payload as QuestionRequest);
        else if (name === 'permission.requested') this.onPermission(payload as PermissionRequest);
        else if (name === 'thread.updated') this.onRow(payload as ThreadSummary);
      } catch (error) {
        core.log('warn', `group bot event after ${name}: ${messageOf(error)}`);
      }
    });
    // A restart: the bots' desks learn how their threads stand here now, and what waited goes.
    // The store that builds this host is not `core.workforce` yet: the rows are read once it is.
    this.startup = setTimeout(() => {
      this.startup = null;
      // A core that crashed while starting closed its journal without closing this host.
      if (this.closed || core.journal.isClosed()) return;
      try {
        if (this.allowed()) for (const coreId of this.coreIds()) this.hello(coreId);
      } catch (error) {
        core.log('warn', `group bot startup: ${messageOf(error)}`);
      }
    }, 0);
  }

  close(): void {
    this.closed = true;
    this.off();
    if (this.startup !== null) clearTimeout(this.startup);
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  allowed(): boolean { return this.core.settings.get().groupBots === true; }

  /**
   * The owner turned `groupBots` on or off. Off cuts at once: every request
   * is refused from now, waiting events are dropped and the bots' letters not
   * yet read go nowhere. The leases stay, so turning it on again needs no
   * new grant from the bots' owner.
   */
  allowedChanged(on: boolean): void {
    if (on) { for (const coreId of this.coreIds()) this.hello(coreId); return; }
    for (const coreId of this.coreIds()) {
      this.core.journal.deleteSetting(`${OUTBOX}${coreId}`);
      const timer = this.timers.get(coreId);
      if (timer) clearTimeout(timer);
      this.timers.delete(coreId);
      this.attempts.delete(coreId);
    }
    this.core.coordination.residentRevoked(undefined, 'groupBots was turned off on this machine');
  }

  // -- who may do what ---------------------------------------------------------

  private coreIds(): string[] {
    return (this.core.journal.db.query("SELECT key FROM settings WHERE key LIKE 'group-bots:lease:%'").all() as { key: string }[]).map(row => row.key.slice(LEASE.length));
  }
  leases(coreId: string): Record<string, BotLease> { return (this.core.journal.getSetting(`${LEASE}${coreId}`) as Record<string, BotLease> | undefined) ?? {}; }
  private saveLeases(coreId: string, leases: Record<string, BotLease>): void {
    if (Object.keys(leases).length === 0) this.core.journal.deleteSetting(`${LEASE}${coreId}`);
    else this.core.journal.setSetting(`${LEASE}${coreId}`, leases);
  }
  private member(coreId: string): CoordinationPeer | null { return this.core.group.peers().find(peer => peer.coreId === coreId) ?? null; }

  /** The projects of a lease that are still here, open and not drafts. */
  scope(lease: Pick<BotLease, 'projectIds'>): ProjectId[] {
    return lease.projectIds.filter(id => {
      const project = this.core.journal.getProject(id);
      return project !== null && project.archived !== true && project.kind !== 'drafts';
    });
  }

  /** Whether a letter of a bot of `coreId`, from its thread `fromThreadId`, may still reach `toThreadId` here. */
  covers(coreId: string, fromThreadId: string, toThreadId: string): boolean {
    if (!this.allowed() || this.member(coreId) === null) return false;
    const lease = Object.values(this.leases(coreId)).find(entry => entry.threadId === fromThreadId);
    const thread = this.core.journal.getThread(toThreadId);
    return lease !== undefined && thread !== null && this.inScope(lease, thread);
  }

  private inScope(lease: BotLease, thread: ThreadSummary): boolean {
    return !thread.agentSessionId && thread.projectId !== null && this.scope(lease).includes(thread.projectId);
  }

  /**
   * The lease a request carries, kept when it is as new as the saved one: a
   * request never waits on a lease sync that has not landed yet.
   */
  private take(peer: CoordinationPeer, value: unknown): BotLease {
    const lease = checkLease(value);
    const leases = this.leases(peer.coreId);
    const saved = leases[lease.agentId];
    if (saved !== undefined && saved.v > lease.v) return saved;
    const next = this.kept(saved, lease);
    if (saved === undefined || saved.v < lease.v) this.saveLeases(peer.coreId, { ...leases, [lease.agentId]: next });
    return next;
  }

  /** A lease the bot's core sent, still watching the threads it started here that the bot does not list yet. */
  private kept(saved: BotLease | undefined, sent: BotLease): BotLease {
    const started = (saved?.started ?? []).filter(id => !sent.watched.includes(id) && this.core.journal.getThread(id) !== null);
    return started.length === 0 ? sent : { ...sent, watched: [...sent.watched, ...started].slice(-200), started };
  }

  private target(peer: CoordinationPeer, lease: BotLease, value: unknown, method: string): ThreadSummary {
    const id = textOf(value, `${method}.target`, 128);
    const thread = this.core.journal.getThread(id);
    if (thread === null || !this.inScope(lease, thread)) {
      throw refused(`${method}.target: ${id} is not a thread of the projects ${peer.name}'s owner entrusted to ${lease.name} on ${this.core.info().hostname ?? 'this machine'}`, { field: 'target' });
    }
    return thread;
  }

  private steward(peer: CoordinationPeer, lease: BotLease): Steward {
    return {
      agentId: lease.agentId, name: lease.name, projectIds: this.scope(lease),
      by: () => `${lease.name}, a bot of ${peer.name} the user entrusted this project to`,
      log: { residentAgentId: lease.agentId, machine: peer.name },
      follow: threadId => this.watch(peer.coreId, lease.agentId, threadId),
    };
  }

  /** A thread the bot wrote to, answered for or `started` goes on its desk here as on its own machine. */
  private watch(coreId: string, agentId: string, threadId: ThreadId, started = false): void {
    const leases = this.leases(coreId);
    const lease = leases[agentId];
    if (lease === undefined) return;
    const fresh = started && !(lease.started ?? []).includes(threadId);
    if (lease.watched.includes(threadId) && !fresh) return;
    const watched = lease.watched.includes(threadId) ? lease.watched : [...lease.watched, threadId].slice(-200);
    this.saveLeases(coreId, { ...leases, [agentId]: { ...lease, watched, ...(fresh ? { started: [...(lease.started ?? []), threadId].slice(-200) } : {}) } });
  }

  // -- requests ----------------------------------------------------------------

  /** A `bot.*` request of a member of the group, refused while `groupBots` is off here. */
  async handle(peer: CoordinationPeer, operation: Exclude<BotOperation, 'bot.event'>, payload: unknown): Promise<unknown> {
    if (!this.allowed()) throw refused(GROUP_BOTS_OFF);
    if (this.member(peer.coreId) === null) throw refused('operation: only a machine of this core\'s group looks after projects here');
    const raw = (payload ?? {}) as Record<string, unknown>;
    // It answers: what waited for it goes now, not after the wait its absence set.
    if (this.outbox(peer.coreId).length) this.back(peer.coreId);
    switch (operation) {
      case 'bot.lease': return this.lease(peer, raw);
      case 'bot.threads': {
        const lease = this.take(peer, raw.lease);
        let scope = this.scope(lease);
        if (raw.project !== undefined) {
          const wanted = textOf(raw.project, 'bot.threads.project', 4096).trim().toLowerCase();
          const found = scope.filter(id => id === wanted || this.core.journal.getProject(id)?.name.toLowerCase() === wanted);
          if (found.length === 0) throw refused(`bot.threads.project: ${String(raw.project)} is not a project entrusted to ${lease.name} here`, { field: 'project' });
          scope = found;
        }
        return this.core.workforce.projects.rows(scope, raw.archived === true);
      }
      case 'bot.thread': {
        const lease = this.take(peer, raw.lease);
        return this.core.workforce.projects.detailOf(this.target(peer, lease, raw.target, 'bot.thread'));
      }
      case 'bot.act': {
        const lease = this.take(peer, raw.lease);
        const target = this.target(peer, lease, raw.target, 'bot.act');
        const result = await this.core.workforce.projects.perform(this.steward(peer, lease), target, {
          action: raw.action as never,
          ...(typeof raw.title === 'string' ? { title: raw.title } : {}),
          ...(typeof raw.project === 'string' ? { project: raw.project } : {}),
        }, 'bot.act');
        return result;
      }
      case 'bot.answer': {
        const lease = this.take(peer, raw.lease);
        const target = this.target(peer, lease, raw.target, 'bot.answer');
        return this.core.workforce.projects.answerAs(this.steward(peer, lease), target, {
          questionId: textOf(raw.questionId, 'bot.answer.questionId', 128),
          optionIds: optionIdsOf(raw.optionIds),
          ...(raw.text === undefined || raw.text === '' ? {} : { text: textOf(raw.text, 'bot.answer.text', 12_000) }),
          ...(raw.skip === true ? { skip: true } : {}),
        }, 'bot.answer');
      }
      case 'bot.send': {
        const lease = this.take(peer, raw.lease);
        const target = this.target(peer, lease, raw.target, 'bot.send');
        if (target.parentThreadId) throw refused(`bot.send.target: ${target.id} is a delegated agent; write to its parent ${target.parentThreadId}`, { field: 'target' });
        const letter = this.letter(peer, lease, target, textOf(raw.text, 'bot.send.text', 12_000), textOf(raw.id, 'bot.send.id', 100));
        this.watch(peer.coreId, lease.agentId, target.id);
        return { id: letter.id, status: 'received' as const, thread: this.core.workforce.projects.row(this.core.threads.require(target.id)) };
      }
      case 'bot.start': return this.start(peer, this.take(peer, raw.lease), raw);
    }
  }

  /**
   * `bot.start`: the bot starts a thread in a project of its lease here, on
   * the rules a thread of another machine starts on (`threads/spawn.ts`). It
   * goes on the bot's desk before its first turn, so that turn's answer goes
   * back as an event of the desk. The answer carries the thread's row.
   */
  private async start(peer: CoordinationPeer, lease: BotLease, raw: Record<string, unknown>): Promise<AgentSpawn & { row: ProjectThreadRow }> {
    const start = checkStartFields(raw, 'bot.start');
    const wanted = start.project.trim().toLowerCase();
    const scope = this.scope(lease);
    const projectId = scope.find(id => id === start.project || this.core.journal.getProject(id)?.name.toLowerCase() === wanted);
    if (projectId === undefined) {
      const names = scope.map(id => this.core.journal.getProject(id)?.name ?? id);
      throw refused(`bot.start.project: ${start.project} is not a project entrusted to ${lease.name} here${names.length ? `; its projects here are ${names.join(', ')}` : ''}`, { field: 'project', expected: names });
    }
    const spawned = await this.core.threads.spawns.startForBot(peer, lease, projectId, start, created => {
      // Worktree preparation can outlive the owner's switch, the asker's membership and the grant.
      if (!this.allowed()) throw refused(GROUP_BOTS_OFF);
      if (this.member(peer.coreId) === null) throw refused('bot.start: the machine that asked is no longer in this group');
      const now = this.leases(peer.coreId)[lease.agentId];
      if (now === undefined || !this.scope(now).includes(projectId)) throw refused(`bot.start.project: ${start.project} is no longer entrusted to ${lease.name} here`, { field: 'project' });
      this.watch(peer.coreId, lease.agentId, created.id, true);
    });
    // A retry puts it back on the desk, whatever a lease sync did meanwhile.
    this.watch(peer.coreId, lease.agentId, spawned.thread.id, true);
    return { ...spawned, row: this.core.workforce.projects.row(this.core.threads.require(spawned.thread.id)) };
  }

  /**
   * The bot's letter to a thread here, which reads it as that bot's, never as
   * the user's. It waits in the inbox only while `covers` still holds; the id
   * the bot's core chose makes a retry deliver it once.
   */
  private letter(peer: CoordinationPeer, lease: BotLease, target: ThreadSummary, text: string, id: string): AgentLetter {
    if (target.archived) throw refused(`bot.send.target: ${target.id} is archived; unarchive it first`, { field: 'target' });
    const now = Date.now();
    const project = target.projectId === null ? null : this.core.journal.getProject(target.projectId);
    const kept = this.core.coordination.acceptLetter({
      origin: 'resident', id, from: { coreId: peer.coreId, threadId: lease.threadId, title: lease.name.slice(0, 200), machine: peer.name, resources: '', status: 'idle', mode: 'brief' },
      to: { coreId: this.core.coordination.card().coreId, threadId: target.id }, toTitle: target.title.slice(0, 200), ...(project ? { toProject: project.name.slice(0, 200) } : {}),
      toMachine: this.core.info().hostname ?? 'Boite', text, replyTo: null, createdAt: now, expiresAt: now + RESIDENT_LETTER_TTL_MS, status: 'received', error: null,
    });
    if (kept.from.coreId !== peer.coreId || kept.from.threadId !== lease.threadId || kept.to.threadId !== target.id || kept.text !== text) throw refused('bot.send.id: already used for different content', { field: 'id' });
    return kept;
  }

  /**
   * `bot.lease`: every bot of that machine with a project or a followed
   * thread here, as its owner entrusted them now. A bot left out lost them;
   * its letters not yet read go nowhere. The answer names the projects a bot
   * may be entrusted and how the followed threads stand.
   */
  private lease(peer: CoordinationPeer, raw: Record<string, unknown>): { projects: { id: string; name: string }[]; rows: ProjectThreadRow[]; started: { agentId: string; row: ProjectThreadRow }[] } {
    if (!Array.isArray(raw.leases) || raw.leases.length > 50) throw invalidParams('bot.lease.leases: expected at most 50 leases');
    const v = raw.v;
    if (typeof v !== 'number' || !Number.isSafeInteger(v)) throw invalidParams('bot.lease.v: expected an integer');
    const sent = raw.leases.map((entry, index) => checkLease(entry, `bot.lease.leases[${index}]`));
    const saved = this.leases(peer.coreId);
    const next: Record<string, BotLease> = {};
    // A lease newer than this sync (one a request carried) stays as it is.
    for (const lease of Object.values(saved)) if (lease.v > v) next[lease.agentId] = lease;
    for (const lease of sent) if (!(lease.agentId in next)) next[lease.agentId] = this.kept(saved[lease.agentId], { ...lease, v });
    this.saveLeases(peer.coreId, next);
    const leased = Object.values(next);
    this.core.coordination.residentRevoked();
    const projects = this.core.journal.listProjects().filter(project => project.archived !== true && project.kind !== 'drafts').map(project => ({ id: project.id, name: project.name }));
    const watched = new Set(leased.flatMap(lease => lease.watched));
    const rows = [...watched].flatMap(id => {
      const thread = this.core.journal.getThread(id);
      return thread !== null && leased.some(lease => this.inScope(lease, thread)) ? [this.core.workforce.projects.row(thread)] : [];
    });
    // The threads it started that the bot does not list go back on its desk there.
    const started = leased.flatMap(lease => (lease.started ?? []).flatMap(id => {
      const thread = this.core.journal.getThread(id);
      return thread !== null && this.inScope(lease, thread) ? [{ agentId: lease.agentId, row: this.core.workforce.projects.row(thread) }] : [];
    }));
    return { projects, rows, started };
  }

  // -- events ------------------------------------------------------------------

  /** The leases of every machine that a thread's event concerns, with whether the bot follows it. */
  private concerned(thread: ThreadSummary): { coreId: string; lease: BotLease; follows: boolean; started: boolean }[] {
    if (!this.allowed() || thread.agentSessionId || thread.parentThreadId || thread.projectId === null) return [];
    return this.coreIds().flatMap(coreId => Object.values(this.leases(coreId))
      .filter(lease => this.inScope(lease, thread))
      .map(lease => ({ coreId, lease, follows: lease.watched.includes(thread.id), started: (lease.started ?? []).includes(thread.id) })));
  }

  private onTurn(turn: Turn): void {
    if (turn.execution?.operation === 'compact' || turn.execution?.operation === 'keepalive') return;
    if (turn.status === 'queued' || turn.status === 'running') return;
    const thread = this.core.journal.getThread(turn.threadId);
    if (thread === null || thread.archived) return;
    for (const { coreId, lease, follows, started } of this.concerned(thread)) {
      // As on its own machine: a followed thread reports every turn, the others only when they fail.
      if (!follows && turn.status !== 'error') continue;
      const answer = this.core.delegation.result(turn);
      this.push(coreId, { agentId: lease.agentId, kind: 'turn', key: `turn:${turn.id}`, row: this.core.workforce.projects.row(thread), status: turn.status, answer: answer === null ? null : cut(answer, TEXT_MAX), ...(started ? { started: true as const } : {}) });
    }
  }

  private onQuestion(question: QuestionRequest): void {
    const thread = this.core.journal.getThread(question.threadId);
    if (thread === null || thread.archived) return;
    for (const { coreId, lease } of this.concerned(thread)) {
      this.push(coreId, { agentId: lease.agentId, kind: 'ask', key: `ask:${question.id}`, row: this.core.workforce.projects.row(thread),
        question: { id: question.id, text: cut(question.text, TEXT_MAX), options: question.options.slice(0, 20).map(option => ({ id: option.id, label: option.label.slice(0, 200) })) } });
    }
  }

  private onPermission(request: PermissionRequest): void {
    const thread = this.core.journal.getThread(request.threadId);
    if (thread === null || thread.archived) return;
    for (const { coreId, lease, follows } of this.concerned(thread)) {
      if (!follows) continue;
      this.push(coreId, { agentId: lease.agentId, kind: 'permission', key: `permission:${request.id}`, row: this.core.workforce.projects.row(thread),
        permission: { tool: request.toolName.slice(0, 200), description: request.description ? cut(request.description, 600) : null } });
    }
  }

  /** A followed thread changed: its row on the bot's desk follows, one per thread in the outbox. */
  private onRow(summary: ThreadSummary): void {
    const thread = this.core.journal.getThread(summary.id);
    if (thread === null) return;
    for (const { coreId, lease, follows } of this.concerned(thread)) {
      if (follows) this.push(coreId, { agentId: lease.agentId, kind: 'row', key: `row:${thread.id}`, row: this.core.workforce.projects.row(thread) });
    }
  }

  /** How the followed threads stand now, sent to a machine after a restart or once `groupBots` is on again. */
  private hello(coreId: string): void {
    for (const lease of Object.values(this.leases(coreId))) {
      for (const id of lease.watched) {
        const thread = this.core.journal.getThread(id);
        if (thread !== null && this.inScope(lease, thread)) this.push(coreId, { agentId: lease.agentId, kind: 'row', key: `row:${id}`, row: this.core.workforce.projects.row(thread) });
      }
    }
  }

  outbox(coreId: string): BotEvent[] { return (this.core.journal.getSetting(`${OUTBOX}${coreId}`) as BotEvent[] | undefined) ?? []; }

  private push(coreId: string, event: BotEvent): void {
    // A row replaces the one waiting for the same thread and bot; an event is kept once.
    const kept = this.outbox(coreId).filter(entry => !(entry.agentId === event.agentId && entry.key === event.key));
    this.core.journal.setSetting(`${OUTBOX}${coreId}`, [...kept, event].slice(-OUTBOX_MAX));
    this.schedule(coreId, FLUSH_MS);
  }

  /** A machine that was away is back: its events go at once. */
  private back(coreId: string): void {
    clearTimeout(this.timers.get(coreId));
    this.timers.delete(coreId);
    this.attempts.delete(coreId);
    this.schedule(coreId, 0);
  }

  private schedule(coreId: string, delay: number): void {
    if (this.closed || this.timers.has(coreId)) return;
    const timer = setTimeout(() => { this.timers.delete(coreId); void this.flush(coreId); }, delay);
    timer.unref?.();
    this.timers.set(coreId, timer);
  }

  /** Sends what waits for a machine; it stays until that machine took it, and is tried again later when it is away. */
  async flush(coreId: string): Promise<void> {
    if (this.closed || this.core.journal.isClosed() || this.sending.has(coreId) || !this.allowed()) return;
    const events = batchOf(this.outbox(coreId));
    if (events.length === 0) return;
    const peer = this.member(coreId);
    // A machine that left the group hears nothing more.
    if (peer === null) { this.core.journal.deleteSetting(`${OUTBOX}${coreId}`); return; }
    this.sending.add(coreId);
    try {
      await this.core.coordination.request(peer, 'bot.event', { events });
      this.attempts.delete(coreId);
      this.drop(coreId, events);
    } catch (error) {
      // A refusal is final: that machine no longer wants them. A machine away gets them later.
      if (error instanceof PeerRefusal) { this.drop(coreId, events); return; }
      const attempt = this.attempts.get(coreId) ?? 0;
      this.attempts.set(coreId, attempt + 1);
      this.schedule(coreId, RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)]!);
    } finally {
      this.sending.delete(coreId);
    }
    if (this.outbox(coreId).length && !this.timers.has(coreId)) this.schedule(coreId, FLUSH_MS);
  }

  private drop(coreId: string, sent: BotEvent[]): void {
    const left = this.outbox(coreId).filter(entry => !sent.some(done => done.agentId === entry.agentId && done.key === entry.key && JSON.stringify(done.row) === JSON.stringify(entry.row)));
    if (left.length) this.core.journal.setSetting(`${OUTBOX}${coreId}`, left);
    else this.core.journal.deleteSetting(`${OUTBOX}${coreId}`);
  }
}

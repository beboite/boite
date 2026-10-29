/*
 * A bot of this machine that looks after projects of another machine of the
 * group (`group-host.ts` is that machine's side). The owner entrusts such a
 * project like a local one; the profile keeps it as `<core-id>/<project-id>`.
 * Every request goes over the group's own sealed link, with the bot's lease:
 * which projects of that machine its owner entrusted and which threads there
 * are on its desk. No key or token of either machine crosses.
 *
 * That machine decides: its `groupBots` setting, its projects as they stand
 * and the group as it is now. A machine that does not answer is said to be
 * unreachable, never silently skipped; its events wait there and arrive once
 * it is back. Threads there on the bot's desk keep the row that machine last
 * sent.
 */
import { createHash } from 'node:crypto';
import type { AgentProfile, AgentWatch, CoordinationPeer, ProjectThreadDetail, ProjectThreadRow, ResidentView, RpcParams, ThreadId } from '@boite/contracts';
import type { Core } from '../core.ts';
import { PeerGone, PeerRefusal, type BotOperation } from '../coordination-wire.ts';
import { invalidParams, messageOf, refused, RpcFailure, unavailable } from '../errors.ts';
import { machineArg, memberNamed } from '../threads/group-spawn.ts';
import { GROUP_BOTS_OFF, OUTBOX_MAX, type BotEvent, type BotLease } from './group-host.ts';
import { QUESTION_GRACE_MS } from './projects.ts';
import { NOTICE_BATCH_MS } from './runtime.ts';
import type { AgentStore } from './store.ts';
import { quoted } from './validation.ts';

const DAY = 86_400_000;
const NAMES = 'group-bots:names:';
const FOLLOW = 'group-bots:follow:';
/** The machines the last sync gave a lease to: one that loses every lease hears it once. */
const LEASED = 'group-bots:leased';
/** How long a request to another machine may take before it counts as unreachable. */
export const REQUEST_MS = 10_000;
const SYNC_MS = 500;
const RETRY_MS = [5_000, 15_000, 60_000, 300_000];
const TEXT_MAX = 1_500;

/** A thread of another machine on a bot's desk, with the row that machine last sent. */
interface RemoteFollow { at: number; origin: AgentWatch['origin']; row: ProjectThreadRow; seenAt: number }
/** How the last request to a machine went. */
interface Reach { error: string | null; at: number }

function within<T>(job: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([job, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not answer in time`)), ms); })]).finally(() => clearTimeout(timer));
}

/** `<core-id>/<project-id>` as a profile keeps a project of another machine, or null for one of this machine. */
export function remoteGrant(id: string): { coreId: string; projectId: string } | null {
  const slash = id.indexOf('/');
  return slash > 0 && slash < id.length - 1 ? { coreId: id.slice(0, slash), projectId: id.slice(slash + 1) } : null;
}

export class GroupBots {
  #closed = false;
  readonly #reach = new Map<string, Reach>();
  readonly #timers = new Map<string, { timer: ReturnType<typeof setTimeout>; at: number }>();
  readonly #attempts = new Map<string, number>();
  readonly #running = new Map<string, Promise<void>>();
  readonly #queued = new Map<string, Promise<void>>();
  /** Sends whose answers have not arrived yet: lease syncs already carry their watches. */
  readonly #sending = new Set<{ agentId: string; coreId: string; threadId: ThreadId }>();
  #version = Date.now();
  readonly #start: ReturnType<typeof setTimeout>;

  readonly #core: Core;
  readonly #store: AgentStore;

  constructor(core: Core, store: AgentStore) { this.#core = core;  this.#store = store;
    // The leases go once the core is up: a restart may follow a grant that never reached its machine.
    this.#start = setTimeout(() => { if (!core.journal.isClosed()) for (const coreId of this.#machines()) this.#schedule(coreId, 0); }, 2_000);
    this.#start.unref?.();
  }

  close(): void {
    this.#closed = true;
    clearTimeout(this.#start);
    for (const held of this.#timers.values()) clearTimeout(held.timer);
    this.#timers.clear();
  }

  /** A version later than every lease sent before, the lease of a single request included. */
  #next(): number { this.#version = Math.max(this.#version + 1, Date.now()); return this.#version; }

  // -- grants ------------------------------------------------------------------

  /** The projects of `coreId` entrusted to a bot, by their id there. */
  grants(agent: Pick<AgentProfile, 'projectIds'>, coreId: string): string[] {
    return (agent.projectIds ?? []).flatMap(id => { const grant = remoteGrant(id); return grant?.coreId === coreId ? [grant.projectId] : []; });
  }
  /** Every machine some bot was entrusted a project of, or was last given a lease. */
  #machines(): string[] {
    const ids = new Set<string>((this.#core.journal.getSetting(LEASED) as string[] | undefined) ?? []);
    for (const agent of this.#store.records.list('profile')) for (const id of agent.projectIds ?? []) { const grant = remoteGrant(id); if (grant) ids.add(grant.coreId); }
    return [...ids];
  }
  #member(coreId: string): CoordinationPeer | null { return this.#core.group.peers().find(peer => peer.coreId === coreId) ?? null; }

  /** What the bot's core sends that machine for one bot, or null when nothing of it is entrusted to the bot. */
  #leaseOf(agent: AgentProfile, coreId: string, v: number): BotLease | null {
    if (agent.status === 'archived') return null;
    const threadId = this.#store.sessionOf(agent.id)?.threadId;
    const projectIds = this.grants(agent, coreId);
    if (!threadId || projectIds.length === 0) return null;
    // A follow is kept as `<core-id>/<thread-id>`.
    const watched = Object.keys(this.#follows(agent.id)).flatMap(key => { const pair = remoteGrant(key); return pair?.coreId === coreId ? [pair.projectId] : []; });
    const pending = [...this.#sending].filter(send => send.agentId === agent.id && send.coreId === coreId).map(send => send.threadId);
    return { agentId: agent.id, threadId, name: agent.name, projectIds, watched: [...new Set([...watched, ...pending])].slice(-200), v };
  }

  /** The owner entrusted or took back projects of other machines, or archived the bot: those machines hear it now. */
  profileChanged(previous: AgentProfile | null, saved: AgentProfile): void {
    const machines = new Set<string>();
    for (const id of [...(previous?.projectIds ?? []), ...(saved.projectIds ?? [])]) { const grant = remoteGrant(id); if (grant) machines.add(grant.coreId); }
    if (previous !== null && previous.status !== saved.status) for (const coreId of this.#machines()) machines.add(coreId);
    // Threads of a project taken back leave the desk at once.
    const follows = this.#follows(saved.id);
    const kept = Object.fromEntries(Object.entries(follows).filter(([key, follow]) => this.#holds(saved, key, follow)));
    if (Object.keys(kept).length !== Object.keys(follows).length) this.#writeFollows(saved.id, kept);
    for (const coreId of machines) this.#schedule(coreId, 0);
  }

  // -- the desk ----------------------------------------------------------------

  #follows(agentId: string): Record<string, RemoteFollow> { return (this.#core.journal.getSetting(`${FOLLOW}${agentId}`) as Record<string, RemoteFollow> | undefined) ?? {}; }
  #writeFollows(agentId: string, follows: Record<string, RemoteFollow>): void {
    if (Object.keys(follows).length === 0) this.#core.journal.deleteSetting(`${FOLLOW}${agentId}`);
    else this.#core.journal.setSetting(`${FOLLOW}${agentId}`, follows);
    this.#store.changed();
  }
  /** A follow holds while the thread's project is still entrusted, and a day past the thread's archive. */
  #holds(agent: Pick<AgentProfile, 'projectIds'>, key: string, follow: RemoteFollow, now = Date.now()): boolean {
    const grant = remoteGrant(key);
    if (grant === null || follow.row.projectId === null || !this.grants(agent, grant.coreId).includes(follow.row.projectId)) return false;
    return !follow.row.archived || follow.seenAt > now - DAY;
  }

  follow(agentId: string, peer: CoordinationPeer, row: ProjectThreadRow, origin: AgentWatch['origin'] = 'followed'): void {
    const follows = this.#follows(agentId);
    const key = `${peer.coreId}/${row.id}`;
    const fresh = follows[key] === undefined;
    // The first origin stays, except that a watch turns a `touched` follow into `followed`.
    const was = follows[key]?.origin;
    this.#writeFollows(agentId, { ...follows, [key]: { at: follows[key]?.at ?? Date.now(), origin: was === undefined || (was === 'touched' && origin === 'followed') ? origin : was, row: { ...row, machine: machineArg(this.#core, peer) }, seenAt: Date.now() } });
    if (fresh) this.#schedule(peer.coreId, SYNC_MS);
  }
  unfollow(agentId: string, coreId: string, threadId: ThreadId): boolean {
    const follows = this.#follows(agentId);
    const key = `${coreId}/${threadId}`;
    if (follows[key] === undefined) return false;
    const { [key]: _gone, ...rest } = follows;
    this.#writeFollows(agentId, rest);
    this.#schedule(coreId, SYNC_MS);
    return true;
  }

  /** A row that machine sent: every desk that holds the thread takes it. */
  #seen(coreId: string, row: ProjectThreadRow): void {
    const key = `${coreId}/${row.id}`;
    for (const agent of this.#store.records.list('profile')) {
      const follows = this.#follows(agent.id);
      if (follows[key] !== undefined && JSON.stringify(follows[key].row) !== JSON.stringify({ ...row, machine: follows[key].row.machine })) {
        this.#writeFollows(agent.id, { ...follows, [key]: { ...follows[key], row: { ...row, machine: follows[key].row.machine }, seenAt: Date.now() } });
      }
    }
  }

  /** The bot's desk rows for threads of other machines, as they were last sent; a machine away says so on each. */
  desk(agent: AgentProfile): AgentWatch[] {
    const now = Date.now();
    return Object.entries(this.#follows(agent.id)).filter(([key, follow]) => this.#holds(agent, key, follow, now)).map(([key, follow]) => {
      const coreId = remoteGrant(key)!.coreId;
      const row = follow.row;
      const reach = this.#reach.get(coreId);
      const pr = row.pullRequest;
      return {
        agentId: agent.id, threadId: row.id, title: row.title, projectId: row.projectId === null ? null : `${coreId}/${row.projectId}`, origin: follow.origin, since: follow.at,
        state: rowState(row), stalledSince: null, lastActivityAt: row.updatedAt,
        pullRequest: pr ? { number: pr.number, url: pr.url, state: pr.state === 'MERGED' ? 'merged' : pr.state === 'CLOSED' ? 'closed' : 'open', checks: null } : null,
        question: null, coreId, machine: row.machine ?? machineArg(this.#core, this.#member(coreId) ?? { coreId, name: coreId.slice(0, 8), url: '', publicKey: '' }),
        ...(reach?.error ? { unreachable: reach.error } : {}),
      };
    });
  }

  /** One line per remote desk thread, for the bot's context block. */
  deskLines(agent: AgentProfile): string[] {
    return this.desk(agent).map(watch => `- ${JSON.stringify({ thread: `${watch.machine}/${watch.threadId}`, title: watch.title, machine: watch.machine, state: watch.unreachable ? `unreachable (${watch.unreachable})` : watch.state })}`);
  }

  /** Whether a fact about `<core-id>/<project-id>/<thread-id>` wakes the agent whatever `eventWakes` says: its desk holds the thread, not only as `touched`. */
  urgent(agentId: string, id: string): boolean {
    const [coreId, , threadId] = id.split('/');
    const follow = this.#follows(agentId)[`${coreId}/${threadId}`];
    const agent = this.#store.records.find('profile', agentId);
    return follow !== undefined && follow.origin !== 'touched' && agent !== null && this.#holds(agent, `${coreId}/${threadId}`, follow);
  }
  /** Whether a fact about `<core-id>/<project-id>/<thread-id>` may still reach the bot: that project is still entrusted to it. */
  mayHear(agent: AgentProfile, id: string): boolean {
    const [coreId, projectId] = id.split('/');
    return coreId !== undefined && projectId !== undefined && this.grants(agent, coreId).includes(projectId);
  }

  // -- the projects it may be entrusted ---------------------------------------

  /** The projects of each member as last read, `<core-id>/<project-id>` with `<machine>/<name>`. */
  choices(): { id: string; label: string }[] {
    return this.#core.group.peers().flatMap(peer => {
      const names = this.#names(peer.coreId);
      return names.map(project => ({ id: `${peer.coreId}/${project.id}`, label: `${machineArg(this.#core, peer)}/${project.name}` }));
    });
  }
  #names(coreId: string): { id: string; name: string }[] {
    return ((this.#core.journal.getSetting(`${NAMES}${coreId}`) as { projects?: { id: string; name: string }[] } | undefined)?.projects) ?? [];
  }
  /** `<machine>/<name>` for a project of another machine, its id there when its name was never read. */
  label(id: string): string {
    const grant = remoteGrant(id);
    if (grant === null) return id;
    const peer = this.#member(grant.coreId);
    const machine = peer ? machineArg(this.#core, peer) : grant.coreId.slice(0, 8);
    return `${machine}/${this.#names(grant.coreId).find(project => project.id === grant.projectId)?.name ?? grant.projectId}`;
  }

  /**
   * Asks every member for its projects, at most `ms` long: a card offering
   * them reads them fresh. A member away keeps the names it gave last.
   */
  async refresh(ms = 3_000): Promise<void> {
    await Promise.allSettled(this.#core.group.peers().map(peer => within(this.sync(peer.coreId), ms, peer.name)));
  }

  /** What `resident.view` adds: the projects of other machines entrusted to the bot. */
  views(agent: AgentProfile): ResidentView['projects'] {
    return (agent.projectIds ?? []).flatMap(id => {
      const grant = remoteGrant(id);
      if (grant === null) return [];
      const peer = this.#member(grant.coreId);
      return [{ id, name: this.label(id), path: '', machine: peer ? machineArg(this.#core, peer) : grant.coreId.slice(0, 8) }];
    });
  }

  // -- leases ------------------------------------------------------------------

  /** A sync of a member's leases; a sooner one replaces a later retry, so a revocation never waits behind a backoff. */
  #schedule(coreId: string, delay: number): void {
    if (this.#closed) return;
    const at = Date.now() + delay;
    const held = this.#timers.get(coreId);
    if (held !== undefined) {
      if (held.at <= at) return;
      clearTimeout(held.timer);
    }
    const timer = setTimeout(() => { this.#timers.delete(coreId); void this.sync(coreId).catch(() => undefined); }, delay);
    timer.unref?.();
    this.#timers.set(coreId, { timer, at });
  }

  /**
   * Sends a machine every lease of this machine's bots there, whole: a bot
   * left out lost its projects there. The answer names its projects and how
   * the followed threads stand. A machine away is asked again later.
   * A call during a sync waits for one more after it, which carries what
   * changed meanwhile: a card reading the names reads them fresh.
   */
  sync(coreId: string): Promise<void> {
    if (this.#closed) return Promise.resolve();
    const running = this.#running.get(coreId);
    if (running === undefined) {
      const run = this.#syncOnce(coreId).finally(() => this.#running.delete(coreId));
      this.#running.set(coreId, run);
      return run;
    }
    let queued = this.#queued.get(coreId);
    if (queued === undefined) {
      queued = running.catch(() => undefined).then(() => { this.#queued.delete(coreId); return this.sync(coreId); });
      this.#queued.set(coreId, queued);
    }
    return queued;
  }

  async #syncOnce(coreId: string): Promise<void> {
    if (this.#core.journal.isClosed()) return;
    const peer = this.#member(coreId);
    if (peer === null) return;
    const v = this.#next();
    const leases = this.#store.records.list('profile').flatMap(agent => { const lease = this.#leaseOf(agent, coreId, v); return lease ? [lease] : []; });
    try {
      const answer = await within(this.#core.coordination.request(peer, 'bot.lease', { v, leases }), REQUEST_MS, peer.name) as { projects?: unknown; rows?: unknown };
      this.#attempts.delete(coreId);
      this.#reached(coreId, null);
      const leased = new Set((this.#core.journal.getSetting(LEASED) as string[] | undefined) ?? []);
      if (leases.length) leased.add(coreId); else leased.delete(coreId);
      this.#core.journal.setSetting(LEASED, [...leased]);
      if (Array.isArray(answer?.projects)) {
        const projects = answer.projects.filter((p): p is { id: string; name: string } => typeof p?.id === 'string' && typeof p?.name === 'string').slice(0, 500).map(p => ({ id: p.id.slice(0, 128), name: p.name.slice(0, 200) }));
        this.#core.journal.setSetting(`${NAMES}${coreId}`, { projects, at: Date.now() });
      }
      if (Array.isArray(answer?.rows)) for (const entry of answer.rows.slice(0, 500)) { const row = rowOf(entry); if (row !== null) this.#seen(coreId, row); }
    } catch (error) {
      this.#reached(coreId, describe(peer, error));
      // A machine that refused tells this one when its owner changes its mind (`setting.changed`).
      if (!(error instanceof PeerRefusal) && !(error instanceof PeerGone)) {
        const attempt = this.#attempts.get(coreId) ?? 0;
        this.#attempts.set(coreId, attempt + 1);
        this.#schedule(coreId, RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)]!);
      }
      throw error;
    }
  }

  #reached(coreId: string, error: string | null): void {
    const before = this.#reach.get(coreId)?.error ?? null;
    this.#reach.set(coreId, { error, at: Date.now() });
    if (before !== error) this.#store.changed();
  }
  /** Why a machine did not answer last, or null. */
  unreachable(coreId: string): string | null { return this.#reach.get(coreId)?.error ?? null; }

  /** A member turned its `groupBots` on or off: the desk says so, and on it takes the leases at once. */
  peerAllows(peer: CoordinationPeer, on: boolean): void {
    if (on) { this.#attempts.delete(peer.coreId); this.#reached(peer.coreId, null); this.#schedule(peer.coreId, 0); }
    else this.#reached(peer.coreId, `${peer.name} turned groupBots off`);
  }

  // -- requests from a member --------------------------------------------------

  /** A `bot.*` request of a member: its events for this machine's bots, or what its bots ask of this machine. */
  async peer(peer: CoordinationPeer, operation: BotOperation, payload: unknown): Promise<unknown> {
    if (operation !== 'bot.event') return this.#core.workforce.groupHost.handle(peer, operation, payload);
    const events = (payload as { events?: unknown } | null)?.events;
    if (!Array.isArray(events) || events.length > OUTBOX_MAX) throw invalidParams(`bot.event.events: expected at most ${OUTBOX_MAX} events`);
    this.#reached(peer.coreId, null);
    for (const event of events) {
      try { this.#heard(peer, event as BotEvent); }
      catch (error) { this.#core.log('warn', `group bot event from ${peer.name}: ${messageOf(error)}`); }
    }
    return { ok: true };
  }

  /** One event of a member: the desk row follows, and the bot hears it while the project is still entrusted to it. */
  #heard(peer: CoordinationPeer, event: BotEvent): void {
    const row = rowOf(event?.row);
    if (typeof event?.agentId !== 'string' || typeof event.key !== 'string' || event.key.length > 512 || row === null) return;
    this.#seen(peer.coreId, row);
    if (event.kind === 'row') return;
    const agent = this.#store.records.find('profile', event.agentId);
    if (agent === null || agent.status !== 'active' || row.projectId === null || !this.grants(agent, peer.coreId).includes(row.projectId)) return;
    const machine = machineArg(this.#core, peer);
    const ref = `${machine}/${row.id}`;
    const follows = this.#follows(agent.id)[`${peer.coreId}/${row.id}`] !== undefined;
    const about = `thread ${ref} on ${peer.name}, titled ${quoted(row.title)}`;
    const threadIds = [`${peer.coreId}/${row.projectId}/${row.id}`];
    const key = `remote:${peer.coreId}:${event.key}`;
    if (event.kind === 'turn') {
      const pr = row.pullRequest ? `\nPull request #${row.pullRequest.number} ${row.pullRequest.state}: ${quoted(row.pullRequest.url)}` : '';
      const answer = typeof event.answer === 'string' ? `Its final answer: ${quoted(cut(event.answer))}` : 'No text answer.';
      this.#store.projects.notify(agent, key, `Turn ${String(event.status)} in ${about}.${pr}\n${answer}`, NOTICE_BATCH_MS, threadIds);
    } else if (event.kind === 'ask' && event.question) {
      const question = event.question;
      const options = Array.isArray(question.options) && question.options.length ? `\nOptions, by id: ${JSON.stringify(Object.fromEntries(question.options.map(option => [option.id, option.label])))}` : '';
      this.#store.projects.notify(agent, key, `The ${about} asks the user, ask ${question.id} (still pending when you read this only if boite thread show ${ref} lists it).\nQuestion: ${quoted(cut(String(question.text)))}${options}`,
        follows ? NOTICE_BATCH_MS : QUESTION_GRACE_MS, threadIds);
    } else if (event.kind === 'permission' && event.permission) {
      const permission = event.permission;
      this.#store.projects.notify(agent, key, `The ${about} waits on the user's permission for the tool ${quoted(String(permission.tool))}${permission.description ? `, described as ${quoted(String(permission.description))}` : ''}. Only the user can allow it, on ${peer.name}.`, QUESTION_GRACE_MS, threadIds);
    }
  }

  // -- what the bot asks -------------------------------------------------------

  /**
   * One request of a bot about a machine of the group, with its lease. A
   * refusal there comes back as a refusal; a machine that does not answer
   * comes back as unavailable, naming it.
   */
  async #ask(threadId: ThreadId, machine: string, method: string, operation: Exclude<BotOperation, 'bot.event' | 'bot.lease'>, payload: Record<string, unknown>): Promise<{ agent: AgentProfile; peer: CoordinationPeer; result: unknown }> {
    const agent = this.#store.projects.botOf(threadId);
    if (agent === null) throw refused(`${method}: no project is entrusted to this conversation; the owner entrusts projects to a bot in its settings on the Bots page`, { field: 'threadId', expected: 'the thread of a bot' });
    if (typeof machine !== 'string' || machine.trim().length === 0) throw invalidParams(`${method}.machine: expected the name of a machine of the group`);
    const peer = memberNamed(this.#core, machine, method);
    const lease = this.#leaseOf(agent, peer.coreId, this.#next());
    if (lease === null) throw refused(`${method}.machine: no project of ${peer.name} is entrusted to ${agent.name}; the owner entrusts one with boite settings request bot projects`, { field: 'machine', machine: machineArg(this.#core, peer) });
    try {
      const result = await within(this.#core.coordination.request(peer, operation, { ...payload, lease }), REQUEST_MS, peer.name);
      this.#reached(peer.coreId, null);
      return { agent, peer, result };
    } catch (error) {
      this.#reached(peer.coreId, describe(peer, error));
      throw error instanceof RpcFailure ? error : failure(this.#core, peer, error);
    }
  }

  #withMachine(peer: CoordinationPeer, row: ProjectThreadRow): ProjectThreadRow { return { ...row, machine: machineArg(this.#core, peer) }; }

  async threads(params: RpcParams<'resident.threads'>): Promise<ProjectThreadRow[]> {
    const { peer, result } = await this.#ask(params.threadId, params.machine!, 'resident.threads', 'bot.threads', { ...(params.project === undefined ? {} : { project: params.project }), archived: params.archived === true });
    return (Array.isArray(result) ? result.flatMap(entry => rowOf(entry) ?? []) : []).map(row => this.#withMachine(peer, row));
  }

  async detail(params: RpcParams<'resident.thread'>): Promise<ProjectThreadDetail> {
    const { peer, result } = await this.#ask(params.threadId, params.machine!, 'resident.thread', 'bot.thread', { target: params.target });
    const detail = result as ProjectThreadDetail;
    const row = rowOf(detail?.thread);
    if (row === null) throw unavailable(`${peer.name} sent no thread`, { field: 'machine' });
    this.#seen(peer.coreId, row);
    return { ...detail, thread: this.#withMachine(peer, row) };
  }

  async act(params: RpcParams<'resident.act'>): Promise<{ thread: ProjectThreadRow }> {
    const { peer, result } = await this.#ask(params.threadId, params.machine!, 'resident.act', 'bot.act', {
      target: params.target, action: params.action, ...(params.title === undefined ? {} : { title: params.title }), ...(params.project === undefined ? {} : { project: params.project }),
    });
    const row = rowOf((result as { thread?: unknown } | null)?.thread);
    if (row === null) throw unavailable(`${peer.name} sent no thread`, { field: 'machine' });
    this.#seen(peer.coreId, row);
    return { thread: this.#withMachine(peer, row) };
  }

  async answer(params: RpcParams<'resident.answer'>): Promise<{ ok: true }> {
    const { agent, peer } = await this.#ask(params.threadId, params.machine!, 'resident.answer', 'bot.answer', {
      target: params.target, questionId: params.questionId, optionIds: params.optionIds, ...(params.text === undefined ? {} : { text: params.text }), ...(params.skip === true ? { skip: true } : {}),
    });
    // As here: a thread it answered for goes on its desk.
    await this.#followAfter(agent, peer, params.target);
    return { ok: true };
  }

  async send(params: RpcParams<'resident.send'>): Promise<{ id: string; status: 'received' }> {
    if (typeof params.requestId !== 'string' || params.requestId.length === 0 || params.requestId.length > 128) throw invalidParams('resident.send.requestId: expected 1 to 128 characters');
    const agent = this.#store.projects.botOf(params.threadId);
    // The same request sends the same letter: that machine takes it once.
    const id = `gb-${createHash('sha256').update(`${agent?.id ?? params.threadId}\n${params.requestId}`).digest('hex').slice(0, 40)}`;
    // The follow becomes visible with the answer, but a newer lease must not erase
    // the host's watch while that answer is still in flight.
    const pending = agent !== null && typeof params.machine === 'string' && params.machine.trim() && typeof params.target === 'string' && params.target.length >= 1 && params.target.length <= 128
      ? { agentId: agent.id, coreId: memberNamed(this.#core, params.machine, 'resident.send').coreId, threadId: params.target }
      : null;
    if (pending) this.#sending.add(pending);
    try {
      const { agent: bot, peer, result } = await this.#ask(params.threadId, params.machine, 'resident.send', 'bot.send', { target: params.target, text: params.text, id });
      const row = rowOf((result as { thread?: unknown } | null)?.thread);
      if (row !== null) this.follow(bot.id, peer, row, 'touched');
      return { id, status: 'received' };
    } finally {
      if (pending) {
        this.#sending.delete(pending);
        // A rejected send leaves no pending watch on the other machine.
        if (this.#follows(pending.agentId)[`${pending.coreId}/${pending.threadId}`] === undefined) this.#schedule(pending.coreId, 0);
      }
    }
  }

  /** `boite bot watch <machine>/<id>`: that machine checks the thread is one of the bot's projects there first. */
  async watch(agent: AgentProfile, machine: string, threadId: ThreadId, watched: boolean): Promise<AgentWatch | null> {
    const peer = memberNamed(this.#core, machine, 'agents.watch');
    if (!watched) { this.unfollow(agent.id, peer.coreId, threadId); return null; }
    const session = this.#store.sessionOf(agent.id);
    if (!session) throw refused(`agents.watch: ${agent.name} has no thread yet`, { field: 'agentId' });
    const { result } = await this.#ask(session.threadId, machine, 'agents.watch', 'bot.thread', { target: threadId });
    const row = rowOf((result as ProjectThreadDetail | null)?.thread);
    if (row === null) throw unavailable(`${peer.name} sent no thread`, { field: 'machine' });
    this.follow(agent.id, peer, row);
    return this.desk(agent).find(watch => watch.coreId === peer.coreId && watch.threadId === row.id) ?? null;
  }

  async #followAfter(agent: AgentProfile, peer: CoordinationPeer, threadId: ThreadId): Promise<void> {
    const known = this.#follows(agent.id)[`${peer.coreId}/${threadId}`];
    if (known) { this.follow(agent.id, peer, known.row, 'touched'); return; }
    try {
      const { result } = await this.#ask(this.#store.sessionOf(agent.id)!.threadId, machineArg(this.#core, peer), 'resident.answer', 'bot.thread', { target: threadId });
      const row = rowOf((result as ProjectThreadDetail | null)?.thread);
      if (row !== null) this.follow(agent.id, peer, row, 'touched');
    } catch { /* The answer went; the desk catches up with the next event. */ }
  }
}

function cut(text: string): string { return text.length > TEXT_MAX ? `${text.slice(0, TEXT_MAX - 20)}\n[Truncated.]` : text; }

const short = (value: unknown, max: number): string | null => (typeof value === 'string' && value.length > 0 && value.length <= max ? value : null);
const capped = (value: unknown, max: number): string | null => (typeof value === 'string' ? value.slice(0, max) : null);
const count = (value: unknown): number => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 10_000) : 0);

/**
 * A row as another machine sent it, bounded before it is kept: ids that do
 * not fit are refused, titles and names are cut, so a desk stays small.
 */
function rowOf(value: unknown): ProjectThreadRow | null {
  const raw = value as Record<string, unknown> | null;
  const id = short(raw?.id, 128);
  const status = short(raw?.status, 32);
  if (raw === null || id === null || status === null || typeof raw.title !== 'string' || typeof raw.archived !== 'boolean' || typeof raw.updatedAt !== 'number') return null;
  const projectId = raw.projectId === null ? null : short(raw.projectId, 128);
  if (projectId === null && raw.projectId !== null) return null;
  const pull = raw.pullRequest as Record<string, unknown> | null | undefined;
  const url = short(pull?.url, 2_048);
  const state = pull?.state;
  return {
    id, title: raw.title.slice(0, 300), projectId, project: capped(raw.project, 200), status: status as ProjectThreadRow['status'], archived: raw.archived,
    ...(raw.done === true ? { done: true as const } : {}), branch: capped(raw.branch, 300), questions: count(raw.questions), permissions: count(raw.permissions),
    pullRequest: url !== null && typeof pull?.number === 'number' && (state === 'OPEN' || state === 'CLOSED' || state === 'MERGED') ? { number: pull.number, url, state } : null,
    updatedAt: raw.updatedAt, lastCompletedAt: typeof raw.lastCompletedAt === 'number' ? raw.lastCompletedAt : null,
  };
}

/** How a desk row stands, from the row that machine sent. */
export function rowState(row: ProjectThreadRow): AgentWatch['state'] {
  if (row.archived) return row.done ? 'done' : 'archived';
  if (row.questions > 0 || row.permissions > 0) return 'needs-you';
  if (row.status === 'running' || row.status === 'waiting') return 'working';
  if (row.status === 'queued') return 'queued';
  if (row.status === 'error') return 'failed';
  return 'idle';
}

/** Why a machine did not take a request, in a few words for the desk. */
function describe(peer: CoordinationPeer, error: unknown): string {
  if (error instanceof PeerRefusal) return error.message === GROUP_BOTS_OFF ? `${peer.name} has groupBots off` : `${peer.name} refused: ${error.message}`;
  if (error instanceof PeerGone) return `${peer.name} removed this machine from its group`;
  return `${peer.name} is unreachable: ${messageOf(error)}`;
}

/** A refusal or an unavailable error a bot can act on, naming the machine. */
function failure(core: Core, peer: CoordinationPeer, error: unknown): RpcFailure {
  const machine = machineArg(core, peer);
  if (error instanceof PeerRefusal) {
    if (error.message === GROUP_BOTS_OFF) {
      return refused(`${peer.name} does not let the bots of the other machines of its group look after its projects; propose the switch to the user with boite settings request groupBots true --machine ${machine} --why "<what you look after there>"`, { field: 'machine', machine, setting: 'groupBots' });
    }
    if (error.message.startsWith('operation: expected')) return refused(`Boite on ${peer.name} is too old to let a bot of another machine look after its projects; the owner updates it in Settings, Machines and updates`, { field: 'machine', machine });
    return refused(`${machine}: ${error.message}`, { field: 'machine', machine });
  }
  if (error instanceof PeerGone) return refused(`${peer.name} removed this machine from its group`, { field: 'machine', machine });
  return unavailable(`${machine} is unreachable (${messageOf(error)}); its events reach you once it is back`, { field: 'machine', machine });
}

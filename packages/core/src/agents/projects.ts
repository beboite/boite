/**
 * Projects the owner entrusted to a persistent agent (`AgentProfile.projectIds`).
 * Its thread reads every thread there, steers them with letters
 * marked as its own, answers what they ask, starts, moves, stops, renames and
 * archives them. Deleting threads and deciding tool permissions stay the
 * owner's. The core tells it what happens in those threads with facts that
 * gather into one `event` turn on its thread (`runtime.ts`).
 *
 * Every `resident.*` method carries the agent's own thread as `threadId`, so
 * the access gate already holds the token to it; the projects are read from
 * its profile at the moment of the call.
 *
 * Its desk is the threads it follows: those it started, wrote to, answered
 * for, was entrusted or put there itself. Facts about the threads it started,
 * was entrusted or watches wake it at once; those about a thread it only
 * wrote to or answered for (`touched`) wake it only with `eventWakes` on, and
 * wait for its next routine otherwise. A follow stays while the thread is
 * open and leaves a day after it is done or archived. A follow the agent made
 * through a project it looks after holds only while that project is still
 * entrusted to it: when the owner takes the project back it leaves the desk
 * with the facts it gathered, and every desk read, fact and context block
 * checks it again. A thread the owner entrusted or watched for the agent
 * stays: that is the owner's own grant. Besides their turns,
 * questions and permissions, the desk reports a running turn silent for
 * `STALL_MS` (once per turn), a pull request merged and checks that start to
 * fail.
 */
import type {
  AgentLetter, AgentProfile, AgentWatch, AgentWatchPullRequest, Message, MessagePart, PermissionRequest, ProjectId, ProjectThreadDetail, ProjectThreadRow, QuestionRequest,
  ResidentThreadAction, ResidentView, RpcParams, ThreadId, ThreadSummary, Turn,
} from '@boite/contracts';
import type { Core } from '../core.ts';
import { invalidParams, messageOf, refused } from '../errors.ts';
import { newId } from '../ids.ts';
import { deskPullRequest } from './context.ts';
import { NOTICE_BATCH_MS } from './runtime.ts';
import type { AgentStore } from './store.ts';
import { quoted } from './validation.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** The open threads one agent's desk holds at most; the oldest follow leaves first. */
export const WATCHES_MAX = 100;
/**
 * A question in a thread the agent does not follow waits this long first:
 * the user, often right there, answers it before the agent is asked to.
 */
export const QUESTION_GRACE_MS = 3 * 60_000;
/** A desk thread's running turn that produced nothing for this long wakes the agent, once per turn. */
export const STALL_MS = 20 * 60_000;
/** How often desk threads are checked for a stall. */
const STALL_CHECK_MS = 10_000;
const NOTICE_TEXT = 1_500;
const FOLLOW = 'resident-follow:';
/** The turn a desk thread stalled on, and since when it is silent (null once it spoke again). */
const STALL = 'agents:stall:';
const ACTIONS: readonly ResidentThreadAction[] = ['archive', 'done', 'unarchive', 'stop', 'rename', 'move'];

/**
 * One followed thread; older cores saved the time alone. `pr` is the pull
 * request as the agent was last told of it, so a merge or failing checks
 * wake it once. `owner`: the owner put it there, so it holds whatever the
 * agent's projects (an entrusted thread is one too).
 */
/** `lent`: the `owner` flag came with an entrustment of a thread the bot already followed, and leaves with it. */
type Follow = { at: number; origin: AgentWatch['origin']; pr?: AgentWatchPullRequest | null; owner?: true; lent?: true };
interface Stall { turnId: string; since: number | null }

/**
 * The bot that acts on a thread: one of this machine (`steward`) or one of
 * another machine of the group (`group-host.ts`). `by` words it in the
 * target's timeline; `follow` puts the thread on its desk when it has one here.
 */
export interface Steward {
  agentId: string;
  name: string;
  projectIds: readonly ProjectId[];
  by(target: ThreadSummary): string;
  log: Record<string, string>;
  follow?(threadId: ThreadId): void;
}

/** Whether a follow of this thread still holds: it is open, or done or archived less than a day ago. */
function holding(thread: ThreadSummary | null, now: number): thread is ThreadSummary {
  if (thread === null) return false;
  if (!thread.archived) return true;
  return (thread.archivedAt ?? thread.updatedAt) > now - DAY;
}

function trimmed(text: string, max: number): string {
  const flat = text.trim();
  return flat.length > max ? `${flat.slice(0, max - 20)}\n[Truncated.]` : flat;
}

/** Follows newest first; within one millisecond, the one saved later first. */
function newestFirst(entries: [string, Follow][]): [string, Follow][] {
  return entries.map((entry, index) => ({ entry, index })).sort((a, b) => b.entry[1].at - a.entry[1].at || b.index - a.index).map(({ entry }) => entry);
}

export class AgentProjects {
  readonly #off: () => void;
  #closed = false;
  /** The agents each desk thread is on, built from the saved follows on first use and after each write. */
  #desk: Map<ThreadId, Set<string>> | null = null;
  /** When each desk thread's running turn last produced something. A restart starts the count again. */
  readonly #heard = new Map<ThreadId, number>();
  readonly #stalls = new Map<ThreadId, Stall>();
  #checkedAt = 0;

  readonly #core: Core;
  readonly #store: AgentStore;

  constructor(core: Core, store: AgentStore) { this.#core = core;  this.#store = store;
    for (const row of core.journal.db.query("SELECT key, value FROM settings WHERE key LIKE 'agents:stall:%'").all() as { key: string; value: string }[]) {
      try { this.#stalls.set(row.key.slice(STALL.length), JSON.parse(row.value) as Stall); } catch { /* A stall record that does not parse is no stall. */ }
    }
    this.#off = core.bus.onAny((name, payload) => {
      if (this.#closed || core.journal.isClosed()) return;
      try {
        if (name === 'turn.finished') this.#noticeTurn(payload as Turn);
        else if (name === 'question.asked') this.#noticeQuestion(payload as QuestionRequest);
        else if (name === 'permission.requested') this.#noticePermission(payload as PermissionRequest);
        this.#onDesk(name, payload);
      } catch (error) {
        core.log('warn', `agent notice after ${name}: ${messageOf(error)}`);
      }
    });
  }

  close(): void { this.#closed = true; this.#off(); }

  // -- who looks after what ---------------------------------------------------

  /** The projects of a profile that still exist and are not archived; drafts never count. `live` remembers each project read across profiles. */
  projectsOf(agent: Pick<AgentProfile, 'projectIds'>, live = new Map<ProjectId, boolean>()): ProjectId[] {
    return (agent.projectIds ?? []).filter(id => {
      let kept = live.get(id);
      if (kept === undefined) {
        const project = this.#core.journal.getProject(id);
        kept = project !== null && project.archived !== true && project.kind !== 'drafts';
        live.set(id, kept);
      }
      return kept;
    });
  }

  /**
   * The agent whose thread `threadId` is, with the projects entrusted to it,
   * or null. A paused agent still acts when the user asks it to; an archived
   * one's thread is read-only.
   */
  residentOf(threadId: ThreadId): { agent: AgentProfile; projectIds: ProjectId[] } | null {
    const agent = this.botOf(threadId);
    if (!agent) return null;
    const projectIds = this.projectsOf(agent);
    return projectIds.length ? { agent, projectIds } : null;
  }
  /** The bot whose own thread `threadId` is, projects or not, or null. */
  botOf(threadId: ThreadId): AgentProfile | null {
    const thread = this.#core.journal.getThread(threadId);
    if (!thread?.agentSessionId || thread.archived || thread.parentThreadId) return null;
    const agent = this.#store.agentOfThread(threadId);
    return !agent || agent.status === 'archived' ? null : agent;
  }
  /**
   * Whether the bot started `threadId` (`boite thread new`) and it is still on
   * its desk: full control follows a thread it started, in any project.
   */
  startedBy(agentId: string, threadId: ThreadId): boolean {
    return this.#saved(agentId)[threadId]?.origin === 'started' && this.follows(agentId, threadId);
  }
  /** Whether the bot may drive `target`: a thread of its projects, or one it started. */
  #drives(agent: AgentProfile, projectIds: readonly ProjectId[], target: ThreadSummary): boolean {
    if (target.agentSessionId || target.projectId === null) return false;
    return projectIds.includes(target.projectId) || this.startedBy(agent.id, target.id);
  }

  /** Active agents the project is entrusted to: a paused one gathers no facts. */
  agentsFor(projectId: ProjectId | null): AgentProfile[] {
    if (projectId === null) return [];
    const live = new Map<ProjectId, boolean>();
    return this.#store.records.list('profile').filter(agent => agent.status === 'active' && this.projectsOf(agent, live).includes(projectId));
  }

  /**
   * The agent under which `fromId` may touch `targetId`, or null. Used by
   * coordination to mark letters and by the spawn gate; never throws.
   */
  over(fromId: ThreadId, targetId: ThreadId): AgentProfile | null {
    if (fromId === targetId) return null;
    const agent = this.botOf(fromId);
    if (agent === null) return null;
    const target = this.#core.journal.getThread(targetId);
    return target !== null && this.#drives(agent, this.projectsOf(agent), target) ? agent : null;
  }

  /**
   * Whether a letter marked as an agent's may reach its thread now, or null
   * when ordinary coordination rules decide. One from a bot of another
   * machine of the group holds while its lease and `groupBots` do here.
   */
  mayReceive(letter: AgentLetter, local: boolean): boolean | null {
    if (letter.origin !== 'resident') return null;
    if (!local) return this.#store.groupHost.covers(letter.from.coreId, letter.from.threadId, letter.to.threadId);
    return this.over(letter.from.threadId, letter.to.threadId) !== null;
  }

  // -- its desk: the threads it follows ---------------------------------------

  #saved(agentId: string): Record<string, Follow> {
    const raw = (this.#core.journal.getSetting(`${FOLLOW}${agentId}`) as Record<string, number | Follow> | undefined) ?? {};
    return Object.fromEntries(Object.entries(raw).map(([id, value]) => [id, typeof value === 'number' ? { at: value, origin: 'followed' as const } : value]));
  }
  #write(agentId: string, follows: Record<string, Follow>): void {
    this.#core.journal.setSetting(`${FOLLOW}${agentId}`, follows);
    this.#desk = null;
    this.#store.changed();
  }

  /** The threads of a desk in one read: a desk holds up to `WATCHES_MAX` open ones and the settled ones of the last day. */
  #threadsOf(ids: Iterable<ThreadId>): Map<ThreadId, ThreadSummary> {
    return new Map(this.#core.journal.listThreadsIn(ids).map(thread => [thread.id, thread]));
  }

  /**
   * The agent follows a thread: it started it, wrote to it, answered for it
   * (`touched`), was entrusted it or put it on its desk. Every turn it ends
   * comes back to the agent as a fact. The first origin stays, except that a
   * watch turns a `touched` follow into `followed`. Past `WATCHES_MAX` open
   * threads the oldest open follow leaves; settled ones leave a day after.
   */
  follow(agentId: string, threadId: ThreadId, origin: AgentWatch['origin'] = 'followed', owner = false): void {
    const now = Date.now();
    const saved = this.#saved(agentId);
    const previous = saved[threadId];
    const threads = this.#threadsOf([...Object.keys(saved), threadId]);
    const isOpen = (id: ThreadId) => threads.get(id)?.archived === false;
    const others = newestFirst(Object.entries(saved).filter(([id]) => id !== threadId && holding(threads.get(id) ?? null, now)));
    let open = isOpen(threadId) ? 1 : 0;
    const kept = new Set(others.filter(([id]) => !isOpen(id) || ++open <= WATCHES_MAX).map(([id]) => id));
    // Saved oldest first, so the order of the entries breaks ties within one millisecond.
    const follows = Object.fromEntries(Object.entries(saved).filter(([id]) => kept.has(id)));
    // A new follow records the pull request as it stands, so its merge or failing checks are news.
    const thread = previous ? null : threads.get(threadId) ?? null;
    const pr = thread ? { pr: deskPullRequest(this.#core, thread) } : {};
    const granted = owner || origin === 'entrusted' || previous?.owner === true ? { owner: true as const } : {};
    // A follow the bot had before an entrustment keeps what it was: only the grant the entrustment adds is lent.
    const lent = !owner && (previous?.lent === true || (origin === 'entrusted' && previous !== undefined && previous.owner !== true));
    const { lent: _lent, ...before } = previous ?? {};
    // The owner watching a thread entrusted to the bot grants it on its own: a `followed` watch the entrustment's end leaves.
    const from = (owner && previous?.origin === 'entrusted') || (previous?.origin === 'touched' && origin === 'followed') ? 'followed' : previous?.origin ?? origin;
    this.#write(agentId, { ...follows, [threadId]: { ...before, ...pr, at: now, origin: from, ...granted, ...(lent ? { lent: true as const } : {}) } });
  }
  /**
   * An entrustment ended (taken back, met, archived, removed, given to another
   * bot): the grant that came with it goes. A follow the bot had before stays
   * as it was. One the entrustment made stays only when the bot reaches the
   * thread another way, its project entrusted to it, as `followed`.
   */
  release(agent: AgentProfile, threadId: ThreadId): void {
    const saved = this.#saved(agent.id);
    const follow = saved[threadId];
    if (!follow) return;
    const { owner: _owner, lent: _lent, ...rest } = follow;
    if (follow.origin !== 'entrusted') {
      if (!follow.lent) return;
      saved[threadId] = rest;
    } else {
      const kept: Follow = { ...rest, origin: 'followed' };
      const thread = this.#core.journal.getThread(threadId);
      if (thread && this.#allowed(agent.id, kept, thread)) saved[threadId] = kept;
      else delete saved[threadId];
    }
    this.#write(agent.id, saved);
    this.#core.agentRuntime.filterFacts(agent.id, fact => this.#core.agentRuntime.factThreads(fact).every(id => this.mayHear(agent, id)));
  }
  unfollow(agentId: string, threadId: ThreadId): boolean {
    const saved = this.#saved(agentId);
    if (!(threadId in saved)) return false;
    delete saved[threadId];
    this.#write(agentId, saved);
    return true;
  }
  /** Whether the agent follows the thread now: the follow holds and the agent may still see the thread. */
  follows(agentId: string, threadId: ThreadId): boolean {
    const follow = this.#saved(agentId)[threadId];
    if (!follow) return false;
    const thread = this.#core.journal.getThread(threadId);
    return holding(thread, Date.now()) && this.#allowed(agentId, follow, thread);
  }
  /**
   * Whether a fact about the thread wakes the agent whatever `eventWakes`
   * says: it is on its desk as started, entrusted or watched, not only
   * written to or answered for, or the owner put it there.
   */
  urgent(agentId: string, threadId: ThreadId): boolean {
    // `<core-id>/<project-id>/<thread-id>`: a thread of another machine of the group.
    if (threadId.split('/').length === 3) return this.#store.group.urgent(agentId, threadId);
    const follow = this.#saved(agentId)[threadId];
    return follow !== undefined && (follow.origin !== 'touched' || follow.owner === true) && this.follows(agentId, threadId);
  }
  /**
   * The owner's grant, or a thread of a project still entrusted to the agent:
   * what a follow needs to reach the agent. `projects` saves reading the
   * profile again for every follow of one desk.
   */
  #allowed(agentId: string, follow: Follow, thread: ThreadSummary, projects?: readonly ProjectId[]): boolean {
    // A thread it started stays its own, in any project, whatever the owner entrusts later.
    if (follow.owner === true || follow.origin === 'entrusted' || follow.origin === 'started') return true;
    if (thread.projectId === null) return false;
    if (projects) return projects.includes(thread.projectId);
    const agent = this.#store.records.find('profile', agentId);
    return agent !== null && this.projectsOf(agent).includes(thread.projectId);
  }
  /**
   * Whether a fact about `threadId` may still reach the agent: the thread is
   * in one of its projects, or on its desk by a follow that still holds.
   */
  mayHear(agent: AgentProfile, threadId: ThreadId): boolean {
    // `<core-id>/<project-id>/<thread-id>`: a thread of another machine of the group.
    if (threadId.split('/').length === 3) return this.#store.group.mayHear(agent, threadId);
    const projectId = this.#core.journal.getThread(threadId)?.projectId;
    return (projectId != null && this.projectsOf(agent).includes(projectId)) || this.follows(agent.id, threadId);
  }
  /** The threads on an agent's desk with each thread as read, open ones first, each group newest follow first. */
  watchesOf(agentId: string): { threadId: ThreadId; origin: AgentWatch['origin']; since: number; thread: ThreadSummary }[] {
    const now = Date.now();
    const saved = this.#saved(agentId);
    const threads = this.#threadsOf(Object.keys(saved));
    const agent = this.#store.records.find('profile', agentId);
    const projects = agent ? this.projectsOf(agent) : [];
    const follows = newestFirst(Object.entries(saved).filter(([id, follow]) => {
      const thread = threads.get(id) ?? null;
      return holding(thread, now) && this.#allowed(agentId, follow, thread, projects);
    }))
      .map(([threadId, follow]) => ({ threadId, origin: follow.origin, since: follow.at, thread: threads.get(threadId)! }));
    return [...follows.filter(f => !f.thread.archived), ...follows.filter(f => f.thread.archived)];
  }
  /** Active agents that follow a thread, whatever its project: only those whose desk lists it are read. */
  #followers(threadId: ThreadId): AgentProfile[] {
    const agentIds = this.#deskIndex().get(threadId);
    if (!agentIds) return [];
    return this.#store.records.list('profile').filter(agent => agent.status === 'active' && agentIds.has(agent.id) && this.follows(agent.id, threadId));
  }
  /** Every desk thread with the agents whose desk it is on, whatever their status. */
  #deskIndex(): Map<ThreadId, Set<string>> {
    if (this.#desk) return this.#desk;
    const desk = new Map<ThreadId, Set<string>>();
    for (const agent of this.#store.records.list('profile')) {
      for (const threadId of Object.keys(this.#saved(agent.id))) {
        const agents = desk.get(threadId) ?? new Set<string>();
        agents.add(agent.id);
        desk.set(threadId, agents);
      }
    }
    this.#desk = desk;
    return desk;
  }

  /** When a desk thread's running turn last produced something, since this core started. */
  lastHeard(threadId: ThreadId): number | null { return this.#heard.get(threadId) ?? null; }

  /** Since when a desk thread's running turn is silent, once that wakes its agents, else null. */
  stalledSince(threadId: ThreadId): number | null {
    const stall = this.#stalls.get(threadId);
    if (stall?.since == null) return null;
    const status = this.#core.journal.getThread(threadId)?.status;
    return status === 'running' || status === 'waiting' ? stall.since : null;
  }

  /**
   * What happens on a desk thread: its row changes for the client, a word
   * from its running turn resets the stall clock, and its pull request is
   * compared with what its agents were last told.
   */
  #onDesk(name: string, payload: unknown): void {
    const threadId = name === 'thread.updated' ? (payload as { id?: unknown }).id : (payload as { threadId?: unknown } | null)?.threadId;
    if (typeof threadId !== 'string' || !this.#deskIndex().has(threadId)) return;
    if (name === 'message.delta' || name === 'message.part' || name === 'message.started' || name === 'message.completed') {
      this.#heard.set(threadId, Date.now());
      const stall = this.#stalls.get(threadId);
      // It spoke again: the turn is no longer stalled, and it will not wake the agent twice.
      if (stall?.since != null) { this.#setStall(threadId, { ...stall, since: null }); this.#store.changed(); }
      return;
    }
    if (name === 'turn.started' || name === 'turn.finished') {
      this.#heard.set(threadId, Date.now());
      if (name === 'turn.finished' && this.#stalls.has(threadId)) this.#setStall(threadId, null);
    }
    if (name === 'thread.updated' || name === 'threads.pullRequestsChanged') this.#comparePullRequest(threadId);
    if (name === 'thread.updated' || name === 'thread.removed' || name.startsWith('turn.') || name.startsWith('question.') || name.startsWith('permission.') || name === 'threads.pullRequestsChanged') this.#store.changed();
  }

  #setStall(threadId: ThreadId, stall: Stall | null): void {
    if (stall === null) { this.#stalls.delete(threadId); this.#core.journal.deleteSetting(`${STALL}${threadId}`); return; }
    this.#stalls.set(threadId, stall);
    this.#core.journal.setSetting(`${STALL}${threadId}`, stall);
  }

  /** Called on the agents' tick: every `STALL_CHECK_MS`, desk threads whose running turn went silent. */
  tick(now = Date.now()): void {
    if (this.#closed || now - this.#checkedAt < STALL_CHECK_MS) return;
    this.#checkedAt = now;
    this.checkStalls(now);
  }

  /**
   * A desk thread whose running turn produced nothing for `STALL_MS` wakes the
   * agents whose desk it is on, once per turn. A turn already silent when the
   * core started is counted from the first check.
   */
  checkStalls(now = Date.now()): void {
    const desk = this.#deskIndex();
    if (desk.size === 0 && this.#stalls.size === 0) return;
    // One read of the threads at work, not one per desk thread: a desk holds hundreds, few of them run.
    const working = new Map(this.#core.journal.listThreadsWithStatus(['running', 'waiting']).filter(thread => !thread.archived).map(thread => [thread.id, thread]));
    // A turn that ended while the core was down left its stall behind.
    for (const threadId of [...this.#stalls.keys()]) if (!working.has(threadId)) this.#setStall(threadId, null);
    for (const [threadId, thread] of working) {
      const agentIds = desk.get(threadId);
      if (!agentIds) continue;
      const turn = this.#core.journal.runningTurn(threadId);
      if (turn === null || this.#stalls.get(threadId)?.turnId === turn.id) continue;
      // A card waiting for the user is no stall: the question and permission events tell of it.
      if (this.#core.threads.listQuestions(threadId).length || this.#core.threads.listPermissions(threadId).length) continue;
      const heard = this.#heard.get(threadId);
      if (heard === undefined) { this.#heard.set(threadId, now); continue; }
      if (now - heard < STALL_MS) continue;
      this.#setStall(threadId, { turnId: turn.id, since: heard });
      const minutes = Math.round((now - heard) / 60_000);
      for (const agentId of agentIds) {
        const agent = this.#store.records.find('profile', agentId);
        if (agent?.status !== 'active' || !this.follows(agentId, threadId)) continue;
        this.notify(agent, `stall:${turn.id}`, `Thread ${thread.id}, titled ${quoted(thread.title)}, has a running turn that produced nothing for ${minutes} minutes. `
          + `Read it with boite thread show ${thread.id}; steer it with boite thread send, or stop it with boite thread stop ${thread.id}.`, NOTICE_BATCH_MS, [thread.id]);
      }
      this.#store.changed();
    }
  }

  /**
   * The desk thread's pull request against what each agent was last told:
   * a merge, or checks that start to fail, is a fact. The first sight of a
   * pull request is only recorded.
   */
  #comparePullRequest(threadId: ThreadId): void {
    const thread = this.#core.journal.getThread(threadId);
    if (thread === null) return;
    const now = deskPullRequest(this.#core, thread);
    for (const agentId of this.#deskIndex().get(threadId) ?? []) {
      const saved = this.#saved(agentId);
      const follow = saved[threadId];
      if (!follow || JSON.stringify(follow.pr ?? null) === JSON.stringify(now)) continue;
      const was = follow.pr ?? null;
      this.#core.journal.setSetting(`${FOLLOW}${agentId}`, { ...saved, [threadId]: { ...follow, pr: now } });
      const agent = this.#store.records.find('profile', agentId);
      if (now === null || was === null || agent?.status !== 'active' || !this.follows(agentId, threadId)) continue;
      const same = was.url === now.url;
      if (now.state === 'merged' && (!same || was.state !== 'merged')) {
        this.notify(agent, `pr-merged:${now.url}`, `Pull request #${now.number} of thread ${thread.id}, titled ${quoted(thread.title)}, was merged: ${quoted(now.url)}. `
          + `Mark the thread done (boite thread done ${thread.id}) once nothing is left in it.`, NOTICE_BATCH_MS, [thread.id]);
      } else if (now.checks === 'failing' && (!same || was.checks !== 'failing')) {
        const seen = this.#core.pullRequestWatches.of(threadId).find(w => w.url.toLowerCase() === now.url.toLowerCase())?.seen;
        const counts = seen ? ` (${seen.checks.failed} of ${seen.checks.total} failed on ${seen.head})` : '';
        this.notify(agent, `pr-checks:${now.url}:${seen?.head ?? Date.now()}`, `Checks fail on pull request #${now.number} of thread ${thread.id}, titled ${quoted(thread.title)}${counts}: ${quoted(now.url)}. `
          + `Its thread is ${thread.status}; steer it with boite thread send ${thread.id} if it is not fixing them.`, NOTICE_BATCH_MS, [thread.id]);
      }
    }
  }

  // -- agent methods ----------------------------------------------------------

  #require(threadId: ThreadId, method: string): { agent: AgentProfile; projectIds: ProjectId[] } {
    const resident = this.residentOf(threadId);
    if (resident === null) {
      throw refused(`${method}: no project is entrusted to this conversation; the owner entrusts projects to a bot in its settings on the Bots page`, { threadId, field: 'threadId', expected: 'the thread of an agent with projects' });
    }
    return resident;
  }

  /** The target thread, held to the bot's projects and the threads it started. */
  #target(threadId: ThreadId, targetId: unknown, method: string): { agent: AgentProfile; projectIds: ProjectId[]; target: ThreadSummary } {
    const agent = this.botOf(threadId);
    if (agent === null) throw refused(`${method}: no project is entrusted to this conversation; the owner entrusts projects to a bot in its settings on the Bots page`, { threadId, field: 'threadId', expected: 'the thread of a bot' });
    const resident = { agent, projectIds: this.projectsOf(agent) };
    if (typeof targetId !== 'string' || targetId.length === 0) throw invalidParams(`${method}.target: expected a thread id`);
    const target = this.#core.journal.getThread(targetId);
    if (target === null || !this.#drives(resident.agent, resident.projectIds, target)) {
      throw refused(`${method}.target: ${targetId} is not a thread of the projects entrusted to this bot, nor one it started`, { threadId, field: 'target', target: targetId, expected: 'a thread in one of its projects, or one it started' });
    }
    return { ...resident, target };
  }

  view(threadId: ThreadId): ResidentView {
    const agent = this.botOf(threadId);
    const local = agent === null ? [] : this.projectsOf(agent).map(id => this.#core.journal.getProject(id)!).map(project => ({ id: project.id, name: project.name, path: project.path }));
    const projects = [...local, ...(agent === null ? [] : this.#store.group.views(agent))];
    return agent === null || projects.length === 0 ? { agentId: null, name: null, projects: [] } : { agentId: agent.id, name: agent.name, projects };
  }

  threads(params: RpcParams<'resident.threads'>): ProjectThreadRow[] {
    const resident = this.#require(params.threadId, 'resident.threads');
    let projectIds = resident.projectIds;
    if (params.project !== undefined) {
      const project = this.#core.projects.find(params.project, 'resident.threads', 'project', { threadId: params.threadId });
      if (!resident.projectIds.includes(project.id)) throw refused(`resident.threads.project: ${params.project} is not entrusted to this bot`, { threadId: params.threadId, field: 'project', expected: 'one of its projects' });
      projectIds = [project.id];
    }
    return this.rows(projectIds, params.archived === true);
  }

  /** The top-level threads of `projectIds`, open or archived, the most recently active first. */
  rows(projectIds: readonly ProjectId[], archived: boolean): ProjectThreadRow[] {
    return projectIds.flatMap(id => this.#core.journal.listThreads(id))
      .filter(thread => !thread.agentSessionId && !thread.parentThreadId && thread.archived === archived)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 200)
      .map(thread => this.row(thread));
  }

  detail(params: RpcParams<'resident.thread'>) {
    return this.detailOf(this.#target(params.threadId, params.target, 'resident.thread').target);
  }

  /** A thread with its pending questions, permissions and last answer. */
  detailOf(target: ThreadSummary): ProjectThreadDetail {
    const last = this.#core.journal.lastEndedTurn(target.id);
    return {
      thread: this.row(target),
      questions: this.#core.threads.listQuestions(target.id),
      permissions: this.#core.threads.listPermissions(target.id),
      lastAnswer: this.#core.delegation.result(last),
    };
  }

  async act(params: RpcParams<'resident.act'>): Promise<{ thread: ProjectThreadRow }> {
    const method = 'resident.act';
    if (!ACTIONS.includes(params.action)) throw invalidParams(`${method}.action: expected one of ${ACTIONS.join(', ')}; deleting a thread stays the owner's`);
    const { agent, projectIds, target } = this.#target(params.threadId, params.target, method);
    return this.perform(this.#steward(agent, projectIds), target, params, method);
  }

  /** A bot of this machine as `perform` and `answerAs` take it. */
  #steward(agent: AgentProfile, projectIds: readonly ProjectId[]): Steward {
    return { agentId: agent.id, name: agent.name, projectIds, by: target => this.#by(agent, projectIds, target), log: { residentAgentId: agent.id }, follow: threadId => this.follow(agent.id, threadId, 'touched') };
  }

  /**
   * What a bot does to a thread it may drive, here or from another machine of
   * the group: the same actions, each with a line in the target's timeline.
   * Deleting it and deciding its tool permissions are no action.
   */
  async perform(steward: Steward, target: ThreadSummary, params: { action: ResidentThreadAction; title?: string; project?: string }, method: string): Promise<{ thread: ProjectThreadRow }> {
    const action = params.action;
    if (!ACTIONS.includes(action)) throw invalidParams(`${method}.action: expected one of ${ACTIONS.join(', ')}; deleting a thread stays the owner's`);
    const by = steward.by(target);
    if (target.parentThreadId && action !== 'stop') {
      throw refused(`${method}: ${target.id} is a delegated agent; act on its parent ${target.parentThreadId}`, { field: 'target', expected: 'a top-level thread' });
    }
    switch (action) {
      case 'archive':
      case 'unarchive':
        this.#core.threads.archive(target.id, action === 'archive');
        this.#line(target.id, `${action === 'archive' ? 'Archived' : 'Unarchived'} by ${by}.`);
        break;
      case 'done':
        // As the user's Mark done: never over a turn at work, and the thread lands in the Done list.
        this.#core.threads.archive(target.id, true, true);
        this.#line(target.id, `Marked done by ${by}.`);
        break;
      case 'stop': {
        this.#core.activity.pauseAll(target.id);
        const stopped = this.#core.threads.stopTurn(target.id);
        // The same fields as an owner's or an agent's stop in threads/rpc.ts: a persistent agent is an agent principal.
        this.#core.logs.info(`Stop requested by the agent ${steward.name}: ${stopped ? 'a turn was stopped' : 'nothing was running'}`, { source: 'turns', event: 'turn.stop-asked', threadId: target.id, data: { principal: 'agent', client: null, stopped, ...steward.log } });
        if (stopped) this.#line(target.id, `Stopped by ${by}.`);
        break;
      }
      case 'rename': {
        const title = typeof params.title === 'string' ? params.title.trim() : '';
        if (title.length === 0 || title.length > 120) throw invalidParams(`${method}.title: expected 1 to 120 characters`);
        this.#core.threads.update({ threadId: target.id, title });
        this.#line(target.id, `Renamed "${title}" by ${by}.`);
        break;
      }
      case 'move': {
        const project = this.#core.projects.find(params.project, method, 'project');
        if (!steward.projectIds.includes(project.id)) throw refused(`${method}.project: ${project.name} is not entrusted to this bot`, { field: 'project', expected: 'another of its projects' });
        if (project.id === target.projectId) throw refused(`${method}.project: ${target.id} is already in ${project.name}`, { field: 'project', expected: 'another project' });
        await this.#core.threads.move(target.id, project.id);
        this.#line(target.id, `Moved to ${project.name} by ${by}.`);
        break;
      }
    }
    return { thread: this.row(this.#core.threads.require(target.id)) };
  }

  answer(params: RpcParams<'resident.answer'>): { ok: true } {
    const { agent, projectIds, target } = this.#target(params.threadId, params.target, 'resident.answer');
    return this.answerAs(this.#steward(agent, projectIds), target, params, 'resident.answer');
  }

  /** A bot answers or skips a pending question of a thread it may drive, marked as its own in that timeline. */
  answerAs(steward: Steward, target: ThreadSummary, params: { questionId: string; optionIds: string[]; text?: string; skip?: boolean }, method: string): { ok: true } {
    const question = this.#core.threads.listQuestions(target.id).find(request => request.id === params.questionId);
    if (question === undefined) throw refused(`${method}.questionId: ${String(params.questionId)} is not a pending question of ${target.id}`, { field: 'questionId', expected: 'a pending question id of the target' });
    if (params.skip === true) this.#core.threads.skipQuestion({ threadId: target.id, questionId: question.id }, 'agent');
    else {
      if (!Array.isArray(params.optionIds)) throw invalidParams(`${method}.optionIds: expected an array of option ids`);
      this.#core.threads.answerQuestion({ threadId: target.id, questionId: question.id, optionIds: params.optionIds, ...(params.text === undefined ? {} : { text: params.text }) }, 'agent');
    }
    steward.follow?.(target.id);
    this.#line(target.id, `${params.skip === true ? 'Question skipped' : 'Question answered'} by ${steward.by(target)}, not by the user.`);
    return { ok: true };
  }

  /** What the agent's context block says about its projects and the commands that reach them, or nothing. */
  instructions(agent: AgentProfile): string {
    const projectIds = this.projectsOf(agent);
    const remote = this.#store.group.views(agent);
    const away = remote.length === 0 ? '' : `Projects of other machines of the group entrusted to you: ${remote.map(project => project.name).join(', ')}. `
      + '`boite threads` lists their threads as `<machine>/<thread-id>` with `machine=<name>`; name them that way in `boite thread show|send|done|archive|unarchive|stop <id>`, `boite thread rename <id> <title>`, `boite answer` and `boite bot watch`. '
      + 'That machine decides: it may refuse bots of the group, and a machine that does not answer is named unreachable; its events reach you once it is back. You cannot start threads there.';
    if (!projectIds.length) return away;
    const projects = projectIds.map(id => this.#core.journal.getProject(id)!).map(p => `${p.name} (${p.path})`).join(', ');
    return `Projects the user entrusted to you: ${projects}. You look after every Boite thread in them. Code work happens in those threads, never in this conversation: `
      + '`boite thread new <project> <brief>` starts one (its agent codes, verifies and opens the pull request); `boite threads [--project <p>] [--archived]` lists them with your desk; `boite thread show <id>` reads one with its questions and last answer; '
      + '`boite thread send <id> <text>` steers one (it reaches it as your message, never as the user\'s); `boite thread done|archive|unarchive|stop <id>`, `boite thread rename <id> <title>`, `boite thread move <project> <id>`; '
      + '`boite answer <id> <ask-id> <option-or-text...>` answers what it asked when you know what the user wants. Deleting threads and allowing tool permissions stay the user\'s: tell them. '
      + 'An event turn tells you when a thread on your desk ends a turn, and when any thread of your projects fails or asks the user something; its final answer comes with the event, so never poll. '
      + 'You may start a thread in any other project too: you drive the threads you start, never the others there. '
      + 'Never invent the user\'s approval; keep each thread moving toward a merged, verified result and mark it done (`boite thread done <id>`) once it is.'
      + (away ? ` ${away}` : '');
  }

  // -- facts ------------------------------------------------------------------

  /**
   * A fact for the agent's next event turn (`AgentRuntime.fact`), about the
   * threads it names: `threadIds`, else the ids in its text. It is urgent when
   * one of them is on the desk as started, entrusted or watched.
   */
  notify(agent: AgentProfile, key: string, text: string, delay = NOTICE_BATCH_MS, threadIds?: ThreadId[]): boolean {
    if (this.#closed) return false;
    const urgent = this.#core.agentRuntime.factThreads({ text, threadIds }).some(id => this.urgent(agent.id, id));
    return this.#core.agentRuntime.fact(agent.id, { key, text: trimmed(text, NOTICE_TEXT + 500), delay, threadIds, urgent });
  }

  /**
   * After the owner takes projects back: the follows the agent made through
   * them leave its desk, and waiting facts keep only what they say about
   * threads it may still hear of, so a thread's answer never reaches an agent
   * that lost it. The runtime checks the facts again when it delivers them.
   */
  forget(agent: AgentProfile): void {
    const saved = this.#saved(agent.id);
    const projects = this.projectsOf(agent);
    const threads = this.#threadsOf(Object.keys(saved));
    const kept = Object.fromEntries(Object.entries(saved).filter(([id, follow]) => {
      const thread = threads.get(id);
      // A thread gone or settled leaves by itself a day after; only a lost project takes a follow now.
      return !thread || this.#allowed(agent.id, follow, thread, projects);
    }));
    if (Object.keys(kept).length !== Object.keys(saved).length) this.#write(agent.id, kept);
    this.#core.agentRuntime.filterFacts(agent.id, fact => this.#core.agentRuntime.factThreads(fact).every(id => this.mayHear(agent, id)));
    this.#store.changed();
  }

  #watched(thread: ThreadSummary | null): thread is ThreadSummary {
    return thread !== null && !thread.archived && !thread.agentSessionId && !thread.parentThreadId;
  }

  #noticeTurn(turn: Turn): void {
    if (turn.execution?.operation === 'compact' || turn.execution?.operation === 'keepalive') return;
    if (turn.status === 'queued' || turn.status === 'running') return;
    const thread = this.#core.journal.getThread(turn.threadId);
    if (!this.#watched(thread)) return;
    for (const agent of this.#concerned(thread)) {
      // Threads it follows report every turn; the others only when they fail.
      if (!this.follows(agent.id, thread.id) && turn.status !== 'error') continue;
      const answer = this.#core.delegation.result(turn);
      const pr = thread.pullRequest ? `\nPull request #${thread.pullRequest.number} ${thread.pullRequest.state}: ${quoted(thread.pullRequest.url)}` : '';
      this.notify(agent, `turn:${turn.id}`, `Turn ${turn.status} in thread ${thread.id}, titled ${quoted(thread.title)}.${pr}\n${answer === null ? 'No text answer.' : `Its final answer: ${quoted(trimmed(answer, NOTICE_TEXT))}`}`, NOTICE_BATCH_MS, [thread.id]);
    }
  }

  #noticeQuestion(question: QuestionRequest): void {
    const thread = this.#core.journal.getThread(question.threadId);
    if (!this.#watched(thread)) return;
    const options = question.options.length ? `\nOptions, by id: ${JSON.stringify(Object.fromEntries(question.options.map(option => [option.id, option.label])))}` : '';
    for (const agent of this.#concerned(thread)) {
      this.notify(agent, `ask:${question.id}`, `Thread ${thread.id}, titled ${quoted(thread.title)}, asks the user, ask ${question.id} (still pending when you read this only if boite thread show lists it).\nQuestion: ${quoted(trimmed(question.text, NOTICE_TEXT))}${options}`,
        this.follows(agent.id, thread.id) ? NOTICE_BATCH_MS : QUESTION_GRACE_MS, [thread.id]);
    }
  }

  #noticePermission(request: PermissionRequest): void {
    const thread = this.#core.journal.getThread(request.threadId);
    if (!this.#watched(thread)) return;
    for (const agent of this.#concerned(thread)) {
      if (!this.follows(agent.id, thread.id)) continue;
      this.notify(agent, `permission:${request.id}`, `Thread ${thread.id}, titled ${quoted(thread.title)}, waits on the user's permission for the tool ${quoted(request.toolName)}${request.description ? `, described as ${quoted(trimmed(request.description, 600))}` : ''}. Only the user can allow it.`, QUESTION_GRACE_MS, [thread.id]);
    }
  }

  // -- helpers ----------------------------------------------------------------

  /** The agents a thread's events reach: those its project is entrusted to, and those that follow it. */
  #concerned(thread: ThreadSummary): AgentProfile[] {
    const agents = new Map(this.agentsFor(thread.projectId).map(agent => [agent.id, agent]));
    for (const agent of this.#followers(thread.id)) agents.set(agent.id, agent);
    return [...agents.values()];
  }

  /** Who acted, in a target's timeline: the bot of its project, or the bot that started it elsewhere. */
  #by(agent: AgentProfile, projectIds: readonly ProjectId[], target: ThreadSummary): string {
    return target.projectId !== null && projectIds.includes(target.projectId) ? `${agent.name}, the bot the user entrusted this project to` : `${agent.name}, the bot that started this thread`;
  }

  row(thread: ThreadSummary): ProjectThreadRow {
    const project = thread.projectId === null ? null : this.#core.journal.getProject(thread.projectId);
    return {
      id: thread.id, title: thread.title, projectId: thread.projectId, project: project?.name ?? null,
      status: thread.status, archived: thread.archived, ...(thread.archived && thread.doneAt != null ? { done: true as const } : {}), branch: thread.branch,
      questions: this.#core.threads.listQuestions(thread.id).length,
      permissions: this.#core.threads.listPermissions(thread.id).length,
      pullRequest: thread.pullRequest ?? null,
      updatedAt: thread.updatedAt, lastCompletedAt: this.#core.journal.lastCompletedAt(thread.id),
    };
  }

  /** A system line in the target's timeline, on its last turn, saying what the agent did. */
  #line(threadId: ThreadId, text: string): void {
    const turnId = this.#core.journal.lastTurn(threadId)?.id ?? newId('trn_');
    const part: MessagePart = { type: 'text', text };
    const message: Message = { id: newId('msg_'), threadId, turnId, role: 'system', parts: [part], state: 'complete', createdAt: Date.now() };
    this.#core.journal.append({ type: 'thread.resident', threadId, version: 1, payload: message }, () => this.#core.journal.putMessage(message));
    this.#core.bus.emit('message.started', message);
    this.#core.bus.emit('message.completed', { threadId, messageId: message.id, state: 'complete' });
  }
}

export function registerResidentMethods(core: Core): void {
  const projects = () => core.workforce.projects;
  // `machine`: a thread of another machine of the group, asked of that machine (`group-bots.ts`).
  const group = () => core.workforce.group;
  core.router.register('resident.view', params => projects().view(params.threadId));
  core.router.register('resident.threads', params => params.machine === undefined ? projects().threads(params) : group().threads(params));
  core.router.register('resident.thread', params => params.machine === undefined ? projects().detail(params) : group().detail(params));
  core.router.register('resident.act', params => params.machine === undefined ? projects().act(params) : group().act(params));
  core.router.register('resident.answer', params => params.machine === undefined ? projects().answer(params) : group().answer(params));
  core.router.register('resident.send', params => group().send(params));
}

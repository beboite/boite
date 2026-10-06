import type { AgentEntityKind, AgentsSnapshot, RpcParams, RpcResult, AgentsRpcMethods, AgentHistoryCursor, AgentHistoryKind, AgentRecord, AgentsHistoryPage, AgentConversationMessage, AgentMission, AgentScope, AgentTeam, ThreadSummary } from '@boite/contracts';
import type { Store } from './store.svelte';

export type AgentEntryKind = Extract<AgentEntityKind, 'profile' | 'group' | 'team' | 'mission'>;
export type AgentSelection = { kind: AgentEntryKind; id: string };
/**
 * What the agents page shows: one record, the work waiting on the user, the
 * engine settings, one routine, or the form that plans a new one.
 */
export type AgentFocus = AgentSelection | { kind: 'attention' | 'engine' | 'planning' } | { kind: 'routine'; id: string };
/** The two views of the agents list: the agents, and what they have planned. */
export type RailMode = 'agents' | 'planning';

export type AgentChatKind = 'profile' | 'group' | 'team';
export type AgentChatStatus = 'waiting' | 'running' | 'paused' | 'idle';
/**
 * One row of the chat list, the way a messenger lists its conversations. The
 * core takes messages in a direct conversation or a group only, so a team that
 * names a group folds into that group's row and brings its roles and missions;
 * a team with no group keeps a row of its own, with no conversation yet.
 */
export interface AgentChat {
  kind: AgentChatKind;
  id: string;
  name: string;
  /** The agent's own avatar text; empty for a group. */
  avatar: string;
  /** The agents the avatar draws: the agent itself, or a group's members. */
  members: string[];
  /** Where its messages go; null for a team with no group. */
  scope: AgentScope | null;
  /** The team a group carries. */
  teamId: string | null;
  status: AgentChatStatus;
  last: AgentConversationMessage | null;
  /** The newest activity: a message, a change in its work, or an edit. */
  at: number;
  /** Agent messages newer than the last time this conversation was open. */
  unread: number;
  /** Decisions, interruptions, failures and results waiting on the user. */
  attention: number;
}
type Attention = ReturnType<typeof attentionOf>;

export const chatKey = (kind: AgentChatKind, id: string) => `${kind}:${id}`;

/** The team each group carries: the oldest team naming it as its discussion. */
export function teamsByGroup(snapshot: AgentsSnapshot): Map<string, AgentTeam> {
  const groups = new Set(snapshot.groups.map(g => g.id));
  const byGroup = new Map<string, AgentTeam>();
  for (const team of [...snapshot.teams].sort(byCreation)) if (team.groupId && groups.has(team.groupId) && !byGroup.has(team.groupId)) byGroup.set(team.groupId, team);
  return byGroup;
}

/** The row a mission belongs to: its team's, else its only agent's, else the group holding all its agents, else its first agent's. */
export function missionHome(snapshot: AgentsSnapshot, mission: AgentMission, byGroup = teamsByGroup(snapshot)): string | null {
  if (mission.teamId) {
    for (const [groupId, team] of byGroup) if (team.id === mission.teamId) return chatKey('group', groupId);
    return chatKey('team', mission.teamId);
  }
  const [first] = mission.agentIds;
  if (!first) return null;
  if (mission.agentIds.length === 1) return chatKey('profile', first);
  const group = snapshot.groups.find(g => mission.agentIds.every(id => g.memberIds.includes(id)));
  return group ? chatKey('group', group.id) : chatKey('profile', first);
}

/**
 * The missions a conversation shows: every mission an agent is on, a team's, or
 * for a group its team's and those shared by several of its members alone. A
 * mission with one agent reads as that agent's.
 */
export function missionsOf(snapshot: AgentsSnapshot, chat: Pick<AgentChat, 'kind' | 'id' | 'teamId' | 'members'>): AgentMission[] {
  return snapshot.missions.filter(m =>
    chat.kind === 'profile' ? m.agentIds.includes(chat.id)
    : chat.kind === 'team' ? m.teamId === chat.id
    : chat.teamId && m.teamId === chat.teamId || !m.teamId && m.agentIds.length > 1 && m.agentIds.every(id => chat.members.includes(id)));
}

/** The members, and the team, a mission started from this conversation begins with. */
export function missionPreset(snapshot: AgentsSnapshot, chat: Pick<AgentChat, 'kind' | 'id' | 'teamId' | 'members'>): { memberIds: string[]; teamId: string | null } {
  const teamId = chat.kind === 'team' ? chat.id : chat.teamId;
  const team = teamId ? snapshot.teams.find(t => t.id === teamId) : undefined;
  return { teamId: team?.id ?? null, memberIds: team ? chat.members.filter(id => team.members.some(m => m.agentId === id)) : chat.members };
}

/** Every conversation, most recent activity first. */
export function agentChats(snapshot: AgentsSnapshot, messages: AgentConversationMessage[], readAt: Record<string, number>, attention: Attention): AgentChat[] {
  const byGroup = teamsByGroup(snapshot);
  const folded = new Set([...byGroup.values()].map(t => t.id));
  const chats = new Map<string, AgentChat>();
  const add = (chat: Omit<AgentChat, 'status' | 'last' | 'unread' | 'attention'>) => chats.set(chatKey(chat.kind, chat.id), { ...chat, status: 'idle', last: null, unread: 0, attention: 0 });
  for (const a of snapshot.profiles) if (a.status !== 'archived') add({ kind: 'profile', id: a.id, name: a.name, avatar: a.avatar, members: [a.id], scope: { kind: 'agent', id: a.id }, teamId: null, at: a.updatedAt });
  for (const g of snapshot.groups) add({ kind: 'group', id: g.id, name: g.name, avatar: '', members: g.memberIds, scope: { kind: 'group', id: g.id }, teamId: byGroup.get(g.id)?.id ?? null, at: Math.max(g.updatedAt, byGroup.get(g.id)?.updatedAt ?? 0) });
  for (const t of snapshot.teams) if (!folded.has(t.id)) add({ kind: 'team', id: t.id, name: t.name, avatar: '', members: t.members.map(m => m.agentId), scope: null, teamId: t.id, at: t.updatedAt });

  const missions = new Map(snapshot.missions.map(m => [m.id, missionHome(snapshot, m, byGroup)]));
  const home = (scope: AgentScope): string | null =>
    scope.kind === 'agent' ? chatKey('profile', scope.id)
    : scope.kind === 'group' ? chatKey('group', scope.id)
    : scope.kind === 'mission' ? missions.get(scope.id) ?? null
    : scope.kind === 'team' ? (folded.has(scope.id) ? chatKey('group', snapshot.teams.find(t => t.id === scope.id)!.groupId!) : chatKey('team', scope.id))
    : null;
  const rank: Record<AgentChatStatus, number> = { idle: 0, paused: 1, running: 2, waiting: 3 };
  const raise = (chat: AgentChat | undefined, status: AgentChatStatus) => { if (chat && rank[status] > rank[chat.status]) chat.status = status; };

  for (const a of snapshot.profiles) if (a.status === 'paused') raise(chats.get(chatKey('profile', a.id)), 'paused');
  for (const g of snapshot.groups) if (g.paused || byGroup.get(g.id)?.paused) raise(chats.get(chatKey('group', g.id)), 'paused');
  for (const t of snapshot.teams) if (t.paused && !folded.has(t.id)) raise(chats.get(chatKey('team', t.id)), 'paused');
  for (const w of snapshot.work) {
    const where = home(w.scope), chat = where ? chats.get(where) : undefined;
    if (chat) chat.at = Math.max(chat.at, w.updatedAt);
    if (w.status !== 'running' && w.status !== 'waiting') continue;
    raise(chat, w.status);
    raise(chats.get(chatKey('profile', w.agentId)), w.status);
  }
  for (const m of messages) {
    const where = home(m.scope), chat = where ? chats.get(where) : undefined;
    if (!chat || !chat.scope || m.scope.kind !== chat.scope.kind) continue;
    if (!chat.last || m.createdAt >= chat.last.createdAt) chat.last = m;
    chat.at = Math.max(chat.at, m.createdAt);
    if (m.senderId !== null && m.createdAt > (readAt[where!] ?? 0)) chat.unread++;
  }
  for (const w of attention.work) { const where = home(w.scope); const chat = where ? chats.get(where) : undefined; if (chat) chat.attention++; }
  for (const t of attention.review) { const where = missions.get(t.missionId); const chat = where ? chats.get(where) : undefined; if (chat) chat.attention++; }
  return [...chats.values()].sort((a, b) => b.at - a.at || a.name.localeCompare(b.name));
}

const LIVE: ReadonlySet<ThreadSummary['status']> = new Set(['running', 'queued', 'waiting']);

/**
 * The thread each conversation's agents work in right now, keyed like the
 * chat list: what a row's state and a conversation's live line read, so an
 * agent at work says so the way a thread does. One waiting on the user wins
 * over one running, which wins over one queued.
 */
export function liveThreads(snapshot: AgentsSnapshot, threads: readonly ThreadSummary[]): Map<string, ThreadSummary> {
  const byGroup = teamsByGroup(snapshot);
  const rank = (t: ThreadSummary) => (t.status === 'waiting' ? 0 : t.status === 'running' ? 1 : 2);
  const live = new Map<string, ThreadSummary>();
  const put = (key: string | null, thread: ThreadSummary) => {
    if (!key) return;
    const held = live.get(key);
    if (!held || rank(thread) < rank(held)) live.set(key, thread);
  };
  for (const thread of threads) {
    if (!thread.agentSessionId || !LIVE.has(thread.status) || thread.archived) continue;
    const session = snapshot.sessions.find(s => s.id === thread.agentSessionId);
    if (!session) continue;
    put(chatKey('profile', session.agentId), thread);
    if (session.scope.kind === 'group') put(chatKey('group', session.scope.id), thread);
    if (session.scope.kind === 'mission') {
      const mission = snapshot.missions.find(m => m.id === session.scope.id);
      put(mission ? missionHome(snapshot, mission, byGroup) : null, thread);
    }
  }
  return live;
}

export { avatarText, tintOf } from './robots';

/** A message as a one-line preview: markdown marks out, every run of blanks one space. */
export function previewOf(text: string): string {
  return text.replace(/```[^\n]*\n?/g, ' ').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[`*_~#>|]+/g, '').replace(/\s+/g, ' ').trim();
}

const READ_KEY = 'boite:agents-read:v1';
function readStored(): Record<string, Record<string, number>> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(READ_KEY) ?? '{}');
    return value && typeof value === 'object' ? value as Record<string, Record<string, number>> : {};
  } catch { return {}; }
}
/** The growing records a view shows, and what they point to. */
export type AgentHistory = Omit<AgentsHistoryPage, 'more'>;
type HistoryParams = Omit<RpcParams<'agents.history'>, 'before' | 'threadId' | 'limit'>;

const LISTS = { message: 'messages', work: 'work', memory: 'memories' } as const;
const TERMINAL: ReadonlySet<string> = new Set(['done', 'cancelled']);
const EMPTY: AgentHistory = { messages: [], work: [], memories: [], deliveries: [], runs: [], decisions: [] };
const byCreation = (a: AgentRecord, b: AgentRecord) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Both lists, oldest first; of two copies of a record the later revision wins. */
function merge<T extends AgentRecord>(held: T[], next: T[]): T[] {
  if (!next.length) return held;
  const byId = new Map(held.map(r => [r.id, r]));
  for (const r of next) { const old = byId.get(r.id); if (!old || old.revision <= r.revision) byId.set(r.id, r); }
  return [...byId.values()].sort(byCreation);
}
function absorb(held: AgentHistory, next: AgentHistory): AgentHistory {
  return { messages: merge(held.messages, next.messages), work: merge(held.work, next.work), memories: merge(held.memories, next.memories), deliveries: merge(held.deliveries, next.deliveries), runs: merge(held.runs, next.runs), decisions: merge(held.decisions, next.decisions) };
}
/** The cursor for the page before these records: the oldest by last change. */
export function oldestOf(records: AgentRecord[]): AgentHistoryCursor | null {
  return records.reduce<AgentHistoryCursor | null>((min, r) => !min || r.updatedAt < min.updatedAt || r.updatedAt === min.updatedAt && r.id < min.id ? { updatedAt: r.updatedAt, id: r.id } : min, null);
}

function newestOf(records: AgentRecord[]): AgentHistoryCursor | null {
  return records.reduce<AgentHistoryCursor | null>((max, r) => !max || r.updatedAt > max.updatedAt || r.updatedAt === max.updatedAt && r.id > max.id ? { updatedAt: r.updatedAt, id: r.id } : max, null);
}
const earlier = (a: AgentHistoryCursor, b: AgentHistoryCursor) => a.updatedAt < b.updatedAt || a.updatedAt === b.updatedAt && a.id < b.id;
/**
 * The records a view pages back from. Unfinished work stays in every snapshot at
 * any age, so only finished work marks how far back the loaded history reaches.
 */
export function pagedOf<T extends AgentRecord & { status?: string }>(records: T[]): T[] {
  return records.filter(r => r.status === undefined || TERMINAL.has(r.status));
}

/** Work the user has to act on: a decision, an interruption, a failure, or a result to review. */
export function attentionOf(snapshot: AgentsSnapshot, threads: Store['threads']) {
  const blocked = (runId: string | null) => threads.some(t => t.agentSessionId && t.status === 'waiting' && snapshot.runs.some(r => r.id === runId && r.threadId === t.id));
  return {
    work: snapshot.work.filter(w => ['waiting', 'interrupted', 'error', 'paused'].includes(w.status) || w.status === 'running' && blocked(w.runId)),
    review: snapshot.tasks.filter(t => t.status === 'review')
  };
}

/** One view controller per owning Store. No renderer owns an execution. */
export class AgentsView {
  snapshot = $state.raw<AgentsSnapshot | null>(null);
  /**
   * Every message, work item and memory a snapshot or a page brought since this
   * client connected. A snapshot holds only the newest records, so a record
   * that leaves its window stays here and a view never shows a gap.
   */
  seen = $state.raw<AgentHistory>(EMPTY);
  error = $state('');
  loadError = $state('');
  pending = $state(false);
  /**
   * When each conversation was last read on this device, per core, kept in
   * `localStorage`: what the chat list counts its unread messages from.
   */
  readAt = $state.raw<Record<string, number>>({});
  private readCore: string | null = null;
  /** The view key whose older page is loading. */
  loadingOlder = $state<string | null>(null);
  /** Per view key, whether a page said older records remain. Missing means the snapshot's flag for the kind. */
  private older = $state.raw<Record<string, boolean>>({});
  private tried = new Set<string>();
  /** The history kind each view key pages, so a reset forgets the keys of its kind. */
  private kinds = new Map<string, AgentHistoryKind>();
  /** Bumped when a kind's history resets; a page requested before it is dropped. */
  private generation: Record<AgentHistoryKind, number> = { message: 0, work: 0, memory: 0 };
  private disposed = false;
  private dirty = false;
  private loading: Promise<void> | null = null;
  private client: Store['client'] = null;
  private off: (() => void) | null = null;
  constructor(readonly store: Store) {}
  start(): void {
    void this.refresh();
  }
  refresh(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.client !== this.store.client) {
      this.off?.();
      this.client = this.store.client;
      this.seen = EMPTY; this.older = {}; this.tried.clear(); this.kinds.clear();
      for (const kind of Object.keys(this.generation) as AgentHistoryKind[]) this.generation[kind]++;
      this.off = this.client?.on('agents.changed', () => { void this.refresh(); }) ?? null;
    }
    this.dirty = true;
    if (!this.loading) this.loading = this.load().finally(() => { this.loading = null; });
    return this.loading;
  }
  private async load(): Promise<void> {
    try {
      while (this.dirty && !this.disposed) {
        this.dirty = false;
        const client = this.client;
        const snapshot = await client?.call('agents.snapshot', {});
        if (snapshot && !this.disposed && client === this.store.client) { this.accept(snapshot); this.loadError = ''; }
      }
    } catch (error) { if (!this.disposed) this.loadError = String(error instanceof Error ? error.message : error); }
  }
  /**
   * More records than a window holds can arrive between two snapshots. The new
   * window then no longer touches what was kept, and paging back from the
   * oldest kept record would skip the records in between. That kind restarts
   * from the new window instead, and pages already in flight are dropped.
   */
  private accept(snapshot: AgentsSnapshot): void {
    const previous = this.snapshot;
    let seen = this.seen;
    for (const kind of Object.keys(LISTS) as AgentHistoryKind[]) {
      const list = LISTS[kind];
      const newest = previous ? newestOf(previous[list]) : null;
      const oldest = oldestOf(pagedOf<AgentRecord & { status?: string }>(snapshot[list]));
      if (!snapshot.more[kind] || !newest || !oldest || !earlier(newest, oldest)) continue;
      seen = { ...seen, [list]: [] };
      this.generation[kind]++;
      const older = { ...this.older };
      for (const [key, of] of this.kinds) if (of === kind) { delete older[key]; this.tried.delete(key); }
      this.older = older;
    }
    this.readMarks();
    this.snapshot = snapshot;
    this.seen = absorb(seen, snapshot);
  }
  /** The read marks of the core this view shows, loaded once per core. */
  private readMarks(): Record<string, number> {
    const core = this.store.core?.dataDir ?? '';
    if (this.readCore !== core) { this.readCore = core; this.readAt = readStored()[core] ?? {}; }
    return this.readAt;
  }
  /** Marks a conversation read up to `at`, the newest message it shows. */
  markRead(key: string, at: number): void {
    const marks = this.readMarks();
    if ((marks[key] ?? 0) >= at) return;
    this.readAt = { ...marks, [key]: at };
    try { localStorage.setItem(READ_KEY, JSON.stringify({ ...readStored(), [this.readCore ?? '']: this.readAt })); } catch { /* the count stays for this session */ }
  }
  hasOlder(key: string, kind: AgentHistoryKind): boolean {
    return this.older[key] ?? this.snapshot?.more[kind] ?? false;
  }
  /** Loads the page before `held`, the records the view already shows for `key`. */
  async loadOlder(key: string, params: HistoryParams, held: AgentRecord[]): Promise<void> {
    const client = this.client;
    if (this.loadingOlder || this.disposed || !client) return;
    this.loadingOlder = key;
    this.kinds.set(key, params.kind);
    const generation = this.generation[params.kind];
    try {
      const before = oldestOf(pagedOf<AgentRecord & { status?: string }>(held));
      const page = await client.call('agents.history', { ...params, ...(before ? { before } : {}) });
      if (this.disposed || client !== this.store.client || generation !== this.generation[params.kind]) return;
      this.seen = absorb(this.seen, page);
      this.older = { ...this.older, [key]: page.more };
    } catch (error) { if (!this.disposed) this.error = error instanceof Error ? error.message : String(error); }
    finally { this.loadingOlder = null; }
  }
  /** Fills a view that shows fewer than `enough` records once, when older ones exist. A failure is not retried. */
  fill(key: string, params: HistoryParams, held: AgentRecord[], enough = 20): void {
    this.kinds.set(key, params.kind);
    if (pagedOf<AgentRecord & { status?: string }>(held).length >= enough || this.tried.has(key) || this.loadingOlder || !this.hasOlder(key, params.kind)) return;
    this.tried.add(key);
    void this.loadOlder(key, params, held);
  }
  async call<M extends keyof AgentsRpcMethods>(method: M, params: RpcParams<M>): Promise<RpcResult<M> | null> {
    if (this.pending || this.disposed) return null;
    this.pending = true; this.error = '';
    try {
      if (!this.store.client) throw new Error('Not connected');
      const result = await this.store.client.call(method, $state.snapshot(params) as RpcParams<M>);
      await this.refresh();
      return result;
    } catch (error) { this.error = error instanceof Error ? error.message : String(error); return null; }
    finally { this.pending = false; }
  }
  close(): void { this.disposed = true; this.off?.(); }
}

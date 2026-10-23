import { errorText } from './errors';
import { RpcErrorCode, type AgentProfile, type AgentStatus, type AgentsSnapshot, type RpcParams, type RpcResult, type AgentsRpcMethods, type ThreadSummary } from '@boite/contracts';
import { RpcFailure } from './rpc-error';
import type { Store } from './store.svelte';
import { strings } from './strings';
import { experimentOn } from './experiments.svelte';
import { noteUpkeep } from './agent-upkeep';
import { agentDirectory } from './agent-directory.svelte';

/**
 * A persistent agent is a thread with an identity: its conversation is its
 * own thread, opened in the ordinary chat view. What this module adds is the
 * agents snapshot of each machine (profiles, status, routines, desks) and the
 * way from an agent to its thread.
 */

/** What the agents page draws in its card when no agent thread is open: a form, or the engine settings. */
export type AgentFocus = { kind: 'new' } | { kind: 'engine' };

/** One row of the agents list: the agent, how it stands, and when it last did something the user would see. */
export interface AgentRowData {
  profile: AgentProfile;
  status: AgentStatus | null;
  /** The newest of its last answer and its last change: what the list sorts by. */
  at: number;
}

/** How an agent stands, from its snapshot's status, or idle when an older core sent none. */
export function statusOf(snapshot: AgentsSnapshot | null, agentId: string): AgentStatus | null {
  return snapshot?.status?.find(s => s.agentId === agentId) ?? null;
}

/** The agent whose own thread this is. */
export function agentOfThread(snapshot: AgentsSnapshot | null, threadId: string | null | undefined): AgentProfile | null {
  if (!snapshot || !threadId) return null;
  const agentId = snapshot.sessions.find(s => s.threadId === threadId)?.agentId ?? snapshot.status?.find(s => s.threadId === threadId)?.agentId;
  return agentId ? snapshot.profiles.find(a => a.id === agentId) ?? null : null;
}

/** The thread an agent talks in, once the core made it. */
export function threadOfAgent(snapshot: AgentsSnapshot | null, agentId: string): string | null {
  return snapshot?.sessions.find(s => s.agentId === agentId)?.threadId ?? statusOf(snapshot, agentId)?.threadId ?? null;
}

/** Every agent not archived, the one that spoke last first, the way a messenger lists its chats. */
export function agentRows(snapshot: AgentsSnapshot | null): AgentRowData[] {
  if (!snapshot) return [];
  return snapshot.profiles.filter(a => a.status !== 'archived').map(profile => {
    const status = statusOf(snapshot, profile.id);
    return { profile, status, at: Math.max(status?.last?.at ?? 0, profile.createdAt) };
  }).sort((a, b) => b.at - a.at || a.profile.name.localeCompare(b.profile.name));
}

/** The robot's face for a state: it squishes while it works and hops while it waits on the user. */
export function faceOf(state: AgentStatus['state'] | undefined): 'running' | 'waiting' | 'idle' {
  return state === 'working' || state === 'queued' ? 'running' : state === 'waiting' ? 'waiting' : 'idle';
}

/**
 * What the agent is doing this second, in a few words: the step its running
 * turn is on, read from its thread's row when this client follows it (live),
 * else from the snapshot.
 */
export function liveStep(status: AgentStatus | null, thread: ThreadSummary | null | undefined): string | null {
  const progress = thread?.progress;
  if (thread?.status === 'running' && progress?.phase === 'tool' && progress.detail) return progress.detail;
  return status?.activity ?? null;
}

/** What the agent's thread waits on: the question it asked, else the permission it needs. */
export function waitingOn(store: Pick<Store, 'pendingQuestions' | 'pendingPermissions'>, threadId: string | null | undefined): string | null {
  if (!threadId) return null;
  const question = store.pendingQuestions.find(q => q.threadId === threadId);
  if (question) return question.text.split('\n')[0]!.trim();
  const permission = store.pendingPermissions.find(p => p.threadId === threadId);
  return permission ? permission.description ?? permission.toolName : null;
}

/**
 * How the agent stands this second, for its header and its desk. Its
 * thread's own row wins over the snapshot: it moves with every event, the
 * snapshot at most once a second.
 */
export function liveState(agent: Pick<AgentProfile, 'status'>, status: AgentStatus | null, thread: Pick<ThreadSummary, 'status'> | null | undefined, waiting: boolean): AgentStatus['state'] {
  if (agent.status === 'archived') return 'archived';
  if (thread?.status === 'running') return 'working';
  if (thread?.status === 'queued') return 'queued';
  if (thread?.status === 'waiting' || waiting) return 'waiting';
  if (status?.state === 'error' || status?.problem) return 'error';
  if (agent.status === 'paused') return 'paused';
  return status?.state === 'working' || status?.state === 'queued' || status?.state === 'waiting' ? status.state : 'idle';
}

/** The newest `openAgent` per machine: an older answer arriving after it opens nothing. */
const agentOpens = new WeakMap<Store, number>();

/**
 * Opens an agent's thread on the machine that owns it: the core hands the
 * thread (making it again if it was lost), and the store opens it the usual
 * way, which lands on the Agents page. A newer open, another thread or
 * another page asked meanwhile wins over it.
 */
export async function openAgent(store: Store, agentId: string): Promise<string | null> {
  const client = store.client;
  if (!client) return null;
  const request = (agentOpens.get(store) ?? 0) + 1;
  agentOpens.set(store, request);
  const navigation = store.navigationGeneration;
  const known = threadOfAgent(AgentsView.of(store).snapshot, agentId);
  let threadId = known;
  try {
    threadId = (await client.call('agents.open', { agentId })).threadId;
  } catch (error) {
    // An older core without `agents.open` still lists the thread in its sessions; any other refusal is the answer.
    if (!known || !(error instanceof RpcFailure && error.code === RpcErrorCode.MethodNotFound)) { store.error = errorText(error); return null; }
  }
  if (!threadId || store.client !== client || agentOpens.get(store) !== request || store.navigationGeneration !== navigation) return null;
  lastAgent.set(store, agentId);
  await store.open(threadId);
  return threadId;
}

const DESK_SEEN_KEY = 'boite:agent-desk-seen';
/**
 * Whether this is the first time this device shows the agent: its desk opens
 * by itself then, once, on a wide window. Remembered per agent in
 * `localStorage`, the newest 200.
 */
export function firstDeskVisit(agentId: string): boolean {
  let seen: string[] = [];
  try { const stored = JSON.parse(localStorage.getItem(DESK_SEEN_KEY) ?? '[]'); if (Array.isArray(stored)) seen = stored.filter((id): id is string => typeof id === 'string'); } catch { /* A damaged list starts over. */ }
  if (seen.includes(agentId)) return false;
  try { localStorage.setItem(DESK_SEEN_KEY, JSON.stringify([...seen, agentId].slice(-200))); } catch { /* Storage full or off: the desk opens again next time. */ }
  return true;
}

/** The agent each machine last showed, reopened when the user comes back to the Agents page. */
const lastAgent = new WeakMap<Store, string>();
export function lastOpenedAgent(store: Store): string | null { return lastAgent.get(store) ?? null; }
export function rememberAgent(store: Store, agentId: string): void { lastAgent.set(store, agentId); }

/** Whether a thread is a persistent agent's own, drawn on the Agents page. */
export function isAgentThread(thread: Pick<ThreadSummary, 'agentSessionId'> | null | undefined): boolean {
  return !!thread?.agentSessionId && experimentOn('resident-agents');
}

/**
 * The machine the agents list is narrowed to, null for every machine. It lives
 * outside the page, which is drawn again for each machine it opens on.
 */
export const agentsFilter = $state<{ machine: string | null }>({ machine: null });

export { avatarText, tintOf } from './robots';

/** A message as a one-line preview: markdown marks out, every run of blanks one space. */
export function previewOf(text: string): string {
  return text.replace(/```[^\n]*\n?/g, ' ').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[`*_~#>|]+/g, '').replace(/\s+/g, ' ').trim();
}

const VIEWS = new WeakMap<Store, AgentsView>();

/**
 * One snapshot of a machine's agents per Store, kept between visits. It
 * carries one desk at most: the open agent's (`showDesk`), none otherwise,
 * since every desk of every agent is most of a full snapshot's bytes. On
 * screen it also feeds the machine's directory, which then fetches nothing.
 */
export class AgentsView {
  snapshot = $state.raw<AgentsSnapshot | null>(null);
  error = $state('');
  loadError = $state('');
  pending = $state(false);
  private disposed = false;
  private dirty = false;
  private loading: Promise<void> | null = null;
  private client: Store['client'] = null;
  private off: (() => void) | null = null;
  /** Users on screen: changes refresh the snapshot. Off screen the last one is kept for the next visit. */
  private users = 0;
  /** The agent whose desk the snapshot carries, null for none. */
  private desk: string | null = null;
  constructor(readonly store: Store) {}
  /**
   * The view of this store, kept between visits: the page draws the last
   * snapshot at once and refreshes it, instead of starting from "loading".
   */
  static of(store: Store): AgentsView {
    let view = VIEWS.get(store);
    // A closed view never loads again: the next visit gets a fresh one.
    if (view?.disposed) view = undefined;
    if (!view) { view = new AgentsView(store); VIEWS.set(store, view); }
    return view;
  }
  start(): void {
    this.users++;
    // A failure of an earlier visit is not news on this one.
    if (this.users === 1) { this.error = ''; this.loadError = ''; agentDirectory(this.store).feed(true); }
    this.listen();
    void this.refresh();
  }
  /** Off screen: no snapshot is fetched for changes nobody sees. */
  pause(): void {
    if (this.users === 0) return;
    this.users -= 1;
    if (this.users > 0) return;
    this.off?.(); this.off = null;
    agentDirectory(this.store).feed(false);
  }
  /** The agent whose desk is on screen, or null: a change reads the snapshot again with that desk only. */
  showDesk(agentId: string | null): void {
    if (this.desk === agentId) return;
    this.desk = agentId;
    if (this.users > 0) void this.refresh();
  }
  private listen(): void {
    if (this.off || this.users === 0) return;
    this.off = this.client?.on('agents.changed', () => { void this.refresh(); }) ?? null;
  }
  refresh(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.client !== this.store.client) {
      this.off?.(); this.off = null;
      this.client = this.store.client;
      this.listen();
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
        const snapshot = await client?.call('agents.snapshot', { desk: this.desk });
        if (snapshot && !this.disposed && client === this.store.client) {
          this.snapshot = snapshot; this.loadError = ''; noteUpkeep(this.store, snapshot);
          agentDirectory(this.store).adopt(snapshot, client);
        }
      }
    } catch (error) { if (!this.disposed) this.loadError = errorText(error); }
  }
  async call<M extends keyof AgentsRpcMethods>(method: M, params: RpcParams<M>): Promise<RpcResult<M> | null> {
    if (this.pending || this.disposed) return null;
    this.pending = true; this.error = '';
    try {
      if (!this.store.client) throw new Error(strings.connection.unavailable);
      const result = await this.store.client.call(method, $state.snapshot(params) as RpcParams<M>);
      await this.refresh();
      return result;
    } catch (error) { this.error = errorText(error); return null; }
    finally { this.pending = false; }
  }
  private saves: Promise<unknown> = Promise.resolve();
  /**
   * A settings card's save. Unlike `call`, it is never dropped while another
   * call is pending and it throws when refused. Saves run one at a time, each
   * building its params when its turn comes, after the snapshot the previous
   * save refreshed: two cards of one agent never send the same revision.
   * Building them may read the core first; a refusal there fails the save.
   */
  save<M extends keyof AgentsRpcMethods>(method: M, params: () => RpcParams<M> | Promise<RpcParams<M>>): Promise<RpcResult<M>> {
    const run = this.saves.then(async () => {
      const client = this.store.client;
      if (!client || this.disposed) throw new Error(strings.connection.unavailable);
      const result = await client.call(method, $state.snapshot(await params()) as RpcParams<M>);
      await this.refresh();
      return result;
    });
    this.saves = run.catch(() => undefined);
    return run;
  }
  close(): void { if (this.users > 0) { this.users = 1; this.pause(); } this.disposed = true; }
}

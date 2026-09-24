import type { AgentEntityKind, AgentsSnapshot, RpcParams, RpcResult, AgentsRpcMethods, AgentHistoryCursor, AgentHistoryKind, AgentRecord, AgentsHistoryPage } from '@boite/contracts';
import type { Store } from './store.svelte';

export type AgentEntryKind = Extract<AgentEntityKind, 'profile' | 'group' | 'team' | 'mission'>;
export type AgentSelection = { kind: AgentEntryKind; id: string };
/** What the agents page shows: one record, the work waiting on the user, or the engine settings. */
export type AgentFocus = AgentSelection | { kind: 'attention' | 'engine' };
/** The growing records a view shows, and what they point to. */
export type AgentHistory = Omit<AgentsHistoryPage, 'more'>;
type HistoryParams = Omit<RpcParams<'agents.history'>, 'before' | 'threadId' | 'limit'>;

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
  /** The view key whose older page is loading. */
  loadingOlder = $state<string | null>(null);
  /** Per view key, whether a page said older records remain. Missing means the snapshot's flag for the kind. */
  private older = $state.raw<Record<string, boolean>>({});
  private tried = new Set<string>();
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
      this.seen = EMPTY; this.older = {}; this.tried.clear();
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
        if (snapshot && !this.disposed && client === this.store.client) { this.snapshot = snapshot; this.seen = absorb(this.seen, snapshot); this.loadError = ''; }
      }
    } catch (error) { if (!this.disposed) this.loadError = String(error instanceof Error ? error.message : error); }
  }
  hasOlder(key: string, kind: AgentHistoryKind): boolean {
    return this.older[key] ?? this.snapshot?.more[kind] ?? false;
  }
  /** Loads the page before `held`, the records the view already shows for `key`. */
  async loadOlder(key: string, params: HistoryParams, held: AgentRecord[]): Promise<void> {
    const client = this.client;
    if (this.loadingOlder || this.disposed || !client) return;
    this.loadingOlder = key;
    try {
      const before = oldestOf(held);
      const page = await client.call('agents.history', { ...params, ...(before ? { before } : {}) });
      if (this.disposed || client !== this.store.client) return;
      this.seen = absorb(this.seen, page);
      this.older = { ...this.older, [key]: page.more };
    } catch (error) { if (!this.disposed) this.error = error instanceof Error ? error.message : String(error); }
    finally { this.loadingOlder = null; }
  }
  /** Fills a view that shows fewer than `enough` records once, when older ones exist. A failure is not retried. */
  fill(key: string, params: HistoryParams, held: AgentRecord[], enough = 20): void {
    if (held.length >= enough || this.tried.has(key) || this.loadingOlder || !this.hasOlder(key, params.kind)) return;
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

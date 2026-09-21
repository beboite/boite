import type { AgentEntityKind, AgentsSnapshot, RpcParams, RpcResult, AgentsRpcMethods } from '@boite/contracts';
import type { Store } from './store.svelte';

export type AgentEntryKind = Extract<AgentEntityKind, 'profile' | 'group' | 'team' | 'mission'>;
export type AgentSelection = { kind: AgentEntryKind; id: string };

/** One view controller per owning Store. No renderer owns an execution. */
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
  constructor(readonly store: Store) {}
  start(): void {
    void this.refresh();
  }
  refresh(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.client !== this.store.client) {
      this.off?.();
      this.client = this.store.client;
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
        if (snapshot && !this.disposed && client === this.store.client) { this.snapshot = snapshot; this.loadError = ''; }
      }
    } catch (error) { if (!this.disposed) this.loadError = String(error instanceof Error ? error.message : error); }
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

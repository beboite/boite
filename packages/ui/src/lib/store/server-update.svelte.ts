import { RpcErrorCode, type ServerUpdateStatus } from '@boite/contracts';
import { RpcFailure } from '../client';
import { confirm } from '../confirm.svelte';
import { fill, strings } from '../strings';
import type { StoreContext } from './context';

/** Requests stay with the machine whose card was clicked, even while the active machine changes. */
export class ServerUpdater {
  snapshot = $state.raw<ServerUpdateStatus | null>(null);
  legacy = $state(false);
  busy = $state(false);
  preparing = $state(false);
  error = $state<string | null>(null);
  private generation = 0;

  constructor(private readonly ctx: StoreContext) {}
  get offered(): boolean { return !!this.snapshot?.version && ['available', 'downloading', 'waiting', 'installing', 'error'].includes(this.snapshot.phase); }
  apply(snapshot: ServerUpdateStatus): void { this.generation++; this.snapshot = snapshot; this.error = null; }
  reset(): void { this.generation++; this.snapshot = null; this.legacy = false; this.busy = false; this.preparing = false; this.error = null; }

  async load(refresh = false): Promise<void> {
    const client = this.ctx.client;
    if (!client || !this.ctx.store.owner || this.busy) return;
    const generation = ++this.generation;
    this.busy = true;
    this.error = null;
    try {
      const state = await client.call('core.updateStatus', { refresh });
      if (client === this.ctx.client && generation === this.generation) this.snapshot = state;
    } catch (error) {
      if (client !== this.ctx.client || generation !== this.generation) return;
      if (error instanceof RpcFailure && error.code === RpcErrorCode.MethodNotFound) this.legacy = true;
      else this.error = this.ctx.reason(error);
    } finally { if (client === this.ctx.client) this.busy = false; }
  }

  async install(machine: string): Promise<void> {
    const client = this.ctx.client;
    const state = this.snapshot;
    if (!client || !state?.version || state.mode !== 'systemd' || this.preparing || this.busy
      || !['available', 'error'].includes(state.phase)) return;
    this.preparing = true;
    try {
      const accepted = await confirm.ask({ title: fill(strings.serverUpdate.confirmTitle, { machine }),
        body: fill(strings.serverUpdate.confirmBody, { version: state.version }), confirmLabel: strings.appUpdate.install,
        cancelLabel: strings.common.cancel });
      if (!accepted || client !== this.ctx.client || state.version !== this.snapshot?.version
        || !['available', 'error'].includes(this.snapshot.phase)) return;
      const generation = ++this.generation;
      this.busy = true;
      const answer = await client.call('core.updateInstall', { version: state.version });
      if (client === this.ctx.client && generation === this.generation) this.snapshot = answer;
    } catch (error) { if (client === this.ctx.client) this.error = this.ctx.reason(error); }
    finally { this.preparing = false; if (client === this.ctx.client) this.busy = false; }
  }
  async cancel(): Promise<void> {
    const client = this.ctx.client;
    if (!client || this.busy) return;
    const generation = ++this.generation;
    this.busy = true;
    try {
      const answer = await client.call('core.updateCancel', {});
      if (client === this.ctx.client && generation === this.generation) this.snapshot = answer;
    } catch (error) { if (client === this.ctx.client) this.error = this.ctx.reason(error); }
    finally { if (client === this.ctx.client) this.busy = false; }
  }
}

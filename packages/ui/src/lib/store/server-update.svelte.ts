import { RpcErrorCode, type ProviderId, type ServerUpdateStatus, type UpdateEverythingResult } from '@boite/contracts';
import { RpcFailure } from '../client';
import { confirm } from '../confirm.svelte';
import { fill, strings } from '../strings';
import type { StoreContext } from './context';

/** What one machine started for an update-everything click; its progress arrives as events. */
export type EverythingStarted = Pick<UpdateEverythingResult, 'agents' | 'failed' | 'serverError'>;

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
  /**
   * Everything this machine updates in one request: the agents named and
   * Boite's own release when `server` is its offered version. The core runs
   * them in order, so nothing here waits for them. A core from before that
   * request gets the same updates one call each, without its ordering.
   */
  async everything(agents: ProviderId[], server: string | null): Promise<EverythingStarted | null> {
    const client = this.ctx.client;
    if (!client || !this.ctx.store.owner || (agents.length === 0 && server === null)) return null;
    const generation = ++this.generation;
    try {
      const answer = await client.call('core.updateEverything', { agents, server });
      // The computer the desktop app runs on updates through the app, not this card.
      if (client === this.ctx.client && generation === this.generation && !this.ctx.store.localCore) this.snapshot = answer.server;
      for (const entry of answer.failed) console.warn(`updating ${entry.providerId} did not start: ${entry.message}`);
      if (client === this.ctx.client && answer.serverError) this.error = answer.serverError;
      return answer;
    } catch (error) {
      if (!(error instanceof RpcFailure && error.code === RpcErrorCode.MethodNotFound)) {
        if (client === this.ctx.client) this.error = this.ctx.reason(error);
        return null;
      }
    }
    // An older core: one call per update, all at once.
    const failed: UpdateEverythingResult['failed'] = [];
    const started: ProviderId[] = [];
    let serverError: string | null = null;
    await Promise.all([
      ...agents.map(async (providerId) => {
        try {
          const update = await client.call('providers.update', { providerId });
          started.push(providerId);
          if (client === this.ctx.client) this.ctx.accounts.putHarnessUpdate(update);
        } catch (error) { failed.push({ providerId, message: this.ctx.reason(error) }); }
      }),
      ...(server === null ? [] : [client.call('core.updateInstall', { version: server }).then((answer) => {
        if (client === this.ctx.client && generation === this.generation) this.snapshot = answer;
      }, (error: unknown) => { serverError = this.ctx.reason(error); })])
    ]);
    if (client === this.ctx.client && serverError) this.error = serverError;
    return { agents: started, failed, serverError };
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

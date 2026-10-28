import { RpcErrorCode, type DesktopUpdateStatus, type ProviderId, type ServerUpdateStatus, type UpdateEverythingResult } from '@boite/contracts';
import { RpcFailure } from '../client';
import { confirm } from '../confirm.svelte';
import { fill, strings } from '../strings';
import { updateStale } from '../update-freshness';
import type { StoreContext } from './context';

/** What one machine started for an update-everything click; its progress arrives as events. */
export type EverythingStarted = Pick<UpdateEverythingResult, 'agents' | 'failed' | 'serverError' | 'appError'>;

/** Requests stay with the machine whose card was clicked, even while the active machine changes. */
export class ServerUpdater {
  snapshot = $state.raw<ServerUpdateStatus | null>(null);
  legacy = $state(false);
  busy = $state(false);
  preparing = $state(false);
  error = $state<string | null>(null);
  /**
   * The desktop app on that machine, as its own window reports it to its
   * core: null when no window is open there, or the core predates the report.
   */
  desktop = $state.raw<DesktopUpdateStatus | null>(null);
  /** The release last asked of that machine's desktop app and why it did not reach its window. */
  desktopFailure = $state.raw<{ version: string; message: string } | null>(null);
  /** The release handed to that machine's core, waiting there for its agents before its window installs it. */
  desktopRequested = $state<string | null>(null);
  private generation = 0;
  private desktopGeneration = 0;

  constructor(private readonly ctx: StoreContext) {}
  get offered(): boolean { return !!this.snapshot?.version && ['available', 'downloading', 'waiting', 'installing', 'error'].includes(this.snapshot.phase); }
  apply(snapshot: ServerUpdateStatus): void { this.generation++; this.snapshot = snapshot; this.error = null; }
  reset(): void {
    this.generation++; this.snapshot = null; this.legacy = false; this.busy = false; this.preparing = false; this.error = null;
    this.desktopGeneration++; this.desktop = null; this.desktopFailure = null; this.desktopRequested = null;
  }
  /** The core reports its desktop app's updater; older cores do not. */
  get desktopSupported(): boolean { return this.ctx.store.core?.features?.desktopUpdates === true; }
  applyDesktop(status: DesktopUpdateStatus | null): void {
    this.desktopGeneration++;
    this.desktop = status;
    // The window took the release after all, or now offers another one.
    if (status && (['downloading', 'waiting', 'installing'].includes(status.phase) || status.version !== this.desktopFailure?.version)) this.desktopFailure = null;
    if (!status || ['downloading', 'waiting', 'installing'].includes(status.phase) || status.version !== this.desktopRequested) this.desktopRequested = null;
  }

  /** Reads that machine's desktop app as its window last reported it. */
  async loadDesktop(): Promise<void> {
    const client = this.ctx.client;
    if (!client || !this.ctx.store.owner || this.ctx.store.localCore || !this.desktopSupported) return;
    const generation = ++this.desktopGeneration;
    try {
      const status = await client.call('core.desktopUpdateStatus', {});
      if (client === this.ctx.client && generation === this.desktopGeneration) this.desktop = status;
    } catch (error) {
      if (client === this.ctx.client && generation === this.desktopGeneration) this.error = this.ctx.reason(error);
    }
  }

  /**
   * Asks that machine to install its desktop app's offered release, after a
   * confirmation here: nobody may be at that machine to agree, and Boite
   * restarts there.
   */
  async installDesktop(machine: string): Promise<void> {
    const state = this.desktop;
    if (!state?.version || this.preparing || !['available', 'ready', 'error'].includes(state.phase)) return;
    this.preparing = true;
    try {
      const accepted = await confirm.ask({ title: fill(strings.desktopUpdate.confirmTitle, { machine }),
        body: fill(strings.desktopUpdate.confirmBody, { version: state.version, machine }), confirmLabel: strings.appUpdate.install,
        cancelLabel: strings.common.cancel });
      if (!accepted || state.version !== this.desktop?.version) return;
      await this.everything([], null, state.version);
    } finally { this.preparing = false; }
  }

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

  /**
   * Reads that machine's Boite, then checks it again when its core's own
   * reading is stale. A core checks every six hours from its start, so its
   * cached answer can say up to date about a release published since.
   */
  async freshen(now = Date.now()): Promise<void> {
    if (this.snapshot === null && !this.legacy) await this.load();
    const state = this.snapshot;
    // Only an installation the core can update checks at all; a download or a failure stays shown as it is.
    if (state?.mode === 'systemd' && ['idle', 'current'].includes(state.phase) && updateStale(state.checkedAt, now)) await this.load(true);
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
   * them in order, so nothing here waits for them. `app` is the version of
   * the desktop app that machine's window offers, handed to that window once
   * its agents are done. A core from before that request gets the same
   * updates one call each, without its ordering.
   */
  async everything(agents: ProviderId[], server: string | null, app: string | null = null): Promise<EverythingStarted | null> {
    const client = this.ctx.client;
    // A core that does not report its desktop app cannot be asked to install it.
    if (app !== null && !this.desktopSupported) app = null;
    if (!client || !this.ctx.store.owner || (agents.length === 0 && server === null && app === null)) return null;
    const generation = ++this.generation;
    try {
      const answer = await client.call('core.updateEverything', app === null ? { agents, server } : { agents, server, app });
      if (client === this.ctx.client && app !== null) {
        if (answer.app !== undefined) this.applyDesktop(answer.app);
        this.desktopFailure = answer.appError ? { version: app, message: answer.appError } : null;
        // Not under way yet: the core waits for the agents there before the window installs.
        if (!answer.appError && !['downloading', 'waiting', 'installing'].includes(this.desktop?.phase ?? '')) this.desktopRequested = app;
      }
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

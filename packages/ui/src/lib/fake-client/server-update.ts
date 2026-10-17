import { RpcErrorCode, type DesktopUpdateStatus, type ProviderId, type ServerUpdateStatus } from '@boite/contracts';
import { RpcFailure } from '../client';
import type { FakeContext, FakeMethods } from './context';
import { updateHarness } from './provider-installs';

export function initialServerUpdate(): ServerUpdateStatus {
  const query = new URLSearchParams(typeof location === 'undefined' ? '' : location.search);
  const phase = query.get('serverUpdate');
  const offered = phase !== null && ['available', 'downloading', 'waiting', 'installing', 'error'].includes(phase);
  return { mode: 'systemd', currentVersion: '2.0.0-beta.1', channel: 'stable',
    phase: offered ? phase as ServerUpdateStatus['phase'] : 'current', version: offered ? '2.0.0-beta.2' : null,
    publishedAt: offered ? '2026-10-01T03:23:00Z' : null, checkedAt: Date.now(),
    received: phase === 'downloading' ? 24_000_000 : 0, total: phase === 'downloading' ? 60_000_000 : null,
    error: phase === 'error' ? 'Update download could not reach the release server.' : null };
}

/** The desktop app's offer a desktop machine's window reports, from `?desktopUpdate=<phase>`. */
export function initialDesktopUpdate(): DesktopUpdateStatus {
  const query = new URLSearchParams(typeof location === 'undefined' ? '' : location.search);
  const asked = query.get('desktopUpdate') as DesktopUpdateStatus['phase'] | null;
  const phase = asked !== null && ['available', 'downloading', 'ready', 'waiting', 'installing', 'error', 'current'].includes(asked) ? asked : 'current';
  const offered = phase !== 'current';
  return { phase, currentVersion: '2.0.0-beta.1', version: offered ? '2.0.0-beta.2' : null, channel: 'stable',
    received: phase === 'downloading' ? 41_000_000 : 0, total: phase === 'downloading' ? 96_000_000 : null,
    error: phase === 'error' ? 'The release server did not answer.' : null };
}

export function serverUpdateMethods(ctx: FakeContext): Pick<FakeMethods, 'core.updateStatus' | 'core.updateInstall' | 'core.updateCancel' | 'core.updateEverything' | 'core.desktopUpdateReport' | 'core.desktopUpdateStatus'> {
  const moveDesktop = (patch: Partial<DesktopUpdateStatus>) => {
    if (!ctx.desktopUpdate) return;
    ctx.desktopUpdate = { ...ctx.desktopUpdate, ...patch };
    ctx.emit('core.desktopUpdateChanged', { status: structuredClone(ctx.desktopUpdate) });
  };
  /** The window there downloads, installs and comes back on the new version, as the real shell does. */
  const installDesktop = (version: string, agents: readonly ProviderId[]): string | null => {
    const desktop = ctx.desktopUpdate;
    if (!desktop) return `Boite is not open on ${ctx.identity.name}`;
    if (['waiting', 'installing'].includes(desktop.phase) && desktop.version === version) return null;
    if (desktop.version !== version) return `The desktop app on ${ctx.identity.name} offers ${desktop.version ?? 'no release'}, not ${version}`;
    // As the real core: the window hears of it once the agents started here are done.
    const busy = () => agents.some((id) => ctx.harnessUpdates.find((entry) => entry.providerId === id)?.state === 'updating');
    const handOver = () => {
      if (busy()) { setTimeout(handOver, 200); return; }
      setTimeout(() => moveDesktop({ phase: 'downloading', received: 0, total: 96_000_000 }), 300);
      setTimeout(() => moveDesktop({ received: 52_000_000 }), 900);
      setTimeout(() => moveDesktop({ phase: 'installing', received: 96_000_000 }), 1600);
      setTimeout(() => moveDesktop({ phase: 'current', currentVersion: version, version: null, received: 0, total: null }), 3400);
    };
    handOver();
    return null;
  };
  const move = (patch: Partial<ServerUpdateStatus>) => {
    ctx.serverUpdate = { ...ctx.serverUpdate, ...patch };
    ctx.emit('core.updateChanged', structuredClone(ctx.serverUpdate));
    return structuredClone(ctx.serverUpdate);
  };
  /**
   * `finish` stands in for the real core going idle and restarting on the new
   * version, which the update-everything card follows to its end; a plain
   * install stays waiting, as the card's cancel test needs.
   */
  const install = (version: string, finish = false): ServerUpdateStatus => {
    if (!ctx.serverUpdate.version || ctx.serverUpdate.version !== version || ctx.serverUpdate.mode !== 'systemd') throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'core.updateInstall.version must match the available server update' });
    if (['downloading', 'waiting', 'installing'].includes(ctx.serverUpdate.phase)) return structuredClone(ctx.serverUpdate);
    const answer = move({ phase: 'downloading', received: 0, total: 60_000_000, error: null });
    setTimeout(() => { if (ctx.serverUpdate.phase === 'downloading') move({ phase: 'waiting', received: 60_000_000 }); }, 500);
    if (finish) {
      setTimeout(() => { if (ctx.serverUpdate.phase === 'waiting') move({ phase: 'installing' }); }, 2200);
      setTimeout(() => {
        if (ctx.serverUpdate.phase === 'installing') move({ phase: 'current', currentVersion: version, version: null, publishedAt: null, received: 0, total: null });
      }, 3400);
    }
    return answer;
  };
  return {
    'core.updateStatus': async ({ refresh }) => refresh ? move({ checkedAt: Date.now() }) : structuredClone(ctx.serverUpdate),
    'core.updateInstall': async ({ version }) => install(version),
    // The real core's order, without its restart: the agents first, then Boite's download.
    'core.updateEverything': async ({ agents, server, app }) => {
      const started: ProviderId[] = [];
      const failed: { providerId: ProviderId; message: string }[] = [];
      for (const providerId of agents) {
        try {
          if (ctx.harnessUpdates.find((entry) => entry.providerId === providerId)?.state !== 'updating') updateHarness(ctx, providerId);
          started.push(providerId);
        } catch (error) { failed.push({ providerId, message: error instanceof Error ? error.message : String(error) }); }
      }
      let serverError: string | null = null;
      if (server !== null) {
        try { install(server, true); } catch (error) { serverError = error instanceof Error ? error.message : String(error); }
      }
      const appError = app == null ? null : installDesktop(app, started);
      return { agents: started, failed, server: structuredClone(ctx.serverUpdate), serverError, app: structuredClone(ctx.desktopUpdate), appError };
    },
    // The fake stands for another machine's core: its window's report is what the seed already holds.
    'core.desktopUpdateReport': async ({ status }) => {
      ctx.desktopUpdate = structuredClone(status);
      ctx.emit('core.desktopUpdateChanged', { status: structuredClone(status) });
      return { ok: true };
    },
    'core.desktopUpdateStatus': async () => structuredClone(ctx.desktopUpdate),
    'core.updateCancel': async () => ['downloading', 'waiting'].includes(ctx.serverUpdate.phase)
      ? move({ phase: 'available', received: 0, total: null }) : structuredClone(ctx.serverUpdate),
  };
}

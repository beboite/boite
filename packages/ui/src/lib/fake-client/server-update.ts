import { RpcErrorCode, type ServerUpdateStatus } from '@boite/contracts';
import { RpcFailure } from '../client';
import type { FakeContext, FakeMethods } from './context';

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

export function serverUpdateMethods(ctx: FakeContext): Pick<FakeMethods, 'core.updateStatus' | 'core.updateInstall' | 'core.updateCancel'> {
  const move = (patch: Partial<ServerUpdateStatus>) => {
    ctx.serverUpdate = { ...ctx.serverUpdate, ...patch };
    ctx.emit('core.updateChanged', structuredClone(ctx.serverUpdate));
    return structuredClone(ctx.serverUpdate);
  };
  return {
    'core.updateStatus': async ({ refresh }) => refresh ? move({ checkedAt: Date.now() }) : structuredClone(ctx.serverUpdate),
    'core.updateInstall': async ({ version }) => {
      if (!ctx.serverUpdate.version || ctx.serverUpdate.version !== version || ctx.serverUpdate.mode !== 'systemd') throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'core.updateInstall.version must match the available server update' });
      if (['downloading', 'waiting', 'installing'].includes(ctx.serverUpdate.phase)) return structuredClone(ctx.serverUpdate);
      const answer = move({ phase: 'downloading', received: 0, total: 60_000_000, error: null });
      setTimeout(() => { if (ctx.serverUpdate.phase === 'downloading') move({ phase: 'waiting', received: 60_000_000 }); }, 500);
      return answer;
    },
    'core.updateCancel': async () => ['downloading', 'waiting'].includes(ctx.serverUpdate.phase)
      ? move({ phase: 'available', received: 0, total: null }) : structuredClone(ctx.serverUpdate),
  };
}

/** Douane as the in-memory core runs it for the subscription proxy's local mode. */
import { RpcErrorCode, type LocalDouaneStatus, type SubscriptionProxy } from '@boite/contracts';
import { RpcFailure } from '../client';
import type { FakeContext, FakeMethods } from './context';

const RELEASED = '0.3.0';
/** The newer release the fake offers once Douane runs, so the update path has something to show. */
const NEWER = '0.3.1';

export function localProxy(ctx: FakeContext, proxy: SubscriptionProxy): SubscriptionProxy {
  const port = ctx.douane.port;
  return { ...proxy, kind: 'douane', mode: 'local', baseUrl: `http://127.0.0.1:${port}/v1`, dashboardUrl: `http://127.0.0.1:${port}/admin/` };
}

function move(ctx: FakeContext, next: Partial<LocalDouaneStatus>): LocalDouaneStatus {
  const { progress: _progress, message: _message, ...kept } = ctx.douane;
  ctx.douane = { ...kept, ...next };
  ctx.emit('douane.updated', structuredClone(ctx.douane));
  return structuredClone(ctx.douane);
}

function wanted(ctx: FakeContext): boolean {
  return ctx.settings.subscriptionProxy?.mode === 'local';
}

/** As the core: installs once, starts, and answers in a moment. */
function start(ctx: FakeContext): LocalDouaneStatus {
  if (['running', 'starting', 'installing', 'updating'].includes(ctx.douane.state)) return structuredClone(ctx.douane);
  const generation = ++ctx.douaneGeneration;
  const installed = ctx.douane.version !== null;
  const answer = installed ? move(ctx, { state: 'starting' }) : move(ctx, { state: 'installing', progress: { receivedBytes: 0, totalBytes: 9_400_000 } });
  const later = (ms: number, step: () => void) => setTimeout(() => { if (generation === ctx.douaneGeneration && wanted(ctx)) step(); }, ms);
  if (!installed) {
    later(200, () => move(ctx, { state: 'installing', progress: { receivedBytes: 6_100_000, totalBytes: 9_400_000 } }));
    later(400, () => move(ctx, { state: 'starting', version: RELEASED }));
  }
  later(installed ? 250 : 650, () => move(ctx, { state: 'running', available: ctx.douane.version === RELEASED ? NEWER : null }));
  return answer;
}

/** After every proxy change: local starts it, anything else stops it. Its accounts would stay. */
export function douaneSettingsChanged(ctx: FakeContext): void {
  if (wanted(ctx)) {
    if (ctx.douane.state === 'off') start(ctx);
    return;
  }
  ctx.douaneGeneration += 1;
  if (ctx.douane.state !== 'off') move(ctx, { state: 'off', available: null });
}

export function updateDouane(ctx: FakeContext): LocalDouaneStatus {
  if (!wanted(ctx)) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'Douane runs on this machine only in the subscription proxy\'s local mode' });
  if (ctx.douane.state === 'updating') return structuredClone(ctx.douane);
  const target = ctx.douane.available;
  if (target === null) throw new RpcFailure({ code: RpcErrorCode.Refused, message: `Douane is up to date on ${ctx.douane.version ?? 'nothing'}` });
  const generation = ++ctx.douaneGeneration;
  const answer = move(ctx, { state: 'updating', progress: { receivedBytes: 0, totalBytes: 9_400_000 }, message: `Downloading Douane ${target}` });
  setTimeout(() => {
    if (generation === ctx.douaneGeneration) move(ctx, { state: 'updating', message: `Douane ${target} starts once the requests in flight end` });
  }, 400);
  setTimeout(() => {
    if (generation === ctx.douaneGeneration) move(ctx, { state: 'running', version: target, available: null });
  }, 1400);
  return answer;
}

export function douaneMethods(ctx: FakeContext): Pick<FakeMethods, 'douane.status' | 'douane.start' | 'douane.stop' | 'douane.check' | 'douane.update'> {
  return {
    'douane.status': async () => structuredClone(ctx.douane),
    'douane.start': async () => {
      if (!wanted(ctx)) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'Douane runs on this machine only in the subscription proxy\'s local mode' });
      return start(ctx);
    },
    'douane.stop': async () => {
      if (!wanted(ctx)) return structuredClone(ctx.douane);
      ctx.douaneGeneration += 1;
      return move(ctx, { state: 'stopped' });
    },
    'douane.check': async () => structuredClone(ctx.douane),
    'douane.update': async () => updateDouane(ctx),
  };
}

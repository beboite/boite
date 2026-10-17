import type { AccountId, ModelInfo, ProviderId, ThreadId } from '@boite/contracts';
import { ModelProbes } from './model-probes.ts';
import { sessionKey } from './pi/mapping.ts';
import { readModels } from './pi/models.ts';
import { PiSession } from './pi/session.ts';
import { PiTurn } from './pi/turn.ts';
import type { Driver, ProbeContext, ProbeFilter, ProbeResult, SessionContext, TurnContext, TurnHandle } from './types.ts';
import { noteWarmSession } from './driver-log.ts';

const MINUTE_MS = 60_000;

/** One `pi --mode rpc` process per thread, kept between turns like the Codex one. */
export function createPiDriver(): Driver {
  const sessions = new Map<ThreadId, PiSession>();
  const viewed = new Set<ThreadId>();
  const probes = new ModelProbes(readModels);

  function acquire(ctx: SessionContext): PiSession {
    const threadId = ctx.thread.id;
    const warmMs = Math.max(0, ctx.warmProcessMinutes) * MINUTE_MS;
    const key = sessionKey(ctx);

    let session = sessions.get(threadId) ?? null;
    const usable = session?.usable(key, warmMs) === true;
    noteWarmSession(ctx, 'pi', { kept: session !== null, usable, sameSetup: session?.key === key, setupChange: 'the thread changed model, effort, account or folder' });
    if (session !== null && !usable) {
      sessions.delete(threadId);
      session.close(session.key === key ? null : 'the thread changed model, effort, account or folder', ctx);
      session = null;
    }
    if (session === null) {
      session = new PiSession(key, warmMs, (ended) => {
        if (sessions.get(threadId) === ended) sessions.delete(threadId);
      });
      sessions.set(threadId, session);
    }
    const running = session;
    if (viewed.has(threadId)) running.setViewed(true);
    return running;
  }

  return {
    prepare: (ctx, options) => acquire(ctx).prepare(ctx, options?.forTurn),
    setViewed(threadId, active) {
      if (active) viewed.add(threadId);
      else viewed.delete(threadId);
      sessions.get(threadId)?.setViewed(active);
    },
    protocol: 'pi',

    probe(ctx: ProbeContext): Promise<ProbeResult> {
      return probes.probe(ctx);
    },

    probedModels(providerId: ProviderId, accountId: AccountId): ModelInfo[] | null {
      return probes.models(providerId, accountId);
    },

    forgetProbes(filter: ProbeFilter = {}): void {
      probes.forget(filter);
    },

    startTurn(ctx: TurnContext): TurnHandle {
      const turn = new PiTurn(ctx);
      const warmMs = Math.max(0, ctx.warmProcessMinutes) * MINUTE_MS;
      const running = acquire(ctx);
      running.attach(turn, warmMs);
      return {
        done: turn.done,
        steer: (message, attachments) => running.steer(turn, message, attachments),
        applySettings: change => running.applySettings(turn, change),
        stop: (): void => {
          running.stopTurn(turn);
        },
      };
    },

    releaseThread(threadId: ThreadId): void {
      viewed.delete(threadId);
      const session = sessions.get(threadId);
      if (session === undefined || session.busy()) return;
      sessions.delete(threadId);
      session.close(null);
    },

    shutdown(): void {
      const open = [...sessions.values()];
      sessions.clear();
      viewed.clear();
      for (const session of open) session.close(null);
      probes.forget();
    },
  };
}

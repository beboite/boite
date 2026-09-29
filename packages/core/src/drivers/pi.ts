import type { AccountId, ModelInfo, ProviderId, ThreadId } from '@boite/contracts';
import { ModelProbes } from './model-probes.ts';
import { sessionKey } from './pi/mapping.ts';
import { readModels } from './pi/models.ts';
import { PiSession } from './pi/session.ts';
import { PiTurn } from './pi/turn.ts';
import type { Driver, ProbeContext, ProbeFilter, ProbeResult, TurnContext, TurnHandle } from './types.ts';

const MINUTE_MS = 60_000;

/** One `pi --mode rpc` process per thread, kept between turns like the Codex one. */
export function createPiDriver(): Driver {
  const sessions = new Map<ThreadId, PiSession>();
  const probes = new ModelProbes(readModels);

  return {
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
      const threadId = ctx.thread.id;
      const warmMs = Math.max(0, ctx.warmProcessMinutes) * MINUTE_MS;
      const key = sessionKey(ctx);
      const turn = new PiTurn(ctx);

      let session = sessions.get(threadId) ?? null;
      if (session !== null && !session.usable(key, warmMs)) {
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
      running.attach(turn, warmMs);
      return {
        done: turn.done,
        steer: (message) => running.steer(turn, message),
        stop: (): void => {
          running.stopTurn(turn);
        },
      };
    },

    releaseThread(threadId: ThreadId): void {
      const session = sessions.get(threadId);
      if (session === undefined || session.busy()) return;
      sessions.delete(threadId);
      session.close(null);
    },

    shutdown(): void {
      const open = [...sessions.values()];
      sessions.clear();
      for (const session of open) session.close(null);
      probes.forget();
    },
  };
}

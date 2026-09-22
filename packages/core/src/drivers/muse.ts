import type { ThreadId } from '@boite/contracts';
import { ModelProbes } from './model-probes.ts';
import { sessionKey } from './muse/mapping.ts';
import { readModels } from './muse/models.ts';
import { MuseSession } from './muse/session.ts';
import { MuseTurn } from './muse/turn.ts';
import type { Driver, TurnContext, TurnHandle } from './types.ts';
export { choiceFor, museExecutable } from './muse/mapping.ts';
export { modelsFrom, readCatalogEfforts } from './muse/models.ts';
export { mintUuidV7, MspError } from './muse/rpc.ts';

const MINUTE_MS = 60_000;

/** One `muse serve` host per thread, kept between turns like the Codex one. */
export function createMuseDriver(): Driver {
  const sessions = new Map<ThreadId, MuseSession>();
  const probes = new ModelProbes(readModels);

  return {
    protocol: 'muse',

    probe: (context) => probes.probe(context),
    probedModels: (providerId, accountId) => probes.models(providerId, accountId),
    forgetProbes: (filter) => probes.forget(filter),

    startTurn(ctx: TurnContext): TurnHandle {
      const threadId = ctx.thread.id;
      const warmMs = Math.max(0, ctx.warmProcessMinutes) * MINUTE_MS;
      const key = sessionKey(ctx);
      const turn = new MuseTurn(ctx);

      let session = sessions.get(threadId) ?? null;
      if (session !== null && !session.usable(key, warmMs)) {
        sessions.delete(threadId);
        session.close(session.key === key ? null : 'the thread changed mode, account or folder', ctx);
        session = null;
      }
      if (session === null) {
        session = new MuseSession(key, warmMs, (ended) => {
          if (sessions.get(threadId) === ended) sessions.delete(threadId);
        });
        sessions.set(threadId, session);
      }
      const running = session;
      running.attach(turn, warmMs);
      return {
        done: turn.done,
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
      probes.forget();
      for (const session of open) session.close(null);
    },
  };
}

import type { ThreadId } from '@boite/contracts';
import { sessionKey } from './codex/mapping.ts';
import { readModels } from './codex/models.ts';
import { CodexSession } from './codex/session.ts';
import { CodexTurn } from './codex/turn.ts';
import { ModelProbes } from './model-probes.ts';
import type { Driver, TurnContext, TurnHandle } from './types.ts';
export { readCodexQuota } from './codex/models.ts';

const MINUTE_MS = 60_000;

/** One `codex app-server` process per thread, kept between turns like the ACP one. */
export function createCodexDriver(): Driver {
  const sessions = new Map<ThreadId, CodexSession>();
  const probes = new ModelProbes(readModels);

  return {
    protocol: 'codex-appserver',

    probe: (context) => probes.probe(context),
    probedModels: (providerId, accountId) => probes.models(providerId, accountId),
    forgetProbes: (filter) => probes.forget(filter),

    startTurn(ctx: TurnContext): TurnHandle {
      const threadId = ctx.thread.id;
      const warmMs = Math.max(0, ctx.warmProcessMinutes) * MINUTE_MS;
      const key = sessionKey(ctx);
      const turn = new CodexTurn(ctx);

      let session = sessions.get(threadId) ?? null;
      if (session !== null && !session.usable(key, warmMs)) {
        sessions.delete(threadId);
        session.close(
          session.key === key ? null : 'the thread changed mode, account or folder',
          ctx,
        );
        session = null;
      }
      if (session === null) {
        session = new CodexSession(key, warmMs, (ended) => {
          if (sessions.get(threadId) === ended) sessions.delete(threadId);
        });
        sessions.set(threadId, session);
      }
      const running = session;
      running.attach(turn, warmMs);
      return {
        done: turn.done,
        steer: (text) => running.steer(turn, text),
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

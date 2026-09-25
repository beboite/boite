import type { ThreadId } from '@boite/contracts';
import { readClaudeModels } from './claude/models.ts';
import { sessionKey } from './claude/query.ts';
import type { ClaudeDeps } from './claude/query.ts';
import { ClaudeSession } from './claude/session.ts';
import { titleQuery } from './claude/title.ts';
import { ClaudeTurn } from './claude/turn.ts';
import type { Driver, ProbeContext, ProbeResult, TitleContext, TurnContext, TurnHandle } from './types.ts';

const MINUTE_MS = 60_000;

/**
 * One session per thread. `warmProcessMinutes` at zero keeps the old rule, one
 * `query()` per turn and the CLI gone with it; above zero the next turn of the
 * thread reuses the CLI that is already up, as long as nothing of its setup moved.
 */
export function createClaudeDriver(deps: ClaudeDeps): Driver {
  const sessions = new Map<ThreadId, ClaudeSession>();
  const probes = new Map<string, { providerId: string; accountId: string; result?: ProbeResult; pending: Promise<ProbeResult> }>();

  /** The thread's session, started if it has none and replaced if it cannot serve this turn. */
  function acquire(ctx: TurnContext): ClaudeSession {
    const threadId = ctx.thread.id;
    const warmMs = Math.max(0, ctx.warmProcessMinutes) * MINUTE_MS;
    const key = sessionKey(ctx);

    let session = sessions.get(threadId) ?? null;
    if (session !== null && !session.usable(key, warmMs)) {
      sessions.delete(threadId);
      session.close(session.key === key ? null : 'the thread changed account, folder or bypass mode');
      session = null;
    }
    if (session === null) {
      session = new ClaudeSession(
        key,
        warmMs,
        deps,
        {
          ended: (dead): void => {
            if (sessions.get(threadId) === dead) sessions.delete(threadId);
          },
          stranded: (turns): void => {
            for (const moved of turns) attach(moved);
          },
        },
        ctx,
      );
      sessions.set(threadId, session);
    }
    return session;
  }

  function attach(turn: ClaudeTurn): void {
    const session = acquire(turn.ctx);
    turn.session = session;
    session.attach(turn, Math.max(0, turn.ctx.warmProcessMinutes) * MINUTE_MS);
  }

  return {
    protocol: 'claude-sdk',
    probe(ctx: ProbeContext): Promise<ProbeResult> {
      const key = ctx.provider.id + '::' + ctx.accountId;
      const previous = probes.get(key);
      if (previous) return previous.pending;
      const entry = { providerId: ctx.provider.id, accountId: ctx.accountId, pending: Promise.resolve(null as unknown as ProbeResult), result: undefined as ProbeResult | undefined };
      entry.pending = readClaudeModels(ctx, deps).then(result => { if (probes.get(key) === entry) entry.result = result; return result; }).catch(error => { if (probes.get(key) === entry) probes.delete(key); throw error; });
      probes.set(key, entry);
      return entry.pending;
    },
    probedModels(providerId, accountId) { return probes.get(providerId + '::' + accountId)?.result?.models ?? null; },
    forgetProbes(filter = {}) {
      for (const [key, entry] of probes) if ((!filter.providerId || filter.providerId === entry.providerId) && (!filter.accountId || filter.accountId === entry.accountId)) probes.delete(key);
    },

    startTurn(ctx: TurnContext): TurnHandle {
      const turn = new ClaudeTurn(ctx);
      // A turn opened for output the CLI wrote on its own belongs to that CLI.
      // With the CLI gone there is nothing to adopt and no prompt to send.
      if (ctx.turn.execution?.operation === 'background' && sessions.get(ctx.thread.id)?.adoptable() !== true) {
        turn.settle();
        return { done: turn.done, stop: (): void => undefined };
      }
      attach(turn);
      return {
        done: turn.done,
        stop: (): void => {
          // The session that holds it, which is not always the one it started on.
          turn.session?.stopTurn(turn);
        },
      };
    },

    releaseThread(threadId: ThreadId): void {
      const session = sessions.get(threadId);
      // A turn still running on it keeps it: the idle window ends it soon enough.
      if (session === undefined || session.busy()) return;
      sessions.delete(threadId);
      session.close(null);
    },

    title(ctx: TitleContext): Promise<string | null> {
      return titleQuery(deps, ctx);
    },

    shutdown(): void {
      const open = [...sessions.values()];
      sessions.clear();
      for (const session of open) session.close(null, 0);
    },
  };
}

import type { AccountId, ModelInfo, ProviderId, ThreadId } from '@boite/contracts';
import { AcpSession, sessionKey, type AcpMemory } from './acp/session.ts';
import { readModels, withModelEffort, type ProbeEntry } from './acp/probe.ts';
import { isGrok, MINUTE_MS, type AcpDeps } from './acp/protocol.ts';
import { AcpTurn } from './acp/turn.ts';
import type { Driver, ProbeContext, ProbeFilter, ProbeResult, TurnContext, TurnHandle } from './types.ts';

/** One ACP agent process per thread, kept between turns the way the Claude one is. */
export function createAcpDriver(deps: AcpDeps): Driver {
  const sessions = new Map<ThreadId, AcpSession>();
  const probes = new Map<string, ProbeEntry>();
  const memory: AcpMemory = { costPerProcess: new Set<ProviderId>(), refusedLoads: new Set<string>() };

  const keyOf = (providerId: ProviderId, accountId: AccountId): string => `${providerId}::${accountId}`;

  return {
    protocol: 'acp',

    async probe(ctx: ProbeContext): Promise<ProbeResult> {
      const key = keyOf(ctx.provider.id, ctx.accountId);
      const entry: ProbeEntry = probes.get(key) ?? {
        options: [],
        providerId: ctx.provider.id,
        accountId: ctx.accountId,
        running: null,
        result: null,
        effortRead: new Set<string>(),
      };
      probes.set(key, entry);
      // One process at a time per account: a caller naming a model waits for the
      // list, then looks again at what is still missing.
      while (entry.running !== null) {
        try { await entry.running; } catch { /* that caller hears it; this one reads again */ }
      }
      const wanted = ctx.model;
      const known = entry.result;
      const missing = wanted !== undefined
        && !entry.effortRead.has(wanted)
        && (known === null || known.models.some((model) => model.id === wanted && model.effort === undefined));
      if (known !== null && !missing) return known;

      const running = readModels(missing ? ctx : { ...ctx, model: undefined }, deps, (options) => { entry.options = options; }).then((reading) => {
        // Asked once, found or not: a model the agent gives no scale of its
        // own (Grok's without one, a model outside the `model` option) would
        // otherwise start an agent process on every probe that names it.
        if (missing && wanted !== undefined) entry.effortRead.add(wanted);
        else if (reading.effort !== null) entry.effortRead.add(reading.effort.model);
        // A second look keeps the scales the earlier ones found.
        const earlier = new Map((known?.models ?? []).filter((model) => model.effort !== undefined).map((model) => [model.id, model.effort]));
        const models = withModelEffort(reading.models, reading.effort).map((model) => (model.effort === undefined && earlier.has(model.id) ? { ...model, effort: earlier.get(model.id) } : model));
        return { models, probedAt: Date.now() };
      });
      entry.running = running;
      try {
        const result = await running;
        // A `providers.reload` during the probe dropped the entry: nothing is
        // cached behind its back, the next caller probes again.
        if (probes.get(key) === entry) entry.result = result;
        return result;
      } catch (error) {
        // A failed look at one model's efforts leaves the list already read
        // standing, and a failed first look leaves the options a turn noted.
        if (probes.get(key) === entry && known === null && entry.options.length === 0) probes.delete(key);
        throw error;
      } finally {
        entry.running = null;
      }
    },

    probedModels(providerId: ProviderId, accountId: AccountId): ModelInfo[] | null {
      return probes.get(keyOf(providerId, accountId))?.result?.models ?? null;
    },

    forgetProbes(filter: ProbeFilter = {}): void {
      // A reloaded or updated agent may count its cost differently.
      if (filter.accountId === undefined) {
        if (filter.providerId === undefined) memory.costPerProcess.clear();
        else memory.costPerProcess.delete(filter.providerId);
      }
      for (const [key, entry] of [...probes]) {
        if (filter.providerId !== undefined && filter.providerId !== entry.providerId) continue;
        if (filter.accountId !== undefined && filter.accountId !== entry.accountId) continue;
        probes.delete(key);
      }
    },

    startTurn(ctx: TurnContext): TurnHandle {
      const threadId = ctx.thread.id;
      const warmMs = Math.max(0, ctx.warmProcessMinutes) * MINUTE_MS;
      const key = sessionKey(ctx);
      const turn = new AcpTurn(ctx);

      let session = sessions.get(threadId) ?? null;
      if (session !== null && !session.usable(key, warmMs)) {
        sessions.delete(threadId);
        session.close(
          session.key === key
            ? null
            : isGrok(ctx.provider)
              ? 'the thread changed mode, account or folder'
              : 'the thread changed account or folder',
          ctx,
        );
        session = null;
      }
      const probeKey = keyOf(ctx.provider.id, ctx.account.id);
      if (session === null) {
        session = new AcpSession(
          key,
          warmMs,
          deps,
          memory,
          (ended) => {
            if (sessions.get(threadId) === ended) sessions.delete(threadId);
          },
          (options) => {
            // Kept beside the probe, never as its result: the picker and the
            // model check still see an account nobody probed.
            if (options.length === 0) return;
            const entry = probes.get(probeKey) ?? {
              options: [],
              providerId: ctx.provider.id,
              accountId: ctx.account.id,
              running: null,
              result: null,
              effortRead: new Set<string>(),
            };
            if (entry.options.length === 0) entry.options = structuredClone(options);
            probes.set(probeKey, entry);
          },
        );
        sessions.set(threadId, session);
      }
      const running = session;
      running.seedConfig(probes.get(probeKey)?.options ?? []);
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
      probes.clear();
      memory.costPerProcess.clear();
      memory.refusedLoads.clear();
      for (const session of open) session.close(null);
    },
  };
}

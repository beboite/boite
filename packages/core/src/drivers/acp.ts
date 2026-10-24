import type { SessionConfigOption } from '@agentclientprotocol/sdk';
import type { AccountId, ModelInfo, ProviderDescriptor, ProviderId, ThreadId } from '@boite/contracts';
import { agentModelsOf, modelsFrom, plainObject } from './acp/models.ts';
import { AcpSession, sessionKey, type AcpMemory } from './acp/session.ts';
import { readModels, withModelEffort, type ProbeEntry } from './acp/probe.ts';
import { isGrok, MINUTE_MS, type AcpDeps } from './acp/protocol.ts';
import { AcpTurn } from './acp/turn.ts';
import type { Driver, LiveTurnSettings, ProbeContext, ProbeFilter, ProbeResult, SessionContext, TurnContext, TurnHandle } from './types.ts';
import { noteWarmSession } from './driver-log.ts';

/** One ACP agent process per thread, kept between turns the way the Claude one is. */
export function createAcpDriver(deps: AcpDeps): Driver {
  const sessions = new Map<ThreadId, AcpSession>();
  const viewed = new Set<ThreadId>();
  const probes = new Map<string, ProbeEntry>();
  let probeRevision = 0;
  const memory: AcpMemory = { costPerProcess: new Set<ProviderId>(), refusedLoads: new Set<string>() };

  const keyOf = (providerId: ProviderId, accountId: AccountId): string => `${providerId}::${accountId}`;

  function acquire(ctx: SessionContext): AcpSession {
    const threadId = ctx.thread.id;
    const warmMs = Math.max(0, ctx.warmProcessMinutes) * MINUTE_MS;
    const key = sessionKey(ctx);

    let session = sessions.get(threadId) ?? null;
    const usable = session?.usable(key, warmMs) === true;
    noteWarmSession(ctx, `${ctx.provider.id} ACP`, { kept: session !== null, usable, sameSetup: session?.key === key, setupChange: isGrok(ctx.provider) ? 'the thread changed mode, account or folder' : 'the thread changed account or folder' });
    if (session !== null && !usable) {
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
    const revision = probeRevision;
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
          if (options.length === 0 || revision !== probeRevision) return;
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
    if (viewed.has(threadId)) running.setViewed(true);
    running.seedConfig(probes.get(probeKey)?.options ?? []);
    return running;
  }

  return {
    prepare: (ctx, options) => acquire(ctx).prepare(ctx, options?.forTurn),
    setViewed(threadId, active) {
      if (active) viewed.add(threadId);
      else viewed.delete(threadId);
      sessions.get(threadId)?.setViewed(active);
    },
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
      // A prepared session already read the agent's catalog. Inspect it without
      // changing its model; an unseen model's efforts use a separate probe.
      const prepared = ctx.catalogThread === undefined ? undefined : sessions.get(ctx.catalogThread.id);
      const models = await prepared?.catalog(ctx) ?? null;
      if (models !== null) {
        const previous = new Map((entry.result?.models ?? []).filter(model => model.effort !== undefined).map(model => [model.id, model.effort]));
        entry.result = {
          models: models.map(model => model.effort === undefined && previous.has(model.id) ? { ...model, effort: previous.get(model.id) } : model),
          probedAt: Date.now(),
        };
        for (const model of models) if (model.effort !== undefined) entry.effortRead.add(model.id);
      }
      // The matching preparation was awaited above; another caller may have
      // started its isolated effort probe in the meantime.
      while (entry.running !== null) {
        try { await entry.running; } catch { /* retry the missing reading below */ }
      }
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

    async rememberSession(provider: ProviderDescriptor, accountId: AccountId, created: unknown): Promise<ModelInfo[]> {
      // Read exactly as a probe reads its own `session/new`.
      const listed = plainObject(created)?.['configOptions'];
      const options = Array.isArray(listed) ? (listed as SessionConfigOption[]) : null;
      const models = modelsFrom(provider, options, agentModelsOf(created));
      const key = keyOf(provider.id, accountId);
      const entry: ProbeEntry = probes.get(key) ?? {
        options: [],
        providerId: provider.id,
        accountId,
        running: null,
        result: null,
        effortRead: new Set<string>(),
      };
      entry.options = options ?? [];
      entry.result = { models, probedAt: Date.now() };
      for (const model of models) if (model.effort !== undefined) entry.effortRead.add(model.id);
      probes.set(key, entry);
      return models;
    },

    forgetProbes(filter: ProbeFilter = {}): void {
      // A refresh changes nothing about the agent: what a session still opening
      // answers may seed the next one.
      if (filter.refresh !== true) probeRevision += 1;
      for (const session of sessions.values()) session.forgetCatalog(filter);
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
      const turn = new AcpTurn(ctx);
      const warmMs = Math.max(0, ctx.warmProcessMinutes) * MINUTE_MS;
      const running = acquire(ctx);
      running.attach(turn, warmMs);
      return {
        done: turn.done,
        ...(isGrok(ctx.provider) || ctx.protectedExecution ? {} : { setPermissionMode: (mode: TurnContext['thread']['permissionMode']) => running.setPermissionMode(turn, mode) }),
        ...(isGrok(ctx.provider) ? {} : { applySettings: (change: LiveTurnSettings) => running.applySettings(turn, change) }),
        stop: (): void => {
          running.stopTurn(turn);
        },
        // Plain ACP has no input while a prompt runs; Grok adds one.
        ...(isGrok(ctx.provider) ? { steer: (text: string) => running.steer(turn, text) } : {}),
        ...(ctx.provider.id === 'opencode-v2' ? { steer: (text, attachments, onAccepted) => running.steerOpenCode(turn, text, attachments, onAccepted) } : {}),
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
      probes.clear();
      memory.costPerProcess.clear();
      memory.refusedLoads.clear();
      for (const session of open) session.close(null);
    },
  };
}

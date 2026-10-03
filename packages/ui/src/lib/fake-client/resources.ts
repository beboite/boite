/** Process trace, live resources and token usage. */
import { RpcErrorCode, type AgentResourceSnapshot, type ResourceByteUsage, type ThreadId, type ThreadResources, type Usage } from '@boite/contracts';
import { RpcFailure } from '../client';
import { addUsage, emptyUsage } from './shared';
import { fakeUsageHistory } from '../fake-usage';
import type { FakeContext, FakeMethods } from './context';

function resources(ctx: FakeContext): ThreadResources[] {
  const out: ThreadResources[] = [];
  for (const thread of ctx.threads.values()) {
    const live = ctx.processes.filter((p) => p.threadId === thread.id && p.exitedAt === null);
    // The core's rule: only what runs now; what exited stays in the trace.
    if (live.length === 0) continue;
    out.push({
      threadId: thread.id,
      title: thread.title,
      status: thread.status,
      live,
      // As in the core, the count is the live list's, whenever the load was sampled.
      load: { ...(thread.load ?? { cpuPercent: 0, memoryBytes: 0 }), processes: live.length }
    });
  }
  return out.sort((a, b) => b.load.cpuPercent - a.load.cpuPercent);
}

export function resourceMethods(ctx: FakeContext) {
  const unavailable = (): ResourceByteUsage => ({ readBytes: null, writeBytes: null,
    readBytesPerSecond: null, writeBytesPerSecond: null, sampledAt: null, since: null,
    coverage: 'unavailable', source: 'unavailable', note: 'No supported per-agent counter' });
  return {
    'resources.usage': async (params): Promise<AgentResourceSnapshot> => {
      if (ctx.bus.principal === 'agent') throw new RpcFailure({ code: RpcErrorCode.Refused, message: "resources.usage is not one of the agent's methods" });
      if (params === null || typeof params !== 'object' || Array.isArray(params)) throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'resources.usage: expected an object' });
      if (params.watch !== undefined && typeof params.watch !== 'boolean') throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'watch: expected a boolean' });
      return { sampledAt: ctx.now(), agents: resources(ctx).map(resource => {
        const thread = ctx.threads.get(resource.threadId)!;
        return { threadId: thread.id, title: thread.title, providerId: thread.providerId, model: thread.model,
          status: thread.status, projectId: thread.projectId, parentThreadId: thread.parentThreadId ?? null,
          load: resource.load, loadAvailable: { cpu: thread.load !== null, memory: thread.load !== null }, disk: unavailable(), network: unavailable() };
      }) };
    },
    'trace.get': async (params) => {
      const rows = ctx.processes
        .filter((p) => p.threadId === params.threadId)
        .sort((a, b) => b.startedAt - a.startedAt);
      return structuredClone(params.limit ? rows.slice(0, params.limit) : rows);
    },
    'resources.list': async (params) => {
      return structuredClone(resources(ctx));
    },
    'resources.memoryStatus': async () => {
      const totalMb = 32768;
      const budget = Math.floor(totalMb * ctx.settings.agentMemoryBudgetPercent / 100 / 256) * 256;
      return {
        state: ctx.settings.memoryProtection === false ? 'ok' : ctx.memoryState,
        agentBytes: resources(ctx).reduce((sum, thread) => sum + thread.load.memoryBytes, 0),
        availableBytes: (ctx.memoryState === 'critical' ? 2048 : 16384) * 1048576,
        limits: {
          budgetMb: ctx.settings.memoryProtection === false ? 0 : budget,
          threadMemoryCapMb: ctx.settings.memoryProtection === false ? 0 : Math.min(ctx.settings.threadMemoryCapMb || Math.floor(budget / 2 / 256) * 256, budget),
          memoryReserveMb: ctx.settings.memoryProtection === false ? 0 : ctx.settings.memoryReserveMb || Math.max(totalMb * 0.1, 3072),
        },
      };
    },
    'resources.killTree': async (params) => {
      let killed = 0;
      for (const record of ctx.processes) {
        if (record.threadId !== params.threadId || record.exitedAt !== null) continue;
        record.exitedAt = ctx.now();
        record.exitCode = 1;
        killed += 1;
        ctx.emitToThread(record.threadId, 'process.exited', structuredClone(record));
      }
      const thread = ctx.threads.get(params.threadId);
      if (thread) {
        thread.load = null;
        ctx.touch(thread);
      }
      return { killed };
    },
    'usage.get': async (params) => {
      const byThread: Record<ThreadId, Usage> = {};
      let total = emptyUsage();
      for (const [threadId, usage] of ctx.usage) {
        if (params.threadId && params.threadId !== threadId) continue;
        byThread[threadId] = { ...usage };
        total = addUsage(total, usage);
      }
      return { byThread, total };
    },
    'usage.history': async (params) => {
      const { edges } = params;
      const valid = Array.isArray(edges) && edges.length >= 2 && edges.length <= 367 &&
        edges.every((edge, index) => typeof edge === 'number' && Number.isFinite(edge) && (index === 0 || edge > edges[index - 1]!));
      if (!valid) throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'edges: expected 2 to 367 strictly ascending timestamps in milliseconds' });
      if (params.providerId !== undefined && (typeof params.providerId !== 'string' || !params.providerId.trim())) {
        throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'providerId: expected a non-empty provider id' });
      }
      return fakeUsageHistory(edges, { seeded: ctx.usageSeeded, finished: ctx.finished, providerId: params.providerId });
    },
  } satisfies Partial<FakeMethods>;
}

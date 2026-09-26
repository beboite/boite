/** Process trace, live resources and token usage. */
import { RpcErrorCode, type ThreadId, type ThreadResources, type Usage } from '@boite/contracts';
import { RpcFailure } from '../client';
import { addUsage, emptyUsage } from './shared';
import { fakeUsageHistory } from '../fake-usage';
import type { FakeContext, FakeMethods } from './context';

function resources(ctx: FakeContext): ThreadResources[] {
  const out: ThreadResources[] = [];
  for (const thread of ctx.threads.values()) {
    const mine = ctx.processes.filter((p) => p.threadId === thread.id);
    const live = mine.filter((p) => p.exitedAt === null);
    // The core's rule: nothing ever ran, or archived with nothing running.
    if (mine.length === 0 || (thread.archived && live.length === 0)) continue;
    out.push({
      threadId: thread.id,
      title: thread.title,
      status: thread.status,
      live,
      totals: {
        processes: mine.length,
        cpuMs: mine.reduce((sum, p) => sum + (p.cpuMs ?? 0), 0),
        peakMemoryBytes: mine.reduce((max, p) => Math.max(max, p.peakMemoryBytes ?? 0), 0)
      }
    });
  }
  return out.sort((a, b) => b.live.length - a.live.length);
}

export function resourceMethods(ctx: FakeContext) {
  return {
    'trace.get': async (params) => {
      const rows = ctx.processes
        .filter((p) => p.threadId === params.threadId)
        .sort((a, b) => b.startedAt - a.startedAt);
      return structuredClone(params.limit ? rows.slice(0, params.limit) : rows);
    },
    'resources.list': async (params) => {
      return structuredClone(resources(ctx));
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
      return fakeUsageHistory(edges, { seeded: ctx.usageSeeded, finished: ctx.finished });
    },
  } satisfies Partial<FakeMethods>;
}

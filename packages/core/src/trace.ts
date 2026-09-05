import type { ProcessRecord, ThreadId, ThreadResources } from '@boite/contracts';
import type { Core } from './core.ts';

const DEFAULT_TRACE_LIMIT = 200;

export function threadResources(core: Core, threadId: ThreadId): ThreadResources | null {
  const thread = core.journal.getThread(threadId);
  if (thread === null) return null;
  return {
    threadId,
    title: thread.title,
    status: thread.status,
    live: core.procs.liveOf(threadId),
    totals: core.journal.processTotals(threadId),
  };
}

export function registerTraceMethods(core: Core): void {
  core.router.register('trace.get', (params): ProcessRecord[] =>
    core.journal.listProcesses(params.threadId, params.limit ?? DEFAULT_TRACE_LIMIT),
  );
  core.router.register('resources.list', (): ThreadResources[] => {
    const out: ThreadResources[] = [];
    for (const thread of core.journal.listThreads()) {
      const resources = threadResources(core, thread.id);
      if (resources !== null) out.push(resources);
    }
    return out;
  });
  core.router.register('resources.killTree', (params) => {
    core.threads.require(params.threadId);
    return { killed: core.procs.killTree(params.threadId) };
  });
}

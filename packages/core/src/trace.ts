import type { ProcessRecord, ThreadResources } from '@boite/contracts';
import type { Core } from './core.ts';

const DEFAULT_TRACE_LIMIT = 200;


export function registerTraceMethods(core: Core): void {
  core.router.register('trace.get', (params): ProcessRecord[] =>
    core.journal.listProcesses(params.threadId, params.limit ?? DEFAULT_TRACE_LIMIT),
  );
  core.router.register('resources.list', (): ThreadResources[] => {
    // Two queries whatever the number of threads. A thread that never ran a
    // process, or an archived one with nothing running, has nothing to show.
    const totals = core.journal.processTotalsByThread();
    const out: ThreadResources[] = [];
    for (const thread of core.journal.listThreads()) {
      const live = core.procs.liveOf(thread.id);
      const total = totals.get(thread.id);
      if (live.length === 0 && (total === undefined || thread.archived)) continue;
      out.push({
        threadId: thread.id,
        title: thread.title,
        status: thread.status,
        live,
        totals: total ?? { processes: 0, cpuMs: 0, peakMemoryBytes: 0 },
      });
    }
    return out;
  });
  core.router.register('resources.killTree', (params) => {
    core.threads.require(params.threadId);
    return { killed: core.procs.killTree(params.threadId) };
  });
}

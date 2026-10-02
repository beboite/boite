import type { ProcessRecord, ThreadResources } from '@boite/contracts';
import type { Core } from './core.ts';
import { invalidParams } from './errors.ts';

const DEFAULT_TRACE_LIMIT = 200;


export function registerTraceMethods(core: Core): void {
  core.router.register('resources.usage', (params, { connection }) => {
    if (params === null || typeof params !== 'object' || Array.isArray(params)) throw invalidParams('resources.usage: expected an object');
    if (params.watch !== undefined && typeof params.watch !== 'boolean') throw invalidParams('watch: expected a boolean');
    core.procs.watchResources(connection.id, params.watch);
    return core.procs.resourceUsage();
  });
  core.router.register('resources.memoryStatus', () => core.procs.memory.status());
  core.router.register('trace.get', (params): ProcessRecord[] =>
    core.journal.listProcesses(params.threadId, params.limit ?? DEFAULT_TRACE_LIMIT),
  );
  core.router.register('resources.list', (): ThreadResources[] => {
    // Live only: a task manager shows what runs now. The client polls it while
    // the page is open, so it walks the live table, never the journal's history.
    const out: ThreadResources[] = [];
    for (const threadId of core.procs.liveThreads()) {
      const thread = core.journal.getThread(threadId);
      const live = core.procs.liveOf(threadId);
      if (thread === null || live.length === 0) continue;
      out.push({
        threadId,
        title: thread.title,
        status: thread.status,
        live,
        load: core.procs.loadOf(threadId) ?? { processes: live.length, cpuPercent: 0, memoryBytes: 0 },
      });
    }
    return out.sort((a, b) => b.load.cpuPercent - a.load.cpuPercent);
  });
  core.router.register('resources.killTree', (params) => {
    core.threads.require(params.threadId);
    return { killed: core.procs.killTree(params.threadId) };
  });
}

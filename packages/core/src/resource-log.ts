import type { MemoryEvent, RpcEvents } from '@boite/contracts';
import type { Core } from './core.ts';

const MB = 1048576;

/**
 * The memory guard's decisions with the numbers it decided on: a pressure
 * change with the agents' total and what the machine has left, each process
 * it killed with its size and the limit it crossed, each cap or budget
 * refusal, and a cgroup that keeps stalling its processes.
 */
export function attachResourceLog(core: Core): () => void {
  return core.bus.onAny((name, payload) => {
    if (name !== 'resources.memory') return;
    const event = payload as RpcEvents['resources.memory'] & MemoryEvent;
    const threadId = event.threadId ?? undefined;
    const base = { source: 'memory-guard', ...(threadId === undefined ? {} : { threadId }) };
    if (event.kind === 'pressure') {
      let status: { agentBytes: number; availableBytes: number | null } | null = null;
      try { status = core.procs.memory.status(); } catch { status = null; }
      core.logs.record(event.state === 'ok' ? 'info' : 'warn', `Memory pressure is now ${event.state}${status ? `: agents use ${Math.round(status.agentBytes / MB)} MB, the machine has ${status.availableBytes === null ? 'an unknown amount' : `${Math.round(status.availableBytes / MB)} MB`} available` : ''}`, {
        ...base, event: 'memory.pressure', data: { state: event.state, agentMb: status ? Math.round(status.agentBytes / MB) : null, availableMb: status?.availableBytes == null ? null : Math.round(status.availableBytes / MB) },
      });
    } else if (event.kind === 'killed') {
      const exe = event.exe?.split(/[\\/]/).pop() ?? 'unknown';
      core.logs.warn(`Memory guard killed ${exe} (pid ${event.pid ?? 'unknown'}, ${Math.round((event.bytes ?? 0) / MB)} MB): ${event.reason} limit of ${Math.round(event.limitBytes / MB)} MB crossed`, {
        ...base, event: 'memory.killed', data: { pid: event.pid ?? null, exe, mb: Math.round((event.bytes ?? 0) / MB), reason: event.reason, limitMb: Math.round(event.limitBytes / MB), state: event.state },
      });
    } else if (event.kind === 'throttled') {
      core.logs.warn(`The thread's memory group keeps hitting its ${Math.round(event.limitBytes / MB)} MB high limit and stalls (${Math.round((event.bytes ?? 0) / MB)} MB charged)`, {
        ...base, event: 'memory.throttled', data: { mb: Math.round((event.bytes ?? 0) / MB), limitMb: Math.round(event.limitBytes / MB) },
      });
    } else {
      core.logs.warn(event.kind === 'thread-cap' ? 'An allocation was refused: the thread reached its memory cap' : 'An allocation was refused: the agents reached their shared memory budget', {
        ...base, event: `memory.${event.kind}`, data: { state: event.state },
      });
    }
  });
}

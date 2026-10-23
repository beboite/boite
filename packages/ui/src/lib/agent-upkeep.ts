import { SvelteSet } from 'svelte/reactivity';
import type { AgentsSnapshot } from '@boite/contracts';

/**
 * Conversations the core runs for a persistent agent's own upkeep: its memory
 * pass, a child of its thread (`AgentStatus.memory.threadId`). They are not
 * work the user handed out, so the subagent dock and the finished-turn
 * notification leave them out. Learnt from every agents snapshot this client
 * reads; ids are unique across machines' threads.
 */
export const upkeepThreads = new SvelteSet<string>();

export function noteUpkeep(snapshot: Pick<AgentsSnapshot, 'status'> | null | undefined): void {
  for (const status of snapshot?.status ?? []) {
    const id = status.memory?.threadId;
    if (id && !upkeepThreads.has(id)) upkeepThreads.add(id);
  }
}

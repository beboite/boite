import { SvelteSet } from 'svelte/reactivity';
import type { AgentsSnapshot } from '@boite/contracts';
import type { Store } from './store.svelte';

/**
 * Conversations the core runs for a persistent agent's own upkeep: its memory
 * pass, a child of its thread (`AgentStatus.memory.threadId`). They are not
 * work the user handed out, so the subagent dock and the finished-turn
 * notification leave them out. Learnt from every agents snapshot this client
 * reads, per machine: thread ids can collide between machines.
 */
const UPKEEP = new WeakMap<Store, SvelteSet<string>>();

/** The upkeep threads the machine of `store` named so far. */
export function upkeepOf(store: Store): ReadonlySet<string> {
  let ids = UPKEEP.get(store);
  if (!ids) { ids = new SvelteSet(); UPKEEP.set(store, ids); }
  return ids;
}

export function noteUpkeep(store: Store, snapshot: Pick<AgentsSnapshot, 'status'> | null | undefined): void {
  const ids = upkeepOf(store) as SvelteSet<string>;
  for (const status of snapshot?.status ?? []) {
    const id = status.memory?.threadId;
    if (id && !ids.has(id)) ids.add(id);
  }
}

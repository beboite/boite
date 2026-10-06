import { Bot, Handshake } from '@lucide/svelte';
import type { ThreadSummary } from '@boite/contracts';
import { agentDirectory } from './agent-directory.svelte';
import { contextMenu } from './context-menu.svelte';
import { experimentOn } from './experiments.svelte';
import type { MenuItem } from './menu';
import type { Store } from './store.svelte';
import { fill, strings } from './strings';

/*
 * Entrusting a thread to an agent from the thread's own menus, the way a move
 * is picked: one row in the row, title and phone menus ("Entrust to an
 * agent", or "Take it back" once entrusted), then a menu of the agents.
 * `agents.entrust` does the rest in the core (docs/agents.md).
 */

type Entrustable = Pick<ThreadSummary, 'id' | 'projectId' | 'parentThreadId' | 'agentSessionId' | 'archived' | 'incognito'>;

/** A thread the owner can hand over: an ordinary, kept conversation in a project. */
export function canEntrust(store: Store, thread: Entrustable): boolean {
  return experimentOn('resident-agents') && store.owner && !thread.parentThreadId && !thread.agentSessionId && thread.projectId !== null && !thread.archived && !thread.incognito;
}

export function entrustItems(store: Store, thread: Entrustable): MenuItem[] {
  if (!canEntrust(store, thread)) return [];
  const directory = agentDirectory(store);
  const held = directory.entrustmentOf(thread.id);
  if (held) return [{ id: 'entrust-back', label: strings.agents.takeBack, glyph: Handshake, hint: fill(strings.agents.entrustedTo, { name: held.agent.name }) }];
  if (!directory.agents.length) return [];
  return [{ id: 'entrust', label: strings.agents.entrustTo, glyph: Handshake }];
}

/** Answers a pick of `entrustItems`' rows; false for any other row. */
export function pickEntrustItem(store: Store, thread: Entrustable, action: string, anchor?: HTMLElement | null): boolean {
  if (action === 'entrust-back') { void entrust(store, thread.id, null); return true; }
  if (action !== 'entrust') return false;
  const items: MenuItem[] = agentDirectory(store).agents.map(agent => ({ id: agent.id, label: fill(strings.agents.entrustToName, { name: agent.name }), hint: agent.domain || undefined, glyph: Bot }));
  const pick = (agentId: string) => { void entrust(store, thread.id, agentId); };
  const rect = anchor?.getBoundingClientRect();
  if (anchor && rect && rect.width > 0) contextMenu.show({ x: rect.left, y: rect.bottom }, items, pick, anchor);
  else contextMenu.follow(items, pick);
  return true;
}

/** Hands the thread to an agent, or takes it back with null; a refusal shows as the store's error. */
export async function entrust(store: Store, threadId: string, agentId: string | null): Promise<void> {
  const client = store.client;
  if (!client) return;
  try {
    await client.call('agents.entrust', { threadId, agentId });
    agentDirectory(store).reload();
  } catch (error) {
    store.error = error instanceof Error ? error.message : String(error);
  }
}

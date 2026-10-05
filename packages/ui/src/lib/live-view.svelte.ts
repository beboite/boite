import { SvelteSet } from 'svelte/reactivity';
import type { Store } from './store.svelte';
import { strings } from './strings';
import { workspace } from './workspace.svelte';

/**
 * The agent's browser and devices run on the machine of the conversation, and
 * every client watches them by polling frames. Nothing streams until the user
 * asks for it on this client: the panel first covers the view with a card
 * naming the machine. The choice holds per conversation (its thread key) and
 * per kind for this session only, so a reload covers it again.
 */
const shown = new SvelteSet<string>();
export type LiveViewKind = 'agent-browser' | 'device';
const key = (kind: LiveViewKind, threadKey: string) => `${kind}\u0000${threadKey}`;

export const liveViews = {
  shown: (kind: LiveViewKind, threadKey: string): boolean => shown.has(key(kind, threadKey)),
  show(kind: LiveViewKind, threadKey: string): void { shown.add(key(kind, threadKey)); },
  hide(kind: LiveViewKind, threadKey: string): void { shown.delete(key(kind, threadKey)); },
  /** Tests start from covered views. */
  reset(): void { shown.clear(); },
};

/** What the cover calls the machine that runs the conversation: its name in the machine list. */
export function machineName(store: Store): string {
  const label = workspace.machines.find((machine) => machine.store === store)?.label?.trim();
  return label || store.core?.hostname || strings.machines.local;
}

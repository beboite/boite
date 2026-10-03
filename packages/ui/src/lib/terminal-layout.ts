/*
 * How a thread's shells sit in its drawer: tabs in the order they were made,
 * each one shell or a split of up to `MAX_PANES`, side by side or stacked, with
 * the share of the room each pane takes. A pane is the shell's id
 * (`threadTerminalId`). The shells are the core's; this is only where they
 * show, kept per device in localStorage. T3 Code's model, with resizable panes.
 */

import { MAX_THREAD_TERMINALS, isThreadTerminal, threadTerminalId, type ThreadId, type ThreadTerminal } from '@boite/contracts';

/** The most panes one tab splits into, as in T3 Code. */
export const MAX_PANES = 4;
/** The smallest share of a split a pane is dragged down to. */
export const MIN_SHARE = 0.12;

/** `row`: side by side, what Ctrl+D makes. `column`: stacked, Ctrl+Shift+D. */
export type SplitDirection = 'row' | 'column';

export interface TerminalTab {
  id: string;
  panes: string[];
  direction: SplitDirection;
  /** One share per pane, summing to one. */
  sizes: number[];
}

export interface TerminalLayout {
  tabs: TerminalTab[];
  /** The pane with the keyboard; its tab is the one shown. */
  active: string;
}

/** The `terminalId` a pane opens with: none for the thread's first shell. */
export function terminalIdOf(threadId: ThreadId, pane: string): string | undefined {
  const first = threadTerminalId(threadId);
  return pane === first ? undefined : pane.slice(first.length + 1);
}

/** `Terminal 1` for the thread's first shell, `Terminal 3` for `term-3`. */
export function paneNumber(threadId: ThreadId, pane: string): number {
  const key = terminalIdOf(threadId, pane);
  if (key === undefined) return 1;
  const match = /^term-(\d+)$/.exec(key);
  return match ? Number(match[1]) : 0;
}

export function panesOf(layout: TerminalLayout): string[] {
  return layout.tabs.flatMap((tab) => tab.panes);
}

export function activeTab(layout: TerminalLayout): TerminalTab {
  return layout.tabs.find((tab) => tab.panes.includes(layout.active)) ?? layout.tabs[0]!;
}

/** A layout of the thread's first shell alone. */
export function firstLayout(threadId: ThreadId): TerminalLayout {
  const pane = threadTerminalId(threadId);
  return { tabs: [{ id: 'tab-1', panes: [pane], direction: 'row', sizes: [1] }], active: pane };
}

/** The id of the next shell: the lowest `term-N` no pane holds, as T3 Code numbers them. */
export function nextPane(threadId: ThreadId, layout: TerminalLayout | null): string | null {
  const panes = layout === null ? [] : panesOf(layout);
  if (panes.length >= MAX_THREAD_TERMINALS) return null;
  const taken = new Set(panes.map((pane) => paneNumber(threadId, pane)));
  let n = 2;
  while (taken.has(n)) n++;
  return threadTerminalId(threadId, `term-${n}`);
}

function nextTabId(layout: TerminalLayout): string {
  const taken = new Set(layout.tabs.map((tab) => tab.id));
  let n = layout.tabs.length + 1;
  while (taken.has(`tab-${n}`)) n++;
  return `tab-${n}`;
}

/** A new tab at the end, holding `pane`, shown. */
export function addTab(layout: TerminalLayout, pane: string): TerminalLayout {
  return { tabs: [...layout.tabs, { id: nextTabId(layout), panes: [pane], direction: 'row', sizes: [1] }], active: pane };
}

/**
 * `pane` after the active one, in its tab, which then lays out in `direction`;
 * the shares even out. Null when the tab is full.
 */
export function splitPane(layout: TerminalLayout, pane: string, direction: SplitDirection): TerminalLayout | null {
  const tab = activeTab(layout);
  if (tab.panes.length >= MAX_PANES) return null;
  const at = tab.panes.indexOf(layout.active) + 1;
  const panes = [...tab.panes.slice(0, at), pane, ...tab.panes.slice(at)];
  const next: TerminalTab = { ...tab, panes, direction, sizes: panes.map(() => 1 / panes.length) };
  return { tabs: layout.tabs.map((t) => (t === tab ? next : t)), active: pane };
}

/**
 * The layout without `pane`. Its share goes to its neighbours, an emptied tab
 * goes, and the keyboard goes to the pane in its place, as T3 Code does. Null
 * once no pane is left.
 */
export function removePane(layout: TerminalLayout, pane: string): TerminalLayout | null {
  const tabIndex = layout.tabs.findIndex((tab) => tab.panes.includes(pane));
  if (tabIndex === -1) return layout;
  const tab = layout.tabs[tabIndex]!;
  const index = tab.panes.indexOf(pane);
  const panes = tab.panes.filter((p) => p !== pane);
  let tabs: TerminalTab[];
  if (panes.length === 0) tabs = layout.tabs.filter((_, i) => i !== tabIndex);
  else {
    const left = tab.sizes.filter((_, i) => i !== index);
    const total = left.reduce((sum, size) => sum + size, 0);
    tabs = layout.tabs.map((t, i) => (i === tabIndex ? { ...tab, panes, sizes: left.map((size) => size / total) } : t));
  }
  if (tabs.length === 0) return null;
  if (layout.active !== pane) return { tabs, active: layout.active };
  const active = panes.length > 0
    ? panes[Math.min(index, panes.length - 1)]!
    : tabs[Math.min(tabIndex, tabs.length - 1)]!.panes[0]!;
  return { tabs, active };
}

/** Moves the line between pane `index` and the next to `share` of their two shares, each kept above `MIN_SHARE`. */
export function resizePanes(layout: TerminalLayout, tabId: string, index: number, share: number): TerminalLayout {
  return {
    ...layout,
    tabs: layout.tabs.map((tab) => {
      if (tab.id !== tabId || index < 0 || index >= tab.panes.length - 1) return tab;
      const pair = tab.sizes[index]! + tab.sizes[index + 1]!;
      const clamped = Math.min(1 - MIN_SHARE, Math.max(MIN_SHARE, share));
      const sizes = [...tab.sizes];
      sizes[index] = pair * clamped;
      sizes[index + 1] = pair * (1 - clamped);
      return { ...tab, sizes };
    }),
  };
}

/**
 * The stored layout matched with the shells the core still runs: a pane whose
 * shell ended goes, a shell no pane shows (opened on another device) gets a tab
 * of its own at the end. Null when nothing runs.
 */
export function reconcile(threadId: ThreadId, stored: TerminalLayout | null, running: ThreadTerminal[]): TerminalLayout | null {
  const alive = new Set(running.map((shell) => shell.id).filter((id) => isThreadTerminal(threadId, id)));
  let layout: TerminalLayout | null = stored;
  for (const pane of stored === null ? [] : panesOf(stored)) {
    if (!alive.has(pane) && layout !== null) layout = removePane(layout, pane);
  }
  for (const id of alive) {
    if (layout === null) layout = { tabs: [{ id: 'tab-1', panes: [id], direction: 'row', sizes: [1] }], active: id };
    else if (!panesOf(layout).includes(id)) layout = { ...addTab(layout, id), active: layout.active };
  }
  return layout;
}


/** A stored layout, or null when it is not one: an older or hand-edited value never breaks the drawer. */
export function parseLayout(threadId: ThreadId, value: unknown): TerminalLayout | null {
  if (typeof value !== 'object' || value === null) return null;
  const { tabs, active } = value as { tabs?: unknown; active?: unknown };
  if (!Array.isArray(tabs) || typeof active !== 'string') return null;
  const seen = new Set<string>();
  const parsed: TerminalTab[] = [];
  for (const tab of tabs) {
    const { id, panes, direction, sizes } = (tab ?? {}) as Partial<Record<keyof TerminalTab, unknown>>;
    if (typeof id !== 'string' || !Array.isArray(panes) || panes.length === 0 || panes.length > MAX_PANES) return null;
    if (direction !== 'row' && direction !== 'column') return null;
    if (!panes.every((pane): pane is string => typeof pane === 'string' && isThreadTerminal(threadId, pane) && !seen.has(pane) && Boolean(seen.add(pane)))) return null;
    const shares = Array.isArray(sizes) && sizes.length === panes.length && sizes.every((size) => typeof size === 'number' && size > 0)
      ? (sizes as number[])
      : panes.map(() => 1);
    const total = shares.reduce((sum, size) => sum + size, 0);
    parsed.push({ id, panes, direction, sizes: shares.map((size) => size / total) });
  }
  if (parsed.length === 0 || !seen.has(active)) return null;
  return { tabs: parsed, active };
}

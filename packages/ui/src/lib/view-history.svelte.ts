/**
 * A mouse's back and forward buttons walk the views this window showed: a
 * thread, a draft, a settings tab, the Agents page, on whichever machine each
 * was.
 *
 * The trail is this window's own and lives in memory. It is not the browser's
 * history: that one belongs to the phone overlays (`mobile-history.ts`), and a
 * view written there would outlive a reload and point at a thread that is gone.
 * A view is recorded once it is on screen, so a thread still loading leaves no
 * entry, and a machine switch leaves one entry, not one for the thread that
 * machine had open and one for the thread asked for.
 */
import type { ProjectId, ThreadId } from '@boite/contracts';
import type { SettingsTab, Store } from './store.svelte';
import { workspace } from './workspace.svelte';

export type View =
  | { store: Store; page: 'thread'; threadId: ThreadId }
  | { store: Store; page: 'draft'; projectId: ProjectId | null }
  | { store: Store; page: 'settings'; tab: SettingsTab }
  | { store: Store; page: 'agents' };

/** How far back the buttons reach. */
export const TRAIL_LIMIT = 100;
/** Under this width Back belongs to the overlays of `mobile-history.ts`. */
const PHONE = '(max-width: 720px)';
const BACK_BUTTON = 3;
const FORWARD_BUTTON = 4;

function where(view: View): string {
  if (view.page === 'thread') return `thread:${view.threadId}`;
  if (view.page === 'draft') return `draft:${view.projectId ?? ''}`;
  if (view.page === 'settings') return `settings:${view.tab}`;
  return 'agents';
}

export function sameView(a: View, b: View): boolean {
  return a.store === b.store && where(a) === where(b);
}

/** The visited views in order, and which one is on screen. */
export class Trail {
  #views: View[] = [];
  #index = -1;

  get current(): View | null { return this.#views[this.#index] ?? null; }
  get length(): number { return this.#views.length; }

  /** A view reached any other way than by the buttons: what was ahead of the last one is gone. */
  visit(view: View): void {
    const current = this.current;
    if (current && sameView(current, view)) return;
    this.#views.splice(this.#index + 1, Infinity, view);
    const over = this.#views.length - TRAIL_LIMIT;
    if (over > 0) this.#views.splice(0, over);
    this.#index = this.#views.length - 1;
  }

  /**
   * The nearest view that way which still exists, now the current one, or null
   * at the end of the trail. The views found gone on the way are forgotten.
   */
  step(direction: -1 | 1, exists: (view: View) => boolean): View | null {
    for (;;) {
      const next = this.#index + direction;
      const view = this.#views[next];
      if (!view) return null;
      if (exists(view)) {
        this.#index = next;
        return view;
      }
      this.#views.splice(next, 1);
      if (direction < 0) this.#index -= 1;
    }
  }

  clear(): void {
    this.#views = [];
    this.#index = -1;
  }
}

/** What the active machine shows, or null while it shows nothing a button could come back to. */
export function currentView(): View | null {
  const store = workspace.active;
  if (store.page === 'settings') return { store, page: 'settings', tab: store.settingsTab };
  if (store.page === 'agents') return { store, page: 'agents' };
  if (store.openThread) return { store, page: 'thread', threadId: store.openThread.id };
  if (store.draft) return { store, page: 'draft', projectId: store.draft.projectId };
  return null;
}

/** A machine that left, or a thread or project that was deleted, is not a place to return to. */
function exists(view: View): boolean {
  const { store } = view;
  if (store !== workspace.active && !workspace.machines.some((machine) => machine.store === store)) return false;
  if (view.page === 'thread') return store.threads.some((thread) => thread.id === view.threadId);
  if (view.page === 'draft') return view.projectId === null || store.projects.some((project) => project.id === view.projectId);
  return true;
}

async function show(view: View): Promise<void> {
  const { store } = view;
  if (view.page === 'thread') return workspace.select(store, view.threadId);
  if (view.page === 'draft' && view.projectId !== null) return workspace.select(store, undefined, view.projectId);
  if (workspace.active !== store) await workspace.select(store);
  if (view.page === 'draft') store.startDraft(null);
  else if (view.page === 'settings') store.showSettings(view.tab);
  else store.showAgents();
}

export const trail = new Trail();
/** True while a button's own move is being shown: that move is not a new visit. */
let moving = false;
let moves: Promise<void> = Promise.resolve();

function record(): void {
  // Read first, whatever comes of it: an effect that returned before reading
  // any state would depend on none, and never run again.
  const view = currentView();
  // A machine being switched to shows what it had open until what was asked for lands.
  const settled = workspace.selecting === 0 && workspace.active.booted;
  if (moving || !settled) return;
  if (view) trail.visit(view);
}

async function move(direction: -1 | 1): Promise<void> {
  // What is on screen is where the move starts, even when no effect ran since it changed.
  record();
  const from = trail.current;
  const target = trail.step(direction, exists);
  if (!target) return;
  moving = true;
  try {
    await show(target);
  } finally {
    moving = false;
  }
  // A thread that would not open leaves the screen where it was, and the trail with it.
  const shown = currentView();
  if (from && shown && sameView(shown, from) && !sameView(shown, target)) trail.step(direction < 0 ? 1 : -1, () => true);
  else record();
}

/** One step back or forward. Presses made while a thread is still opening run in order. */
export function go(direction: -1 | 1): Promise<void> {
  moves = moves.then(() => move(direction)).catch(() => undefined);
  return moves;
}

/**
 * Record the views and answer the two mouse buttons, until the returned
 * function is called. The browser's own Back is cancelled on the press and on
 * the release, because Linux navigates on the first and Windows on the second.
 */
export function startViewHistory(target: Window = window): () => void {
  const stopRecording = $effect.root(() => {
    $effect(record);
  });
  const direction = (event: MouseEvent): -1 | 1 | null => {
    if (event.button !== BACK_BUTTON && event.button !== FORWARD_BUTTON) return null;
    if (target.matchMedia?.(PHONE).matches) return null;
    return event.button === BACK_BUTTON ? -1 : 1;
  };
  const cancel = (event: MouseEvent): void => {
    if (direction(event) !== null) event.preventDefault();
  };
  const release = (event: MouseEvent): void => {
    const way = direction(event);
    if (way === null) return;
    event.preventDefault();
    void go(way);
  };
  target.addEventListener('mousedown', cancel, true);
  target.addEventListener('mouseup', release, true);
  target.addEventListener('auxclick', cancel, true);
  return () => {
    stopRecording();
    target.removeEventListener('mousedown', cancel, true);
    target.removeEventListener('mouseup', release, true);
    target.removeEventListener('auxclick', cancel, true);
    trail.clear();
  };
}

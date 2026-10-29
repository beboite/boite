/*
 * Load on press: what a click would load starts on the press.
 * A mouse button stays down for 60 to 120 ms before the click fires, a finger
 * longer; on a remote machine that is most of a round trip. One capture
 * listener on the window reads two attributes, so a row costs nothing to mark:
 *
 * - `data-preload-thread="<thread id>"`: the owning machine's store (the
 *   nearest `data-machine-id`, else the active one) subscribes and asks for the
 *   page now, and the `open()` the click runs takes both over
 *   (`store/threads.svelte.ts`). A press that never becomes a click (a drag,
 *   a scroll on a phone, a release elsewhere) gives the subscription back.
 * - `data-preload-view="settings" | "agents" | "home"`: the page's code chunk.
 *
 * It stays off under automation (`navigator.webdriver`), so benchmarks and
 * end-to-end runs measure the plain click; its own test opts in with
 * `__BOITE_PRESS_PRELOAD_TEST__`.
 */

import { prefetchAllowed } from './prefetch';

/** What a press needs from a machine's store. */
export interface PreloadStore {
  preload(threadId: string): () => void;
}

export interface PreloadWorkspace {
  machines: { id: string; store: PreloadStore }[];
  active: PreloadStore;
}

/** How long a released press waits for its click before giving the thread back. */
export const PRESS_GRACE_MS = 400;
/** A press held longer than this is a drag or a long press, not a click on its way. */
export const PRESS_HOLD_MS = 8_000;

const views: Record<string, () => Promise<unknown>> = {
  settings: () => import('../components/SettingsShell.svelte'),
  agents: () => import('../components/agents/AgentsPage.svelte'),
  home: () => import('../components/home/HomePage.svelte')
};

/** False under a driven browser, unless its own test asked for it. */
export function preloadAllowed(nav: { webdriver?: boolean } = navigator): boolean {
  return nav.webdriver !== true || window.__BOITE_PRESS_PRELOAD_TEST__ === true;
}

/**
 * The store that owns a marked element: its machine's, the one on screen when
 * it names none, and null for a machine no longer connected. Thread ids can
 * collide between machines, so a stale row never preloads on another one.
 */
function owningStore(workspace: PreloadWorkspace, element: Element): PreloadStore | null {
  const named = element.closest('[data-machine-id]');
  if (!named) return workspace.active;
  const machineId = named.getAttribute('data-machine-id');
  return workspace.machines.find((machine) => machine.id === machineId)?.store ?? null;
}

export function startPressPreload(workspace: PreloadWorkspace): () => void {
  let release: (() => void) | null = null;
  let pointer: number | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const settle = (delay: number) => {
    clearTimeout(timer);
    const pending = release;
    if (!pending) return;
    const finish = () => {
      if (release !== pending) return;
      release = null;
      pointer = null;
      pending();
    };
    if (delay <= 0) finish();
    else timer = setTimeout(finish, delay);
  };

  const down = (event: PointerEvent) => {
    if (!event.isPrimary || event.button !== 0 || !preloadAllowed()) return;
    // A finger that starts a scroll costs a page it never shows: on a link
    // that cannot spare the bytes, touch waits for its click.
    if (event.pointerType === 'touch' && !prefetchAllowed()) return;
    const target = event.target instanceof Element ? event.target.closest('[data-preload-thread], [data-preload-view]') : null;
    if (!target) return;
    const view = target.getAttribute('data-preload-view');
    if (view) {
      void views[view]?.().catch(() => undefined);
      return;
    }
    const threadId = target.getAttribute('data-preload-thread');
    const store = owningStore(workspace, target);
    if (!threadId || !store) return;
    settle(0);
    release = store.preload(threadId);
    pointer = event.pointerId;
    timer = setTimeout(() => settle(0), PRESS_HOLD_MS);
  };
  // The click lands right after the release; the grace covers a handler that
  // awaits something of its own before it opens.
  const up = (event: PointerEvent) => {
    if (event.pointerId === pointer) settle(PRESS_GRACE_MS);
  };
  // A drag, a scroll or a lost pointer: no click is coming.
  const cancel = (event: PointerEvent) => {
    if (event.pointerId === pointer) settle(0);
  };
  // A row dragged to another project fires no pointercancel everywhere.
  const drag = () => settle(0);

  const options = { capture: true, passive: true } as const;
  window.addEventListener('pointerdown', down, options);
  window.addEventListener('pointerup', up, options);
  window.addEventListener('pointercancel', cancel, options);
  window.addEventListener('dragstart', drag, options);
  return () => {
    window.removeEventListener('pointerdown', down, options);
    window.removeEventListener('pointerup', up, options);
    window.removeEventListener('pointercancel', cancel, options);
    window.removeEventListener('dragstart', drag, options);
    settle(0);
  };
}

/**
 * The desktop's own browser, lent to the agents of this computer.
 *
 * The browser tabs of a conversation's panel are real WebView2 pages: the user
 * signs in there and passes the checks a headless browser fails. The core
 * cannot reach them, so the owner's Windows shell, connected to the core it
 * started, tells it which tabs each conversation's panel has and carries out
 * what the agent of that conversation asks of them: open a tab, load an
 * address, close one, and the few DevTools calls `boite browser` reads, types
 * and clicks with. The core relays nothing else (`packages/core/src/browser/desktop.ts`).
 *
 * The page the agent drives is the one the user sees, so either can take over.
 * A panel shows another machine's conversations too; those tabs stay out of it,
 * since that machine's agents run elsewhere.
 */
import {
  DEFAULT_BROWSER_PROFILE, DESKTOP_BROWSER_METHODS, DESKTOP_BROWSER_TABS_MAX,
  type DesktopBrowserMethod, type DesktopBrowserRequest, type DesktopBrowserTab
} from '@boite/contracts';
import type { Store } from './store.svelte';
import { rightPanel, type PanelState, type Surface } from './right-panel.svelte';
import { browserBridge } from './browser-bridge';
import { CLOSED_TAB } from './browser-bridge-tauri';
import { browserProfiles } from './browser-profiles.svelte';

/** A burst of panel changes (a page's url, then its title) is one snapshot. */
const SEND_DELAY_MS = 150;
/** How long a tab whose view was never made gets to load before the agent reads it. */
const REVIVE_MS = 10_000;
const ERROR_MAX = 2000;
const METHODS: ReadonlySet<string> = new Set(DESKTOP_BROWSER_METHODS);

/**
 * Whether this window lends its browser: the owner's Windows shell on the core
 * it started. Only WebView2 answers DevTools calls, and a core on another
 * machine has agents that could never see this screen.
 */
export function lendsBrowser(store: Pick<Store, 'owner' | 'localCore'>): boolean {
  return store.owner && store.localCore && !!browserBridge.protocol && /Windows/.test(navigator.userAgent);
}

/** The thread a panel key names on the machine `machineId`, or null for a key that is not one of its conversations. */
export function threadOfPanelKey(key: string, machineId: string | null): string | null {
  if (!machineId) return key !== '' && !key.startsWith('[') ? key : null;
  if (!key.startsWith('[')) return null;
  try {
    const parsed: unknown = JSON.parse(key);
    return Array.isArray(parsed) && parsed.length === 2 && parsed[0] === machineId && typeof parsed[1] === 'string' && parsed[1] !== '' ? parsed[1] : null;
  } catch { return null; }
}

/** Every browser tab of this machine's conversations, as `browser.desktopTabs` takes them. */
export function desktopTabsOf(threads: Record<string, PanelState>, machineId: string | null): DesktopBrowserTab[] {
  const tabs: DesktopBrowserTab[] = [];
  for (const [key, state] of Object.entries(threads)) {
    const threadId = threadOfPanelKey(key, machineId);
    if (threadId === null) continue;
    for (const surface of state.surfaces) {
      if (surface.kind !== 'browser') continue;
      if (tabs.length >= DESKTOP_BROWSER_TABS_MAX) return tabs;
      tabs.push(lent(threadId, surface, state.isOpen && state.activeSurfaceId === surface.id));
    }
  }
  return tabs;
}

function lent(threadId: string, surface: Surface, active = false): DesktopBrowserTab {
  return {
    threadId, tabId: surface.id,
    url: (surface.url ?? '').slice(0, 16384), title: (surface.title ?? '').slice(0, 2000),
    profile: surface.profile ?? DEFAULT_BROWSER_PROFILE,
    ...(active ? { active: true } : {})
  };
}

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)).slice(0, ERROR_MAX);

/**
 * Lends the panel's browser to the core this window started, while it is
 * connected; for an `$effect`, which reruns on a reconnection and ends the
 * previous loan through the returned function.
 */
export function lendLocalBrowser(machines: readonly { store: Store }[]): (() => void) | undefined {
  const local = machines.find((machine) => machine.store.localCore)?.store;
  void local?.connection;
  if (local?.client?.state === 'ready' && lendsBrowser(local)) return lendDesktopBrowser(local);
}

/**
 * Lends the panel's browser to the core `store` is connected to, until the
 * returned function runs. Captures the store's client: a reconnection lends
 * again through a new call.
 */
export function lendDesktopBrowser(store: Store): () => void {
  const client = store.client;
  const protocol = browserBridge.protocol?.bind(browserBridge);
  if (!client || !protocol || !lendsBrowser(store)) return () => {};
  let stopped = false, sent = '', timer: ReturnType<typeof setTimeout> | undefined;
  const current = () => !stopped && store.client === client;

  const send = () => {
    timer = undefined;
    if (!current()) return;
    const tabs = desktopTabsOf(rightPanel.threads, store.machineId);
    const key = JSON.stringify(tabs);
    if (key === sent) return;
    sent = key;
    void client.call('browser.desktopTabs', { host: true, tabs }).catch(() => { if (sent === key) sent = ''; });
  };
  const destroyEffects = $effect.root(() => {
    $effect(() => {
      void rightPanel.threads;
      clearTimeout(timer);
      timer = setTimeout(send, SEND_DELAY_MS);
    });
  });

  const tabOf = (threadId: string, tabId: string) => {
    const panel = rightPanel.for(store.threadKey(threadId));
    const surface = panel.surfaces.find((one) => one.id === tabId && one.kind === 'browser');
    if (!surface) throw new Error('the browser tab is no longer in this conversation\'s panel');
    return { panel, surface };
  };

  /** A tab kept from an earlier session has no view until it is shown: one is made for the agent, off screen. */
  const call = async (surface: Surface, method: DesktopBrowserMethod, params: Record<string, unknown>) => {
    try { return await protocol(surface.id, method, params); }
    catch (cause) { if (message(cause) !== CLOSED_TAB) throw cause; }
    browserBridge.create(surface.id, surface.url ?? '', surface.profile);
    const deadline = Date.now() + REVIVE_MS;
    while (!browserBridge.isReady(surface.id) && current() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    if (!current()) throw new Error('the desktop app stopped lending its browser');
    return protocol(surface.id, method, params);
  };

  const answer = async (threadId: string, request: DesktopBrowserRequest): Promise<unknown> => {
    switch (request.kind) {
      case 'open': {
        const profile = browserProfiles.find(request.profile);
        if (profile === null) throw new Error(`the desktop app has no browser profile ${request.profile}`);
        const panel = rightPanel.for(store.threadKey(threadId));
        const surface = panel.open('browser', request.url, profile);
        browserBridge.create(surface.id, request.url, surface.profile);
        return lent(threadId, surface, true);
      }
      case 'navigate': {
        const { panel, surface } = tabOf(threadId, request.tabId);
        // A view that does not exist yet starts blank rather than on the page it is about to leave.
        browserBridge.create(surface.id, '', surface.profile);
        browserBridge.navigate(surface.id, request.url);
        panel.update(surface.id, { url: request.url });
        if (request.show) panel.activate(surface.id);
        return { ok: true };
      }
      case 'close': {
        // Already gone is closed too: the user may have shut it first.
        const panel = rightPanel.for(store.threadKey(threadId));
        if (panel.surfaces.some((one) => one.id === request.tabId && one.kind === 'browser')) panel.close(request.tabId);
        return { closed: true };
      }
      case 'protocol': {
        if (!METHODS.has(request.method)) throw new Error(`the desktop app's browser does not take ${String(request.method)} from an agent`);
        const { surface } = tabOf(threadId, request.tabId);
        return call(surface, request.method, request.params);
      }
      default: throw new Error('the desktop app does not know that browser request');
    }
  };

  const off = client.on('browser.desktopRequest', (event) => {
    void (async () => {
      let result: unknown, error: string | undefined;
      try {
        if (!current()) throw new Error('the desktop app stopped lending its browser');
        result = await answer(event.threadId, event.request);
      } catch (cause) { error = message(cause); }
      if (stopped || store.client !== client) return;
      await client.call('browser.desktopReply', { requestId: event.requestId, ...(error === undefined ? { result: result ?? null } : { error }) }).catch(() => {});
    })();
  });

  return () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    destroyEffects();
    off();
    if (store.client === client) void client.call('browser.desktopTabs', { host: false, tabs: [] }).catch(() => {});
  };
}

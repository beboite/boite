import { afterEach, expect, test, vi } from 'vitest';
import { flushSync } from 'svelte';
import type { DesktopBrowserRequest, RpcEvents } from '@boite/contracts';
import { rightPanel } from './right-panel.svelte';
import type { Store } from './store.svelte';

const bridge = vi.hoisted(() => ({
  paints: true, live: new Set<string>(),
  isReady: (id: string) => bridge.live.has(id),
  create: vi.fn((id: string) => { bridge.live.add(id); }),
  navigate: vi.fn(),
  destroy: vi.fn((id: string) => { bridge.live.delete(id); }),
  on: () => () => {},
  protocol: vi.fn(async (id: string, method: string, params: Record<string, unknown>): Promise<unknown> => {
    if (!bridge.live.has(id)) throw new Error('the browser tab is closed');
    return { result: { value: `${method} ${String(params.expression)} on ${id}` } };
  }),
}));
vi.mock('./browser-bridge', () => ({ browserBridge: bridge, normalizeUrl: (url: string) => url }));
vi.mock('./browser-bridge-tauri', () => ({ CLOSED_TAB: 'the browser tab is closed' }));
const { desktopTabsOf, lendDesktopBrowser } = await import('./desktop-browser-host.svelte');
const { lendsBrowser } = await import('./desktop-browser-loan');

const keys: string[] = [];
afterEach(() => { for (const key of keys.splice(0)) rightPanel.forget(key); vi.restoreAllMocks(); bridge.live.clear(); });
const panelOf = (key: string) => { keys.push(key); return rightPanel.for(key); };
const settle = () => new Promise(resolve => setTimeout(resolve, 200));

test('a panel lends the browser tabs of this machine\'s conversations, never another machine\'s', () => {
  const here = panelOf('t-here'), there = panelOf(JSON.stringify(['m-laptop', 't-there']));
  here.open('browser', 'https://studio.example/');
  here.open('tasks');
  there.open('browser', 'https://elsewhere.example/');
  const tabs = desktopTabsOf(rightPanel.threads, null);
  expect(tabs).toEqual([expect.objectContaining({ threadId: 't-here', url: 'https://studio.example/', profile: 'default' })]);
  // The tasks surface is the one showing, so the browser tab is not the panel's active one.
  expect(tabs[0]!.active).toBeUndefined();
  expect(desktopTabsOf(rightPanel.threads, 'm-laptop')).toEqual([expect.objectContaining({ threadId: 't-there', url: 'https://elsewhere.example/' })]);
});

test('the shell opens, drives and closes the panel tabs the core asks for, and stops lending when told', async () => {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Edg/140');
  const calls: Array<[string, Record<string, unknown>]> = [];
  let request: ((event: RpcEvents['browser.desktopRequest']) => void) | null = null;
  const client = {
    state: 'ready',
    call: vi.fn(async (method: string, params: Record<string, unknown>) => { calls.push([method, params]); return { ok: true }; }),
    on: (_event: string, handler: typeof request) => { request = handler; return () => { request = null; }; },
  };
  const store = { owner: true, localCore: true, machineId: null, client, threadKey: (id: string) => id } as unknown as Store;
  expect(lendsBrowser(store)).toBe(true);
  expect(lendsBrowser({ ...store, owner: false } as Store)).toBe(false);

  const kept = panelOf('t-lend');
  const old = kept.open('browser', 'https://kept.example/');
  const stop = lendDesktopBrowser(store);
  flushSync();
  await settle();
  expect(calls.at(-1)).toEqual(['browser.desktopTabs', { host: true, tabs: [expect.objectContaining({ threadId: 't-lend', tabId: old.id, active: true })] }]);

  const ask = async (payload: DesktopBrowserRequest) => {
    const requestId = `r${calls.length}`;
    request!({ requestId, threadId: 't-lend', request: payload });
    await vi.waitFor(() => expect(calls.some(([method, params]) => method === 'browser.desktopReply' && params.requestId === requestId)).toBe(true));
    return calls.find(([, params]) => params.requestId === requestId)![1];
  };

  // A tab kept from an earlier session has no view yet: one is made before the agent reads it.
  expect(await ask({ kind: 'protocol', tabId: old.id, method: 'Runtime.evaluate', params: { expression: 'document.title' } }))
    .toEqual({ requestId: expect.any(String), result: { result: { value: `Runtime.evaluate document.title on ${old.id}` } } });
  expect(bridge.create).toHaveBeenCalledWith(old.id, 'https://kept.example/', undefined);
  expect((await ask({ kind: 'protocol', tabId: old.id, method: 'Target.closeTarget' as never, params: {} })).error).toContain('does not take Target.closeTarget');

  const opened = (await ask({ kind: 'open', url: 'https://studio.example/', profile: 'default' })).result as { tabId: string };
  expect(kept.surfaces.map(surface => surface.url)).toEqual(['https://kept.example/', 'https://studio.example/']);
  expect(opened).toMatchObject({ threadId: 't-lend', url: 'https://studio.example/', active: true });
  expect(bridge.create).toHaveBeenLastCalledWith(opened.tabId, 'https://studio.example/', undefined);

  // `browse` brings the tab it loads forward.
  await ask({ kind: 'navigate', tabId: old.id, url: 'https://kept.example/next', show: true });
  expect(bridge.navigate).toHaveBeenLastCalledWith(old.id, 'https://kept.example/next');
  expect(kept.active?.id).toBe(old.id);
  expect(await ask({ kind: 'close', tabId: opened.tabId })).toMatchObject({ result: { closed: true } });
  expect(kept.surfaces.map(surface => surface.id)).toEqual([old.id]);

  stop();
  expect(calls.at(-1)).toEqual(['browser.desktopTabs', { host: false, tabs: [] }]);
  expect(request).toBeNull();
});

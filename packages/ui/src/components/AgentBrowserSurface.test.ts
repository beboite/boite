import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { FakeClient } from '../lib/fake-client';
import { liveViews } from '../lib/live-view.svelte';
import { Store } from '../lib/store.svelte';
import AgentBrowserSurface from './AgentBrowserSurface.svelte';

let app: ReturnType<typeof mount> | undefined, client: FakeClient, store: Store;
const settle = async () => { for (let i = 0; i < 20; i++) { await Promise.resolve(); flushSync(); } };
const thread = 't-trace';
const query = (id: string) => document.querySelector<HTMLElement>(`[data-testid=${id}]`);

beforeEach(async () => {
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  liveViews.reset();
  client = new FakeClient({ delayMs: 0 }); store = new Store(); store.attach(client); await store.connect();
  await client.call('threads.subscribe', { threadId: thread });
});
afterEach(async () => {
  if (app) await unmount(app); app = undefined;
  store?.detach(); client?.close(); vi.useRealTimers(); vi.restoreAllMocks();
  document.body.innerHTML = ''; localStorage.clear(); liveViews.reset();
});

const open = (url: string) => client.call('browser.command', { threadId: thread, action: { kind: 'open', url } });

test('nothing streams before Show; Show watches the picked tab, Hide covers it and stops the frames', async () => {
  vi.useFakeTimers();
  const calls = vi.spyOn(client, 'call');
  const frames = () => calls.mock.calls.filter(([method]) => method === 'browser.remoteFrame');
  app = mount(AgentBrowserSurface, { target: document.body, props: { store, threadId: thread } }); await settle();
  expect(query('agent-browser-none')!.textContent).toContain('The agent has no browser open');

  const docs = await open('https://example.com/docs');
  const shop = await open('https://shop.example/cart'); await settle();
  // The cover names the machine and the agent's active tab.
  expect(query('agent-browser-cover-text')!.textContent).toMatch(/^This agent controls a browser on .+/);
  expect(query('agent-browser-cover')!.textContent).toContain('shop.example');
  await vi.advanceTimersByTimeAsync(2000); await settle();
  expect(frames()).toHaveLength(0);

  query('agent-browser-show')!.click(); await settle();
  await vi.advanceTimersByTimeAsync(300); await settle();
  expect(frames().at(-1)![1]).toMatchObject({ threadId: thread, tabId: shop.tabId });
  expect(query('remote-browser-frame')).not.toBeNull();
  const tabs = document.querySelectorAll<HTMLButtonElement>('[data-testid=agent-browser-tab]');
  expect([...tabs].map(tab => tab.getAttribute('aria-selected'))).toEqual(['false', 'true']);
  tabs[0]!.click(); await settle();
  await vi.advanceTimersByTimeAsync(600); await settle();
  expect(frames().at(-1)![1]).toMatchObject({ tabId: docs.tabId });

  query('agent-browser-hide')!.click(); await settle();
  expect(query('agent-browser-cover')).not.toBeNull();
  const before = frames().length;
  await vi.advanceTimersByTimeAsync(3000); await settle();
  expect(frames()).toHaveLength(before);

  // The agent closing its last tab leaves the empty state.
  await client.call('browser.command', { threadId: thread, tabId: docs.tabId, action: { kind: 'close' } });
  await client.call('browser.command', { threadId: thread, tabId: shop.tabId, action: { kind: 'close' } }); await settle();
  expect(query('agent-browser-none')).not.toBeNull();
});

test('a machine with no browser to run says so and why', async () => {
  const original = client.call.bind(client);
  vi.spyOn(client, 'call').mockImplementation(((method: string, params: unknown) => {
    if (method === 'browser.remoteStatus') return Promise.resolve({ live: false, tabs: [], available: false, reason: 'no Chromium-based browser was found' });
    return original(method as never, params as never);
  }) as typeof client.call);
  app = mount(AgentBrowserSurface, { target: document.body, props: { store, threadId: thread } }); await settle();
  expect(query('agent-browser-unavailable')!.textContent).toMatch(/^\s*No agent browser on .+/);
  expect(query('agent-browser-reason')!.textContent).toBe('no Chromium-based browser was found');
});

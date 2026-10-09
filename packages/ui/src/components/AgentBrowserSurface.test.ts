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
  // The owner starts on a new tab page, as a browser opens on one.
  expect(query('agent-browser-start')!.textContent).toMatch(/Open a page in this conversation’s browser on .+/);

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

  // The agent closing its last tab leaves the new tab page.
  await client.call('browser.command', { threadId: thread, tabId: docs.tabId, action: { kind: 'close' } });
  await client.call('browser.command', { threadId: thread, tabId: shop.tabId, action: { kind: 'close' } }); await settle();
  expect(query('agent-browser-start')).not.toBeNull();
});

test('the owner opens a page from a new tab, watches it without a cover and closes it with its ×', async () => {
  const calls = vi.spyOn(client, 'call');
  app = mount(AgentBrowserSurface, { target: document.body, props: { store, threadId: thread } }); await settle();
  await open('https://example.com/docs'); await settle();
  query('agent-browser-new')!.click(); await settle();
  expect(query('agent-browser-draft')).not.toBeNull();
  const field = query('agent-browser-start-address') as HTMLInputElement;
  expect(document.activeElement).toBe(field);
  const submit = () => query('agent-browser-start')!.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
  const opens = () => calls.mock.calls.filter(([method, params]) => method === 'browser.command' && (params as { action: { kind: string } }).action.kind === 'open');
  const before = opens().length;
  // A file address is refused on the spot and the draft stays.
  field.value = 'file:///etc/passwd'; field.dispatchEvent(new Event('input', { bubbles: true })); await settle();
  submit(); await settle();
  expect(query('agent-browser-start')!.textContent).toContain('Enter a web address');
  expect(opens()).toHaveLength(before);
  // Enter pressed twice opens one tab.
  field.value = 'shop.example/cart'; field.dispatchEvent(new Event('input', { bubbles: true })); await settle();
  submit(); submit(); await settle();
  expect(opens()).toHaveLength(before + 1);
  expect(calls).toHaveBeenCalledWith('browser.command', { threadId: thread, action: { kind: 'open', url: 'https://shop.example/cart' } });
  // His own page opens live, on the tab he just made.
  expect(query('agent-browser-cover')).toBeNull();
  expect(query('remote-browser')).not.toBeNull();
  const tabs = () => [...document.querySelectorAll<HTMLButtonElement>('[data-testid=agent-browser-tab]')];
  expect(tabs().map(tab => tab.getAttribute('aria-selected'))).toEqual(['false', 'true']);
  const opened = (await client.call('browser.remoteStatus', { threadId: thread })).tabs.at(-1)!;
  document.querySelectorAll<HTMLButtonElement>('[data-testid=agent-browser-close]')[1]!.click(); await settle();
  expect(calls).toHaveBeenCalledWith('browser.command', { threadId: thread, tabId: opened.tabId, action: { kind: 'close' } });
  expect(tabs()).toHaveLength(1);
  // The double submit left nothing stuck: the next new tab opens again.
  query('agent-browser-new')!.click(); await settle();
  const again = query('agent-browser-start-address') as HTMLInputElement;
  again.value = 'example.org'; again.dispatchEvent(new Event('input', { bubbles: true })); await settle();
  submit(); await settle();
  expect(opens()).toHaveLength(before + 2);
});

test('the desktop of the machine that runs the browser shows the page at once, without a cover', async () => {
  vi.useFakeTimers();
  const calls = vi.spyOn(client, 'call');
  store.localCore = true;
  app = mount(AgentBrowserSurface, { target: document.body, props: { store, threadId: thread } }); await settle();
  await open('https://example.com/docs'); await settle();
  await vi.advanceTimersByTimeAsync(300); await settle();
  expect(query('agent-browser-cover')).toBeNull();
  expect(query('agent-browser-hide')).toBeNull();
  expect(calls.mock.calls.some(([method]) => method === 'browser.remoteFrame')).toBe(true);
});

test('a paired phone watches the agent tabs but cannot open or close one', async () => {
  store.detach(); client.close();
  client = new FakeClient({ delayMs: 0, principal: 'session' }); store = new Store(); store.attach(client); await store.connect();
  await client.call('threads.subscribe', { threadId: thread });
  app = mount(AgentBrowserSurface, { target: document.body, props: { store, threadId: thread } }); await settle();
  expect(query('agent-browser-none')!.textContent).toContain('The agent has no browser open');
  client.becomes('owner'); await open('https://example.com/docs'); client.becomes('session'); await settle();
  expect(query('agent-browser-cover')).not.toBeNull();
  expect(query('agent-browser-new')).toBeNull();
  expect(query('agent-browser-close')).toBeNull();
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

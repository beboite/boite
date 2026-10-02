import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { FakeClient } from '../lib/fake-client';
import { Store } from '../lib/store.svelte';
import { EXPERIMENTS_STORAGE_KEY, readExperiments, writeExperiments } from '../lib/experiments';
import RemoteBrowser from './RemoteBrowser.svelte';

let app: ReturnType<typeof mount> | undefined, client: FakeClient, store: Store;
const settle = async () => { for (let i = 0; i < 20; i++) { await Promise.resolve(); flushSync(); } };
beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function(this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function(this: HTMLDialogElement) { this.open = false; } });
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
});
afterEach(async () => {
  if (app) await unmount(app); app = undefined;
  store?.detach(); client?.close(); vi.useRealTimers(); vi.restoreAllMocks();
  document.body.innerHTML = ''; writeExperiments([]); localStorage.clear();
});

test('a fresh web install offers setup without polling and persists explicit activation', async () => {
  client = new FakeClient({ delayMs: 0, principal: 'session' }); store = new Store(); store.attach(client); await store.connect();
  expect(store.owner).toBe(false);
  const original = client.call.bind(client);
  const calls = vi.spyOn(client, 'call').mockImplementation(((method: string, params: unknown) => {
    if (method !== 'browser.remoteFrame') return original(method as never, params as never);
    return Promise.resolve({ id: 'frame', tabId: 'tab', title: 'Desktop', width: 760, height: 900, at: Date.now(), base64: '' });
  }) as typeof client.call);
  vi.useFakeTimers(); writeExperiments(['theme-grain']);
  app = mount(RemoteBrowser, { target: document.body, props: { store, threadId: 't-trace' } }); await settle();
  const open = document.querySelector<HTMLButtonElement>('[data-testid=remote-browser-open]');
  expect(open).not.toBeNull();
  expect(document.querySelector('[data-testid=remote-browser-dialog]')).toBeNull();
  open!.click(); await settle();
  expect(document.querySelector('[data-testid=remote-browser-setup]')).not.toBeNull();
  await vi.advanceTimersByTimeAsync(2000); await settle();
  expect(calls).not.toHaveBeenCalled();
  expect(readExperiments()).toEqual(['theme-grain']);

  document.querySelector<HTMLButtonElement>('[data-testid=remote-browser-enable]')!.click(); await settle();
  await vi.advanceTimersByTimeAsync(1); await settle();
  expect(document.querySelector('[data-testid=remote-browser-setup]')).toBeNull();
  expect(calls).toHaveBeenCalledExactlyOnceWith('browser.remoteFrame', { threadId: 't-trace' });
  expect(JSON.parse(localStorage.getItem(EXPERIMENTS_STORAGE_KEY)!)).toEqual(['theme-grain', 'remote-browser']);
  expect(document.querySelector('[data-testid=remote-browser-frame]')).not.toBeNull();

  await unmount(app); app = undefined; calls.mockClear();
  app = mount(RemoteBrowser, { target: document.body, props: { store, threadId: 't-trace' } }); await settle();
  document.querySelector<HTMLButtonElement>('[data-testid=remote-browser-open]')!.click(); await settle();
  await vi.advanceTimersByTimeAsync(1); await settle();
  expect(document.querySelector('[data-testid=remote-browser-setup]')).toBeNull();
  expect(calls).toHaveBeenCalledExactlyOnceWith('browser.remoteFrame', { threadId: 't-trace' });
});

test('visibility changes do not flood the host; closing or disabling stops the stream', async () => {
  client = new FakeClient({ delayMs: 0 }); store = new Store(); store.attach(client); await store.connect();
  const original = client.call.bind(client), requests: number[] = [];
  vi.spyOn(client, 'call').mockImplementation(((method: string, params: unknown) => {
    if (method !== 'browser.remoteFrame') return original(method as never, params as never);
    requests.push(Date.now());
    return new Promise<unknown>(resolve => setTimeout(() => resolve({ id: 'frame', tabId: 'tab', title: 'Desktop', width: 760, height: 900, at: Date.now(), base64: '' }), 400));
  }) as typeof client.call);
  vi.useFakeTimers(); writeExperiments(['remote-browser']);
  app = mount(RemoteBrowser, { target: document.body, props: { store, threadId: 't-trace' } }); await settle();
  (document.querySelector('[data-testid=remote-browser-open]') as HTMLButtonElement).click(); await settle();
  await vi.advanceTimersByTimeAsync(1); await settle();
  expect(requests).toHaveLength(1);
  for (let i = 0; i < 5; i++) document.dispatchEvent(new Event('visibilitychange'));
  await vi.advanceTimersByTimeAsync(350); await settle();
  expect(requests).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(750); await settle();
  expect(requests.length).toBeGreaterThan(1);
  expect(requests.every((at, i) => i === 0 || at - requests[i - 1]! >= 300)).toBe(true);
  (document.querySelector('[data-testid=remote-browser-dialog] header button') as HTMLButtonElement).click(); await settle();
  const beforeClose = requests.length;
  await vi.advanceTimersByTimeAsync(2000); await settle();
  expect(requests).toHaveLength(beforeClose);
  (document.querySelector('[data-testid=remote-browser-open]') as HTMLButtonElement).click(); await settle();
  await vi.advanceTimersByTimeAsync(500); await settle();
  writeExperiments([]); await settle();
  const beforeDisable = requests.length;
  await vi.advanceTimersByTimeAsync(2000); await settle();
  expect(document.querySelector('[data-testid=remote-browser-dialog]')).toBeNull();
  expect(requests).toHaveLength(beforeDisable);
  document.querySelector<HTMLButtonElement>('[data-testid=remote-browser-open]')!.click(); await settle();
  expect(document.querySelector('[data-testid=remote-browser-setup]')).not.toBeNull();
  expect(document.querySelector('[data-testid=remote-browser-frame]')).toBeNull();
  await vi.advanceTimersByTimeAsync(2000); await settle();
  expect(requests).toHaveLength(beforeDisable);
});

test('phone resolution waits for a new frame; preview zoom stays local', async () => {
  client = new FakeClient({ delayMs: 0, principal: 'session' }); store = new Store(); store.attach(client); await store.connect();
  let width = 800, height = 600;
  const original = client.call.bind(client);
  const calls = vi.spyOn(client, 'call').mockImplementation(((method: string, params: any) => {
    if (method === 'browser.remoteFrame') return Promise.resolve({ id: `${width}`, tabId: 'browser:test', title: 'Desktop', width, height, at: Date.now(), base64: '' });
    if (method === 'browser.remoteInput') { if (params.input.kind === 'viewport') { width = params.input.width; height = params.input.height; } return Promise.resolve({ ok: true }); }
    return original(method as never, params as never);
  }) as typeof client.call);
  vi.useFakeTimers(); writeExperiments(['remote-browser']);
  app = mount(RemoteBrowser, { target: document.body, props: { store, threadId: 't-trace', surface: true } }); await settle();
  await vi.advanceTimersByTimeAsync(1); await settle();
  const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.trim() === text)!;
  document.querySelector<HTMLButtonElement>('[data-testid=remote-browser-display]')!.click(); await settle();
  button('Phone').click(); await settle();
  expect(calls).toHaveBeenCalledWith('browser.remoteInput', { threadId: 't-trace', frameId: '800', input: { kind: 'viewport', width: 393, height: 700 } });
  expect(document.querySelector('[data-testid=remote-browser-frame]')).toBeNull();
  await vi.advanceTimersByTimeAsync(301); await settle();
  expect(document.querySelector('[data-testid=remote-browser-frame]')).not.toBeNull();
  document.querySelector<HTMLButtonElement>('[data-testid=remote-browser-display]')!.click(); await settle();
  expect(document.querySelector('.display-settings strong')?.textContent).toContain('393 × 700');
  calls.mockClear(); button('150%').click(); await settle();
  expect(document.querySelector('.screen')?.getAttribute('style')).toContain('589.5px');
  expect(calls).not.toHaveBeenCalled();
});

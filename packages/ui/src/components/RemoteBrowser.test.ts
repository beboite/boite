import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { FakeClient } from '../lib/fake-client';
import { Store } from '../lib/store.svelte';
import { writeExperiments } from '../lib/experiments';
import RemoteBrowser from './RemoteBrowser.svelte';

let app: ReturnType<typeof mount> | undefined, client: FakeClient, store: Store;
test.each([-30000, 30000])('remote input uses local frame age despite a server clock offset of %i ms', async offset => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function(this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function(this: HTMLDialogElement) { this.open = false; } });
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  client = new FakeClient({ delayMs: 0 }); store = new Store(); store.attach(client); await store.connect();
  const original = client.call.bind(client);
  let delivered = false;
  const calls = vi.spyOn(client, 'call').mockImplementation(((method: string, params: unknown) => {
    if (method === 'browser.remoteFrame') {
      if (delivered) return new Promise(() => {}); // No fresh frame while the original ages.
      delivered = true;
      return Promise.resolve({ id: 'skewed', tabId: 'tab', title: 'Desktop', width: 760, height: 900, at: Date.now() + offset, base64: '' });
    }
    if (method === 'browser.remoteInput') return Promise.resolve({ ok: true });
    return original(method as never, params as never);
  }) as typeof client.call);
  vi.useFakeTimers(); writeExperiments(['remote-browser']);
  app = mount(RemoteBrowser, { target: document.body, props: { store, threadId: 't-trace' } }); await settle();
  document.querySelector<HTMLButtonElement>('[data-testid=remote-browser-open]')!.click(); await settle();
  await vi.advanceTimersByTimeAsync(1); await settle();
  const enter = [...document.querySelectorAll<HTMLButtonElement>('.keys button')].find(b => b.textContent === 'Enter')!;
  enter.click(); await settle();
  expect(calls).toHaveBeenCalledWith('browser.remoteInput', { threadId: 't-trace', frameId: 'skewed', input: { kind: 'key', key: 'Enter' } });
  calls.mockClear();
  await vi.advanceTimersByTimeAsync(5001); await settle();
  enter.click(); await settle();
  expect(calls.mock.calls.filter(([method]) => method === 'browser.remoteInput')).toHaveLength(0);
});
const settle = async () => { for (let i = 0; i < 20; i++) { await Promise.resolve(); flushSync(); } };
afterEach(async () => {
  if (app) await unmount(app); app = undefined;
  store?.detach(); client?.close(); vi.useRealTimers(); vi.restoreAllMocks();
  document.body.innerHTML = ''; writeExperiments([]); localStorage.clear();
});

test('visibility changes do not flood the host; closing or disabling stops the stream', async () => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function(this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function(this: HTMLDialogElement) { this.open = false; } });
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
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
});

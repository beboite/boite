import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { FakeClient } from '../lib/fake-client';
import { Store } from '../lib/store.svelte';
import { EXPERIMENTS_STORAGE_KEY, readExperiments, writeExperiments } from '../lib/experiments';
import { browserBridge } from '../lib/browser-bridge';
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

const frameAt = (id: string, extra: Record<string, unknown> = {}) => ({ id, tabId: 'browser:test', title: 'Desktop', width: 780, height: 600, at: Date.now(), base64: id === 'same' ? 'AAAA' : btoa(id), url: 'https://example.test/', ...extra });

test('a PC that is not showing the conversation is asked once to open it, then on demand', async () => {
  client = new FakeClient({ delayMs: 0, principal: 'session' }); store = new Store(); store.attach(client); await store.connect();
  const original = client.call.bind(client);
  let hosted = false, opens = 0;
  const calls = vi.spyOn(client, 'call').mockImplementation(((method: string, params: unknown) => {
    if (method === 'browser.remoteFrame') return hosted ? Promise.resolve(frameAt('f1')) : Promise.reject(new Error('Open this conversation in the Boite desktop app to share its browser.'));
    if (method === 'browser.remoteOpen') { opens++; return opens === 1 ? Promise.resolve({ ok: true }) : Promise.reject(new Error('No desktop is sharing its browser.')); }
    return original(method as never, params as never);
  }) as typeof client.call);
  vi.useFakeTimers(); writeExperiments(['remote-browser']);
  app = mount(RemoteBrowser, { target: document.body, props: { store, threadId: 't-trace' } }); await settle();
  document.querySelector<HTMLButtonElement>('[data-testid=remote-browser-open]')!.click(); await settle();
  await vi.advanceTimersByTimeAsync(1); await settle();
  expect(calls).toHaveBeenCalledWith('browser.remoteOpen', { threadId: 't-trace' });
  expect(document.querySelector('[data-testid=remote-browser-error]')?.textContent).toContain('Asking the PC');
  // The link is fine: the viewer waits for the PC rather than claiming to reconnect.
  expect(document.querySelector('[data-testid=remote-browser-dialog] .state')?.textContent).toBe('Waiting for the desktop');
  // Failing frames back off instead of flooding, and do not ask again by themselves.
  await vi.advanceTimersByTimeAsync(5000); await settle();
  expect(opens).toBe(1);
  expect(calls.mock.calls.filter(([method]) => method === 'browser.remoteFrame').length).toBeLessThan(6);
  // A PC that accepted but shows nothing is not waited on forever.
  await vi.advanceTimersByTimeAsync(12_000); await settle();
  expect(document.querySelector('[data-testid=remote-browser-error]')?.textContent).toContain('has not opened it');
  document.querySelector<HTMLButtonElement>('[data-testid=remote-browser-ask]')!.click(); await settle();
  expect(document.querySelector('[data-testid=remote-browser-error]')?.textContent).toContain('No PC is sharing');
  hosted = true;
  await vi.advanceTimersByTimeAsync(9000); await settle();
  expect(document.querySelector('[data-testid=remote-browser-frame]')).not.toBeNull();
  expect(document.querySelector('[data-testid=remote-browser-error]')).toBeNull();
  expect(document.querySelector<HTMLInputElement>('[data-testid=remote-browser-address]')!.value).toBe('https://example.test/');
});

test('the address bar, Return and erase on an empty field reach the page', async () => {
  client = new FakeClient({ delayMs: 0, principal: 'session' }); store = new Store(); store.attach(client); await store.connect();
  const original = client.call.bind(client), inputs: unknown[] = [];
  let n = 0;
  vi.spyOn(client, 'call').mockImplementation(((method: string, params: any) => {
    if (method === 'browser.remoteFrame') return Promise.resolve(frameAt(`f${++n}`));
    if (method === 'browser.remoteInput') { inputs.push(params.input); return Promise.resolve({ ok: true }); }
    return original(method as never, params as never);
  }) as typeof client.call);
  vi.useFakeTimers(); writeExperiments(['remote-browser']);
  app = mount(RemoteBrowser, { target: document.body, props: { store, threadId: 't-trace', surface: true } }); await settle();
  await vi.advanceTimersByTimeAsync(1); await settle();
  const address = document.querySelector<HTMLInputElement>('[data-testid=remote-browser-address]')!;
  address.value = 'example.org/docs'; address.dispatchEvent(new Event('input', { bubbles: true })); await settle();
  document.querySelector<HTMLFormElement>('[data-testid=remote-browser-nav]')!.requestSubmit(); await settle();
  expect(inputs).toEqual([{ kind: 'navigate', url: 'https://example.org/docs' }]);
  await vi.advanceTimersByTimeAsync(400); await settle();
  for (const label of ['Back', 'Forward', 'Reload']) {
    document.querySelector<HTMLButtonElement>(`[data-testid=remote-browser-nav] button[aria-label=${label}]`)!.click(); await settle();
    await vi.advanceTimersByTimeAsync(400); await settle();
  }
  expect(inputs.slice(1)).toEqual([{ kind: 'history', direction: 'back' }, { kind: 'history', direction: 'forward' }, { kind: 'reload' }]);
  inputs.length = 0;
  const field = document.querySelector<HTMLInputElement>('[data-testid=remote-browser-text]')!;
  field.value = 'hello'; field.dispatchEvent(new Event('input', { bubbles: true })); await settle();
  field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); await settle();
  expect(inputs).toEqual([{ kind: 'text', text: 'hello' }, { kind: 'key', key: 'Enter' }]);
  expect(field.value).toBe('');
  await vi.advanceTimersByTimeAsync(400); await settle();
  field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true })); await settle();
  expect(inputs.at(-1)).toEqual({ kind: 'key', key: 'Backspace' });
});

test('a drag scrolls continuously from where the finger started; a short touch taps', async () => {
  client = new FakeClient({ delayMs: 0, principal: 'session' }); store = new Store(); store.attach(client); await store.connect();
  const original = client.call.bind(client), inputs: any[] = [];
  let n = 0;
  vi.spyOn(client, 'call').mockImplementation(((method: string, params: any) => {
    if (method === 'browser.remoteFrame') return Promise.resolve(frameAt(`f${++n}`));
    if (method === 'browser.remoteInput') { inputs.push(params.input); return Promise.resolve({ ok: true }); }
    return original(method as never, params as never);
  }) as typeof client.call);
  Object.defineProperty(Element.prototype, 'setPointerCapture', { configurable: true, value: () => {} });
  vi.spyOn(HTMLImageElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 390, height: 300, right: 390, bottom: 300, x: 0, y: 0, toJSON() {} } as DOMRect);
  vi.useFakeTimers(); writeExperiments(['remote-browser']);
  app = mount(RemoteBrowser, { target: document.body, props: { store, threadId: 't-trace', surface: true } }); await settle();
  await vi.advanceTimersByTimeAsync(1); await settle();
  const screen = document.querySelector<HTMLButtonElement>('.screen')!;
  const pointer = (type: string, x: number, y: number) => screen.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true }));
  pointer('pointerdown', 97.5, 200); await settle();
  pointer('pointermove', 97.5, 195); await settle();
  expect(inputs).toHaveLength(0);
  pointer('pointermove', 97.5, 150); await settle();
  pointer('pointermove', 97.5, 120); await settle();
  pointer('pointerup', 97.5, 100); await settle();
  // Each move is sent as it comes, aimed where the finger started; together they cover the drag.
  expect(inputs.length).toBeGreaterThan(1);
  expect(inputs.every(i => i.kind === 'scroll' && i.x === 0 && i.at.x === 0.25 && i.at.y === 200 / 300)).toBe(true);
  expect(inputs.reduce((sum, i) => sum + i.y, 0)).toBe(200);
  await vi.advanceTimersByTimeAsync(400); await settle();
  inputs.length = 0;
  pointer('pointerdown', 195, 150); await settle();
  pointer('pointerup', 197, 151); await settle();
  expect(inputs).toEqual([{ kind: 'tap', x: 197 / 390, y: 151 / 300, width: 780, height: 600 }]);
});

test('a still page is polled slowly, and a phone back from the background resumes at once', async () => {
  client = new FakeClient({ delayMs: 0, principal: 'session' }); store = new Store(); store.attach(client); await store.connect();
  const original = client.call.bind(client), requests: number[] = [];
  vi.spyOn(client, 'call').mockImplementation(((method: string, params: unknown) => {
    if (method === 'browser.remoteFrame') { requests.push(Date.now()); return Promise.resolve(frameAt('same')); }
    return original(method as never, params as never);
  }) as typeof client.call);
  vi.useFakeTimers(); writeExperiments(['remote-browser']);
  app = mount(RemoteBrowser, { target: document.body, props: { store, threadId: 't-trace', surface: true } }); await settle();
  await vi.advanceTimersByTimeAsync(1); await settle();
  await vi.advanceTimersByTimeAsync(6000); await settle();
  const idle = requests.length;
  expect(idle).toBeLessThan(12);
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
  document.dispatchEvent(new Event('visibilitychange'));
  await vi.advanceTimersByTimeAsync(5000); await settle();
  expect(requests).toHaveLength(idle);
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  window.dispatchEvent(new Event('pageshow'));
  await vi.advanceTimersByTimeAsync(1); await settle();
  expect(requests).toHaveLength(idle + 1);
});

test('the desktop that hosts the browser offers no remote view of it; a paired device still does', async () => {
  (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Edg/140');
  const bridge = browserBridge as { protocol?: unknown };
  const protocol = bridge.protocol;
  bridge.protocol = vi.fn();
  try {
    writeExperiments(['remote-browser']);
    client = new FakeClient({ delayMs: 0 }); store = new Store(); store.attach(client); await store.connect();
    expect(store.owner).toBe(true);
    app = mount(RemoteBrowser, { target: document.body, props: { store, threadId: 't-trace' } }); await settle();
    expect(document.querySelector('[data-testid=remote-browser-open]')).toBeNull();
    await unmount(app); app = undefined; store.detach(); client.close();
    // The same shell connected to another machine as a paired device watches that machine's PC.
    client = new FakeClient({ delayMs: 0, principal: 'session' }); store = new Store(); store.attach(client); await store.connect();
    app = mount(RemoteBrowser, { target: document.body, props: { store, threadId: 't-trace' } }); await settle();
    expect(document.querySelector('[data-testid=remote-browser-open]')).not.toBeNull();
  } finally {
    bridge.protocol = protocol;
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  }
});
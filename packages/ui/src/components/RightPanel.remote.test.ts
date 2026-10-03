import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { RemoteBrowserFrame } from '@boite/contracts';
import { browserBridge } from '../lib/browser-bridge';
import { writeExperiments } from '../lib/experiments';
import { watchRemoteBrowser } from '../lib/remote-browser-watch.svelte';
import { FakeClient } from '../lib/fake-client';
import { rightPanel } from '../lib/right-panel.svelte';
import { Store } from '../lib/store.svelte';
import { work } from '../lib/work-prefs.svelte';
import RightPanel from './RightPanel.svelte';

let app: ReturnType<typeof mount> | undefined, store: Store;
const clients: FakeClient[] = [];
const settle = async () => { for (let i = 0; i < 20; i++) { await Promise.resolve(); flushSync(); } };
const frame = (title: string): RemoteBrowserFrame => ({ id: title, tabId: 'browser:tab', title, width: 760, height: 900, at: Date.now(), base64: 'YQ==' });
const button = (id: string) => document.querySelector<HTMLButtonElement>(`[data-testid=${id}]`)!;

beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function(this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function(this: HTMLDialogElement) { this.open = false; } });
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  writeExperiments([]); localStorage.clear(); rightPanel.load(); work.load(); work.setPanel('launcher');
});

afterEach(async () => {
  if (app) await unmount(app); app = undefined;
  store?.detach(); for (const client of clients.splice(0)) client.close();
  vi.useRealTimers(); vi.restoreAllMocks(); document.body.innerHTML = '';
  writeExperiments([]); localStorage.clear(); rightPanel.load(); work.load();
});

async function phone(open = true): Promise<FakeClient> {
  const client = new FakeClient({ delayMs: 0, principal: 'session' }); clients.push(client);
  store = new Store(); store.attach(client); await store.connect();
  if (open) await store.open('t-trace');
  store.panel.closeAll();
  return client;
}

async function showPanel(): Promise<void> {
  app = mount(RightPanel, { target: document.body, props: { store, panel: store.panel, attach: () => ({ destroy() {} }), onexit() {} } });
  await settle();
}

test('an agent tab on the PC shows up by itself on a paired phone and goes away with it', async () => {
  const client = await phone();
  expect(store.owner).toBe(false);
  expect(browserBridge.paints).toBe(false);
  let changed: ((event: { threadId: string; live: boolean }) => void) | undefined;
  const on = client.on.bind(client);
  vi.spyOn(client, 'on').mockImplementation(((name: string, handler: never) => {
    if (name === 'browser.remoteChanged') changed = handler;
    return on(name as never, handler);
  }) as typeof client.on);
  const original = client.call.bind(client), create = vi.spyOn(browserBridge, 'create');
  vi.spyOn(client, 'call').mockImplementation(((method: string, params: unknown) => {
    if (method === 'browser.remoteStatus') return Promise.resolve({ live: true });
    if (method === 'browser.remoteFrame') return Promise.resolve(frame('Agent page'));
    return original(method as never, params as never);
  }) as typeof client.call);
  vi.useFakeTimers(); await showPanel();
  // Nothing to open by hand: without an agent tab the card says the browser lives on the desktop.
  expect(button('launch-browser').disabled).toBe(true);
  // Changes and files are read-only on a phone; tasks and the trace stay the owner's.
  expect(button('launch-files').disabled).toBe(false);
  expect(button('launch-changes').disabled).toBe(false);
  expect(button('launch-tasks').disabled).toBe(true);
  const stop = watchRemoteBrowser(store, 't-trace'); await settle();
  expect(store.panel.active?.kind).toBe('browser');
  await vi.advanceTimersByTimeAsync(1); await settle();
  expect(document.querySelector('[data-testid=remote-browser-frame]')).not.toBeNull();
  // A tab the user closed stays closed for this agent tab, and the card brings it back.
  store.panel.close(store.panel.active!.id); await settle();
  changed!({ threadId: 't-trace', live: true }); await settle();
  expect(store.panel.surfaces).toHaveLength(0);
  expect(button('launch-browser').disabled).toBe(false);
  button('launch-browser').click(); await settle();
  expect(store.panel.active?.kind).toBe('browser');
  // The agent closes its tab: the view leaves; the next tab shows up again.
  changed!({ threadId: 't-trace', live: false }); await settle();
  expect(store.panel.surfaces).toHaveLength(0);
  expect(button('launch-browser').disabled).toBe(true);
  changed!({ threadId: 't-trace', live: true }); await settle();
  expect(store.panel.active?.kind).toBe('browser');
  stop();
  expect(create).not.toHaveBeenCalled();
});

test('the remote browser launcher requires a conversation', async () => {
  const client = await phone(false);
  store.openThread = null;
  const calls = vi.spyOn(client, 'call');
  await showPanel();
  expect(button('launch-browser').disabled).toBe(true);
  button('launch-browser').click(); await settle();
  expect(store.panel.surfaces).toHaveLength(0);
  expect(document.querySelector('[data-testid=remote-browser]')).toBeNull();
  expect(calls).not.toHaveBeenCalled();
});

test('an open viewer follows a replacement client without reusing old frames or pointer gestures', async () => {
  const oldClient = await phone();
  const nextClient = new FakeClient({ delayMs: 0, principal: 'session' }); clients.push(nextClient); await nextClient.connect();
  let resolveOld!: (value: RemoteBrowserFrame) => void;
  let captures = 0;
  const originalOld = oldClient.call.bind(oldClient), originalNext = nextClient.call.bind(nextClient);
  const oldCalls = vi.spyOn(oldClient, 'call').mockImplementation(((method: string, params: unknown) => {
    if (method !== 'browser.remoteFrame') return originalOld(method as never, params as never);
    if (++captures === 1) return Promise.resolve(frame('Original desktop'));
    return new Promise<RemoteBrowserFrame>(resolve => { resolveOld = resolve; });
  }) as typeof oldClient.call);
  const nextCalls = vi.spyOn(nextClient, 'call').mockImplementation(((method: string, params: unknown) => {
    if (method === 'browser.remoteInput') return Promise.resolve({ ok: true });
    if (method !== 'browser.remoteFrame') return originalNext(method as never, params as never);
    return Promise.resolve(frame('Replacement desktop'));
  }) as typeof nextClient.call);
  vi.useFakeTimers(); store.panel.open('browser'); await showPanel();
  await vi.advanceTimersByTimeAsync(1); await settle();
  expect(oldCalls).toHaveBeenCalledExactlyOnceWith('browser.remoteFrame', { threadId: 't-trace' });
  const screen = document.querySelector<HTMLButtonElement>('.screen')!;
  Object.defineProperty(screen, 'setPointerCapture', { configurable: true, value() {} });
  screen.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 20, clientY: 20 }));
  await vi.advanceTimersByTimeAsync(300); await settle();
  expect(captures).toBe(2);

  store.attach(nextClient); await settle();
  document.querySelector<HTMLButtonElement>('.keys button')!.click(); await settle();
  expect(nextCalls).not.toHaveBeenCalled();
  resolveOld(frame('Obsolete desktop')); await settle();
  expect(document.querySelector('[data-testid=remote-browser-frame]')).toBeNull();
  await vi.advanceTimersByTimeAsync(1800); await settle();
  // A moving page is polled several times a second; every request goes to the replacement.
  expect(nextCalls).toHaveBeenCalledWith('browser.remoteFrame', { threadId: 't-trace' });
  expect(nextCalls.mock.calls.every(([method]) => method === 'browser.remoteFrame')).toBe(true);
  expect(document.querySelector('[data-testid=remote-browser-frame]')).not.toBeNull();
  document.querySelector<HTMLButtonElement>('.screen')!.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0, clientX: 80, clientY: 80 }));
  await settle();
  expect(nextCalls.mock.calls.filter(([method]) => method === 'browser.remoteInput')).toHaveLength(0);
  document.querySelector<HTMLButtonElement>('.keys button')!.click(); await settle();
  expect(nextCalls).toHaveBeenCalledWith('browser.remoteInput', { threadId: 't-trace', frameId: 'Replacement desktop', input: { kind: 'scroll', x: 0, y: -500 } });
  await vi.advanceTimersByTimeAsync(700); await settle();
  expect(oldCalls.mock.calls.filter(([method]) => method === 'browser.remoteFrame')).toHaveLength(2);


});

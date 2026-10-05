import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { RemoteBrowserFrame } from '@boite/contracts';
import { browserBridge } from '../lib/browser-bridge';
import { watchAgentBrowser } from '../lib/agent-browser-watch';
import { FakeClient } from '../lib/fake-client';
import { liveViews } from '../lib/live-view.svelte';
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
  localStorage.clear(); rightPanel.load(); work.load(); work.setPanel('launcher'); liveViews.reset();
});

afterEach(async () => {
  if (app) await unmount(app); app = undefined;
  store?.detach(); for (const client of clients.splice(0)) client.close();
  vi.useRealTimers(); vi.restoreAllMocks(); document.body.innerHTML = '';
  localStorage.clear(); rightPanel.load(); work.load(); liveViews.reset();
});

async function phone(open = true): Promise<FakeClient> {
  const client = new FakeClient({ delayMs: 0, principal: 'session' }); clients.push(client);
  store = new Store(); store.attach(client); await store.connect();
  if (open) await store.open('t-trace');
  store.panel.closeAll();
  return client;
}

/** The conversation's agent, on the machine the phone watches. */
async function agent(client: FakeClient, url: string): Promise<string> {
  client.becomes('agent');
  try { return (await client.call('browser.command', { threadId: 't-trace', action: { kind: 'open', url } })).tabId!; }
  finally { client.becomes('session'); }
}

async function showPanel(): Promise<void> {
  app = mount(RightPanel, { target: document.body, props: { store, panel: store.panel, attach: () => ({ destroy() {} }), onexit() {} } });
  await settle();
}

test('a paired phone offers the agent browser, and only a tab the agent opens brings it forward, covered', async () => {
  const client = await phone();
  expect(store.owner).toBe(false);
  expect(browserBridge.paints).toBe(false);
  const calls = vi.spyOn(client, 'call');
  await showPanel();
  // The user's own browser needs the desktop shell; the agent's is watched from anywhere.
  expect(button('launch-browser').disabled).toBe(true);
  expect(button('launch-agent-browser').disabled).toBe(false);
  // Changes and files are read-only on a phone; tasks and the trace stay the owner's.
  expect(button('launch-files').disabled).toBe(false);
  expect(button('launch-tasks').disabled).toBe(true);

  // A tab already open when the conversation opens does not pull the panel out.
  await agent(client, 'https://example.com/docs');
  const stop = watchAgentBrowser(store, 't-trace'); await settle();
  expect(store.panel.surfaces).toHaveLength(0);
  // A new one does: the Agent browser tab, covered until the user shows it.
  await agent(client, 'https://shop.example/cart'); await settle();
  expect(store.panel.active?.kind).toBe('agent-browser');
  expect(button('agent-browser-cover-text').textContent).toContain('This agent controls a browser on');
  expect(document.querySelector('[data-testid=agent-browser-cover]')!.textContent).toContain('shop.example');
  expect(calls.mock.calls.some(([method]) => method === 'browser.remoteFrame')).toBe(false);
  // Closed by the user, it comes back as the same tab for the next page the agent opens.
  store.panel.close(store.panel.active!.id); await settle();
  await agent(client, 'https://example.com/third'); await settle();
  expect(store.panel.surfaces.filter(surface => surface.kind === 'agent-browser')).toHaveLength(1);
  expect(store.panel.active?.kind).toBe('agent-browser');
  stop();
});

test('an open viewer follows a replacement client without reusing old frames or pointer gestures', async () => {
  const oldClient = await phone();
  const nextClient = new FakeClient({ delayMs: 0, principal: 'session' }); clients.push(nextClient); await nextClient.connect();
  let resolveOld!: (value: RemoteBrowserFrame) => void;
  let captures = 0;
  const status = { live: true, available: true, tabs: [{ tabId: 'browser:tab', url: 'https://example.com/', title: 'Example', profile: 'default', active: true }] };
  const originalOld = oldClient.call.bind(oldClient), originalNext = nextClient.call.bind(nextClient);
  const oldCalls = vi.spyOn(oldClient, 'call').mockImplementation(((method: string, params: unknown) => {
    if (method === 'browser.remoteStatus') return Promise.resolve(status);
    if (method !== 'browser.remoteFrame') return originalOld(method as never, params as never);
    if (++captures === 1) return Promise.resolve(frame('Original machine'));
    return new Promise<RemoteBrowserFrame>(resolve => { resolveOld = resolve; });
  }) as typeof oldClient.call);
  const nextCalls = vi.spyOn(nextClient, 'call').mockImplementation(((method: string, params: unknown) => {
    if (method === 'browser.remoteStatus') return Promise.resolve(status);
    if (method === 'browser.remoteInput') return Promise.resolve({ ok: true });
    if (method !== 'browser.remoteFrame') return originalNext(method as never, params as never);
    return Promise.resolve(frame('Replacement machine'));
  }) as typeof nextClient.call);
  vi.useFakeTimers(); liveViews.show('agent-browser', store.threadKey('t-trace')); store.panel.open('agent-browser'); await showPanel();
  await vi.advanceTimersByTimeAsync(1); await settle();
  expect(oldCalls).toHaveBeenCalledWith('browser.remoteFrame', { threadId: 't-trace', tabId: 'browser:tab' });
  const screen = document.querySelector<HTMLButtonElement>('.screen')!;
  Object.defineProperty(screen, 'setPointerCapture', { configurable: true, value() {} });
  screen.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 20, clientY: 20 }));
  await vi.advanceTimersByTimeAsync(300); await settle();
  expect(captures).toBe(2);

  store.attach(nextClient); await settle();
  document.querySelector<HTMLButtonElement>('.keys button')!.click(); await settle();
  expect(nextCalls.mock.calls.filter(([method]) => method !== 'browser.remoteStatus')).toHaveLength(0);
  resolveOld(frame('Obsolete machine')); await settle();
  expect(document.querySelector('[data-testid=remote-browser-frame]')).toBeNull();
  await vi.advanceTimersByTimeAsync(1800); await settle();
  // A moving page is polled several times a second; every request goes to the replacement.
  expect(nextCalls).toHaveBeenCalledWith('browser.remoteFrame', { threadId: 't-trace', tabId: 'browser:tab' });
  expect(nextCalls.mock.calls.every(([method]) => method === 'browser.remoteFrame' || method === 'browser.remoteStatus')).toBe(true);
  expect(document.querySelector('[data-testid=remote-browser-frame]')).not.toBeNull();
  document.querySelector<HTMLButtonElement>('.screen')!.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0, clientX: 80, clientY: 80 }));
  await settle();
  expect(nextCalls.mock.calls.filter(([method]) => method === 'browser.remoteInput')).toHaveLength(0);
  document.querySelector<HTMLButtonElement>('.keys button')!.click(); await settle();
  expect(nextCalls).toHaveBeenCalledWith('browser.remoteInput', { threadId: 't-trace', frameId: 'Replacement machine', input: { kind: 'scroll', x: 0, y: -500 } });
  await vi.advanceTimersByTimeAsync(700); await settle();
  expect(oldCalls.mock.calls.filter(([method]) => method === 'browser.remoteFrame')).toHaveLength(2);
});

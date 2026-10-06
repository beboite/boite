import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { FakeClient } from '../lib/fake-client';
import { Store } from '../lib/store.svelte';
import { workspace } from '../lib/workspace.svelte';
import MobileNavigation from './MobileNavigation.svelte';

let mounted: ReturnType<typeof mount> | undefined;
let client: FakeClient;
let store: Store;
const previousActive = workspace.active;
const settle = async () => { for (let i = 0; i < 30; i++) { await Promise.resolve(); flushSync(); } };
afterEach(async () => {
  if (mounted) await unmount(mounted);
  mounted = undefined; store?.detach(); client?.close();
  workspace.machines = []; workspace.active = previousActive;
  vi.restoreAllMocks(); document.body.innerHTML = ''; localStorage.clear();
});

test('selecting a conversation beyond the first mobile window finishes loading its history', async () => {
  vi.spyOn(window, 'matchMedia').mockImplementation(media => Object.assign(new EventTarget(), {
    media, matches: true, onchange: null, addListener() {}, removeListener() {}
  }));
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(400);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const root = document.querySelector<HTMLElement>('[data-testid=mobile-list]');
    return new DOMRect(0, this === root ? 0 : -(root?.scrollTop ?? 0), 390, this.dataset.windowKey ? 77 : 400);
  });
  client = new FakeClient({ delayMs: 0 });
  store = new Store(); store.attach(client); await store.connect();
  const summary = store.threads[0]!;
  const history = await client.call('threads.get', { threadId: summary.id });
  expect(history.messages.length).toBeGreaterThan(0);
  store.threads = Array.from({ length: 1000 }, (_, index) => ({ ...summary, id: index === 999 ? summary.id : `offscreen-${index}`, updatedAt: 1000 - index }));
  workspace.machines = [{ id: 'local', label: 'Local', store }]; workspace.active = store;
  mounted = mount(MobileNavigation, { target: document.body, props: { store, screen: 'threads' } });
  await settle();
  const selector = `[data-testid="mobile-thread-${summary.id}"]`;
  expect(document.querySelector(selector)).toBeNull();
  const root = document.querySelector<HTMLElement>('[data-testid=mobile-list]')!;
  root.scrollTop = 76_600; root.dispatchEvent(new Event('scroll')); await settle();
  expect(document.querySelectorAll('[data-testid^=mobile-thread-]').length).toBeLessThan(50);
  const row = document.querySelector<HTMLButtonElement>(selector)!;
  expect(row).not.toBeNull(); row.click(); await settle();
  expect(store.openThread?.id).toBe(summary.id);
  expect(store.openThread?.messages).toEqual(history.messages);
  expect(store.loadingThreadId).toBeNull();
});

test('the logo goes back to the conversations, as Back does in a conversation', async () => {
  vi.spyOn(window, 'matchMedia').mockImplementation(media => Object.assign(new EventTarget(), {
    media, matches: true, onchange: null, addListener() {}, removeListener() {}
  }));
  client = new FakeClient({ delayMs: 0 });
  store = new Store(); store.attach(client); await store.connect();
  workspace.machines = [{ id: 'local', label: 'Local', store }]; workspace.active = store;
  mounted = mount(MobileNavigation, { target: document.body, props: { store, screen: 'activity' } });
  await settle();
  const list = () => document.querySelector('[data-testid=mobile-list]')?.getAttribute('aria-label');
  expect(list()).toBe('Activity');
  document.querySelector<HTMLButtonElement>('[data-testid=mobile-home]')!.click(); await settle();
  expect(list()).toBe('Conversations');
  store.showSettings('machines'); await settle();
  expect(list()).toBeUndefined();
  document.querySelector<HTMLButtonElement>('[data-testid=mobile-home]')!.click(); await settle();
  expect(store.page).toBe('chat');
  expect(list()).toBe('Conversations');
  await unmount(mounted); document.body.innerHTML = '';
  mounted = mount(MobileNavigation, { target: document.body, props: { store, screen: 'chat' } }); await settle();
  expect(document.querySelector('[data-testid=mobile-home]')).toBeNull();
  expect(document.querySelector('[data-testid=mobile-back]')).not.toBeNull();
});

test('a parent on another machine shows its working sub-agents, counted, and Recent filters what is at work', async () => {
  vi.spyOn(window, 'matchMedia').mockImplementation(media => Object.assign(new EventTarget(), {
    media, matches: true, onchange: null, addListener() {}, removeListener() {}
  }));
  client = new FakeClient({ delayMs: 0 });
  store = new Store(); store.attach(client); await store.connect();
  // The phone's own core is not the one the parent runs on: a second machine, not the active one.
  const remoteClient = new FakeClient({ delayMs: 0, coreId: 'fake-builder', coreName: 'Builder' });
  const remote = new Store(); remote.machineId = 'http://builder.test'; remote.visible = false;
  remote.attach(remoteClient); await remote.connect();
  try {
    const parent = remote.threads.find(t => !t.parentThreadId && !t.archived && t.projectId !== null && t.status === 'idle')!;
    const now = Date.now();
    remote.threads = [
      ...remote.threads.map(t => t.id === parent.id ? { ...t, unread: true, pinned: false, backgroundWork: null } : t),
      { ...parent, id: 'child-1', parentThreadId: parent.id, status: 'running', runningSince: now - 60_000, unread: false },
      { ...parent, id: 'child-2', parentThreadId: parent.id, status: 'queued', runningSince: null, unread: false }
    ];
    workspace.machines = [{ id: 'local', label: 'Local', store }, { id: remote.machineId, label: 'Builder', store: remote }];
    workspace.active = store;
    workspace.view = 'recent';
    mounted = mount(MobileNavigation, { target: document.body, props: { store, screen: 'threads' } });
    await settle();
    const state = () => document.querySelector<HTMLElement>(`[data-machine-id="${remote.machineId}"][data-thread-id="${parent.id}"] [data-testid=thread-state]`);
    expect(state()?.dataset['state']).toBe('delegating');
    expect(state()?.querySelector('[data-testid=thread-state-text]')?.textContent).toMatch(/^2 sub-agents · 1m/);
    expect(state()?.getAttribute('title')).toMatch(/^Waiting on 2 sub-agents/);
    // A child is never a row of its own.
    expect(document.querySelector('[data-thread-id="child-1"]')).toBeNull();

    const rows = () => [...document.querySelectorAll<HTMLElement>('.mobile-list .row')].map(row => row.dataset['threadId']);
    const everything = rows().length;
    expect(everything).toBeGreaterThan(1);
    const chip = () => document.querySelector<HTMLButtonElement>('[data-testid=mobile-at-work]');
    expect(chip()?.textContent).toBe('1 at work');
    expect(chip()?.getAttribute('aria-pressed')).toBe('false');
    chip()!.click(); await settle();
    expect(chip()?.getAttribute('aria-pressed')).toBe('true');
    expect(rows()).toEqual([parent.id]);

    // The Projects list reads the same store: the same radar there.
    workspace.view = 'projects'; await settle();
    expect(state()?.dataset['state']).toBe('delegating');
    workspace.view = 'recent'; await settle();

    // The last sub-agent ends: the parent is done, the chip and its filter go.
    for (const row of remote.threads) if (row.parentThreadId === parent.id) { row.status = 'idle'; row.runningSince = null; }
    await settle();
    expect(state()?.dataset['state']).toBe('done');
    expect(chip()).toBeNull();
    expect(rows().length).toBe(everything);
  } finally {
    remote.detach(); remoteClient.close();
  }
});
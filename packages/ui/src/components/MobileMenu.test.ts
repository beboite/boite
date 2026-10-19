import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { FakeClient } from '../lib/fake-client';
import { Store } from '../lib/store.svelte';
import { setExperiment } from '../lib/experiments';
import MobileMenu from './MobileMenu.svelte';

let app: ReturnType<typeof mount> | undefined, client: FakeClient, store: Store;
const settle = async () => { for (let i = 0; i < 15; i++) { await Promise.resolve(); flushSync(); } };
beforeEach(async () => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function(this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function(this: HTMLDialogElement) { this.open = false; } });
  client = new FakeClient({ delayMs: 0, principal: 'session' }); store = new Store(); store.attach(client); await store.connect();
});
afterEach(async () => { setExperiment('contacts', false); if (app) await unmount(app); app = undefined; store.detach(); client.close(); vi.restoreAllMocks(); document.body.innerHTML = ''; localStorage.clear(); });
const click = (id: string) => document.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!.click();

test('top menu gives access to every destination without a permanent bottom bar', async () => {
  const navigate = vi.fn();
  app = mount(MobileMenu, { target: document.body, props: { store, place: 'Computer', waiting: 2, screen: 'chat', navigate } }); await settle();
  expect(document.querySelector('nav')).toBeNull();
  for (const [id, destination] of [['mobile-conversations', 'threads'], ['mobile-activity', 'activity']]) {
    click('mobile-menu'); await settle(); click(id!); await settle();
    expect(navigate).toHaveBeenLastCalledWith(destination);
    expect(document.querySelector('dialog')).toBeNull();
  }
  click('mobile-menu'); await settle(); click('mobile-settings'); await settle();
  expect(store.page).toBe('settings'); expect(document.querySelector('dialog')).toBeNull();
  expect(document.querySelector('[data-testid="mobile-tabs"]')).toBeNull();
  // A project and a new thread are the header's: its picker and its +.
  click('mobile-menu'); await settle();
  expect(document.querySelector('[data-testid="mobile-menu-project"]')).toBeNull();
  expect(document.querySelector('[data-testid="mobile-menu-new"]')).toBeNull();
});

test('dismissing the menu leaves the draft and current destination untouched', async () => {
  const navigate = vi.fn();
  app = mount(MobileMenu, { target: document.body, props: { store, place: 'Computer', waiting: 0, screen: 'chat', navigate } }); await settle();
  click('mobile-menu'); await settle();
  document.querySelector('dialog')!.dispatchEvent(new Event('cancel', { cancelable: true })); await settle();
  expect(navigate).not.toHaveBeenCalled(); expect(store.page).toBe('chat');
  expect(document.querySelector('dialog')).toBeNull();
});

test('a paired device, which may call no contacts method, is offered no way into Contacts; the owner is', async () => {
  setExperiment('contacts', true);
  const navigate = vi.fn();
  app = mount(MobileMenu, { target: document.body, props: { store, place: 'Computer', waiting: 0, screen: 'chat', navigate } }); await settle();
  click('mobile-menu'); await settle();
  expect(document.querySelector('[data-testid="mobile-contacts"]')).toBeNull();
  store.showHome();
  expect(store.page).toBe('chat');
  await unmount(app); app = undefined; store.detach(); client.close();

  client = new FakeClient({ delayMs: 0 }); store = new Store(); store.attach(client); await store.connect();
  app = mount(MobileMenu, { target: document.body, props: { store, place: 'Computer', waiting: 0, screen: 'chat', navigate } }); await settle();
  click('mobile-menu'); await settle();
  click('mobile-contacts'); await settle();
  expect(store.page).toBe('home');
});

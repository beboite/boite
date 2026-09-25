import { afterEach, expect, test } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { FakeClient } from '../lib/fake-client';
import { Store } from '../lib/store.svelte';
import CoordinationPanel from './CoordinationPanel.svelte';

let component: ReturnType<typeof mount> | undefined;
let store: Store | undefined;
const settle = async () => { for (let index = 0; index < 20; index += 1) { await Promise.resolve(); flushSync(); } };

afterEach(async () => {
  if (component) await unmount(component);
  store?.client?.close();
  store?.detach();
  component = undefined;
  store = undefined;
  document.body.innerHTML = '';
});

async function show(principal: 'owner' | 'session' = 'owner'): Promise<Store> {
  store = new Store();
  store.attach(new FakeClient({ delayMs: 0, principal, coreId: `core-${principal}` }));
  await store.connect();
  await store.open('t-trace');
  component = mount(CoordinationPanel, { target: document.body, props: { store, threadId: 't-trace' } });
  await settle();
  return store;
}

test('an owner configures a thread and sees the hourly budgets', async () => {
  const active = await show();
  expect(active.coordination?.config.mode).toBe('off');
  expect(active.coordinationDirectory).toBeNull();
  const panel = document.querySelector<HTMLDetailsElement>('[data-testid="coordination-panel"]')!;
  panel.open = true;
  panel.dispatchEvent(new Event('toggle'));
  await settle();
  expect(active.coordinationDirectory).not.toBeNull();
  document.querySelector<HTMLButtonElement>('[data-testid="coordination-mode-brief"]')!.click();
  await settle();
  expect(active.coordination?.config.mode).toBe('brief');
  expect(document.querySelector('[data-testid="coordination-budget"]')?.textContent).toContain('6 sends');

  const resources = document.querySelector<HTMLTextAreaElement>('[data-testid="coordination-resources"]')!;
  resources.value = 'Owns the UI';
  resources.dispatchEvent(new Event('change', { bubbles: true }));
  await settle();
  expect(active.coordination?.config.resources).toBe('Owns the UI');

  document.querySelector<HTMLButtonElement>('[data-testid="coordination-pause"]')!.click();
  await settle();
  expect(active.coordination?.config.paused).toBe(true);
});

test('a contact shows its status in the words the app speaks, not the raw value', async () => {
  const active = await show();
  const panel = document.querySelector<HTMLDetailsElement>('[data-testid="coordination-panel"]')!;
  panel.open = true;
  panel.dispatchEvent(new Event('toggle'));
  await settle();
  document.querySelector<HTMLButtonElement>('[data-testid="coordination-mode-team"]')!.click();
  await settle();
  active.coordinationDirectory = {
    agents: [{ coreId: 'core-x', threadId: 't-x', title: 'Other', machine: 'box', resources: '', status: 'waiting', mode: 'team' }],
    unavailable: []
  };
  await settle();
  expect(document.querySelector('[data-testid="coordination-contact"] .contact-status')?.textContent).toBe('waiting for you');
});

test('a paired device reads coordination but cannot change it', async () => {
  await show('session');
  expect(document.querySelector<HTMLButtonElement>('[data-testid="coordination-mode-team"]')?.disabled).toBe(true);
  expect(document.body.textContent).toContain('Only the owner can change coordination');
});

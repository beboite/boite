import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { Account, ModelInfo } from '@boite/contracts';
import AccountSeats from './AccountSeats.svelte';
import App from '../App.svelte';
import { store } from '../lib/store.svelte';
import { closeTour } from '../lib/onboarding.svelte';
import { FIRST_MODELS } from '../lib/model-list';
import { FakeClient } from '../lib/fake-client';

/** A provider with hundreds of models opens on its first rows; a query or the show-all row reaches the rest. */

let running: Record<string, unknown> | null = null;

afterEach(() => {
  if (running) unmount(running, { outro: false });
  running = null;
  document.body.innerHTML = '';
  window.localStorage.clear();
  vi.restoreAllMocks();
});

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 2000; attempt++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`gave up waiting, body was:\n${document.body.textContent ?? ''}`);
}

const rows = () => document.querySelectorAll('[data-testid=composer-picker-menu] [data-model]').length;
const showAll = () => document.querySelector<HTMLButtonElement>('[data-testid=picker-show-all]');

test('account chips never reveal the login email in their tooltip', () => {
  const seats: Account[] = [
    { id: 'work', providerId: 'claude', label: 'Work', identity: 'work@example.com', isolationDir: '/accounts/work', status: 'ok', createdAt: 0 },
    { id: 'personal', providerId: 'claude', label: 'Personal', identity: 'personal@example.com', isolationDir: '/accounts/personal', status: 'unauthenticated', createdAt: 0 }
  ];
  running = mount(AccountSeats, { target: document.body, props: { shown: null, seats, shownAccountId: 'work', choice: null, locked: false, onpick: () => {} } });
  flushSync();
  const chips = [...document.querySelectorAll<HTMLButtonElement>('[data-seat]')];
  expect(chips.map(chip => chip.title)).toEqual(['Work', 'Personal']);
  expect(chips.map(chip => chip.textContent?.trim())).toEqual(['Work', 'Personal']);
});

test('a column of hundreds of models draws its first rows until asked for all', async () => {
  window.history.replaceState(null, '', '/?fake=1&open=recent');
  const target = document.createElement('div');
  document.body.appendChild(target);
  store.booted = false;
  store.openThread = null;
  store.draft = null;
  store.composerStates = {};
  closeTour();
  running = mount(App, { target });
  await waitFor(() => store.booted && (store.openThread !== null || store.draft !== null));

  const many: ModelInfo[] = Array.from({ length: 534 }, (_, index) => ({ id: `vendor${index % 4}/model-${index}`, name: `Model ${index}` }) as ModelInfo);
  const real = store.modelsOf.bind(store);
  vi.spyOn(store, 'modelsOf').mockImplementation((providerId, accountId) => (providerId === 'opencode' ? many : real(providerId, accountId)));

  document.querySelector<HTMLButtonElement>('[data-testid=new-thread]')!.click();
  await waitFor(() => store.draft !== null);
  document.querySelector<HTMLButtonElement>('[data-testid=composer-picker]')!.click();
  await waitFor(() => document.querySelector('[data-testid=composer-picker-menu]') !== null);
  document.querySelector<HTMLButtonElement>('[data-testid=composer-picker-menu] [data-provider=opencode]')!.click();
  await waitFor(() => document.querySelector('[data-testid=picker-search]') !== null && rows() > 0);

  // The pinned default, if any, sits above the first rows.
  expect(rows()).toBeLessThanOrEqual(FIRST_MODELS + 2);
  expect(showAll()!.textContent).toContain('534');

  // A query searches all of them.
  const search = document.querySelector<HTMLInputElement>('[data-testid=picker-search]')!;
  search.value = 'model-5';
  search.dispatchEvent(new Event('input', { bubbles: true }));
  await waitFor(() => document.querySelector('[data-model="vendor1/model-533"]') !== null);
  expect(showAll()).toBeNull();

  search.value = '';
  search.dispatchEvent(new Event('input', { bubbles: true }));
  await waitFor(() => showAll() !== null);
  showAll()!.click();
  await waitFor(() => rows() >= 534);
  expect(showAll()).toBeNull();
});

test('a first probe shows a reading column, never the descriptor list it is about to replace', async () => {
  // Every Claude probe waits for the test: the first one lands, the second one fails.
  const original = FakeClient.prototype.call;
  let outcome: 'wait' | 'land' | 'fail' = 'wait';
  vi.spyOn(FakeClient.prototype, 'call').mockImplementation(async function (this: FakeClient, method, params) {
    if (method === 'providers.probe' && (params as { providerId: string }).providerId === 'claude') {
      await waitFor(() => outcome !== 'wait');
      if (outcome === 'fail') throw new Error('claude did not answer');
    }
    return original.call(this, method, params) as never;
  });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  window.history.replaceState(null, '', '/?fake=1&open=recent');
  const target = document.createElement('div');
  document.body.appendChild(target);
  store.booted = false;
  store.openThread = null;
  store.draft = null;
  store.composerStates = {};
  closeTour();
  running = mount(App, { target });
  await waitFor(() => store.booted && (store.openThread !== null || store.draft !== null));
  document.querySelector<HTMLButtonElement>('[data-testid=new-thread]')!.click();
  await waitFor(() => store.draft !== null);

  const probing = () => document.querySelector('[data-testid=composer-picker-menu] [data-testid=picker-probing]');
  const legacyFold = () => document.querySelector('[data-testid=picker-legacy]');
  const openClaude = async () => {
    document.querySelector<HTMLButtonElement>('[data-testid=composer-picker]')!.click();
    await waitFor(() => document.querySelector('[data-testid=composer-picker-menu]') !== null);
    document.querySelector<HTMLButtonElement>('[data-testid=composer-picker-menu] [data-provider=claude]')!.click();
  };

  await openClaude();
  await waitFor(() => probing() !== null);
  expect(rows()).toBe(0);
  expect(legacyFold()).toBeNull();
  expect(document.querySelectorAll('[data-testid=composer-picker-menu] .skeleton').length).toBe(3);

  outcome = 'land';
  await waitFor(() => rows() > 0 && probing() === null);
  expect(document.querySelector('[data-model="claude-fable-5-1"]')).not.toBeNull();
  expect(legacyFold()).not.toBeNull();

  // The account changed, so its answer is gone; this time the agent fails and
  // the descriptor's list comes back instead of a column that reads forever.
  document.querySelector<HTMLButtonElement>('[data-testid=composer-picker]')!.click();
  await waitFor(() => document.querySelector('[data-testid=composer-picker-menu]') === null);
  outcome = 'wait';
  (store.client as FakeClient).announceLogin('a-claude-main');
  await waitFor(() => !store.probedModels['claude::a-claude-main']);
  await openClaude();
  await waitFor(() => probing() !== null);
  expect(rows()).toBe(0);
  outcome = 'fail';
  await waitFor(() => rows() > 0 && probing() === null);
  expect(document.querySelector('[data-model="claude-fable-5-1"]')).not.toBeNull();
  expect(legacyFold()).not.toBeNull();
  expect(store.probedModels['claude::a-claude-main']).toBeUndefined();
});

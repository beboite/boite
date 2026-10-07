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

afterEach(async () => {
  if (running) await unmount(running, { outro: false });
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

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function mountAt(open: 'landing' | 'recent'): Promise<FakeClient> {
  window.history.replaceState(null, '', `/?fake=1&open=${open}`);
  const target = document.createElement('div');
  document.body.appendChild(target);
  store.booted = false;
  store.openThread = null;
  store.draft = null;
  store.composerStates = {};
  closeTour();
  running = mount(App, { target });
  await waitFor(() => store.booted && (open === 'landing' ? store.draft !== null : store.openThread !== null || store.draft !== null));
  return store.client as FakeClient;
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
  await mountAt('recent');

  const many: ModelInfo[] = Array.from({ length: 534 }, (_, index) => ({ id: `vendor${index % 4}/model-${index}`, name: `Model ${index}` }) as ModelInfo);
  const real = store.modelsOf.bind(store);
  vi.spyOn(store, 'modelsOf').mockImplementation((providerId, accountId) => (providerId === 'opencode' ? many : real(providerId, accountId)));

  document.querySelector<HTMLButtonElement>('[data-testid=new-thread]')!.click();
  await waitFor(() => store.draft !== null);
  document.querySelector<HTMLButtonElement>('[data-testid=composer-picker]')!.click();
  await waitFor(() => document.querySelector('[data-testid=composer-picker-menu]') !== null);
  document.querySelector<HTMLButtonElement>('[data-testid=composer-picker-menu] [data-provider=opencode]')!.click();
  await waitFor(() => document.querySelector('[data-testid=picker-search]') !== null && showAll() !== null && rows() > 0);

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
  await mountAt('recent');
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
  // no descriptor placeholders appear after the reading state ends.
  document.querySelector<HTMLButtonElement>('[data-testid=composer-picker]')!.click();
  await waitFor(() => document.querySelector('[data-testid=composer-picker-menu]') === null);
  outcome = 'wait';
  (store.client as FakeClient).announceLogin('a-claude-main');
  await waitFor(() => !store.probedModels['claude::a-claude-main']);
  await openClaude();
  await waitFor(() => probing() !== null);
  expect(rows()).toBe(0);
  outcome = 'fail';
  await waitFor(() => document.querySelector('[data-testid=picker-no-models]') !== null && probing() === null);
  expect(rows()).toBe(0);
  expect(legacyFold()).toBeNull();
  expect(store.probedModels['claude::a-claude-main']).toBeUndefined();
  const search = document.querySelector<HTMLInputElement>('[data-testid=picker-search]')!;
  search.value = 'gpt';
  search.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
  expect(document.querySelectorAll('[data-testid=picker-no-models]')).toHaveLength(1);
  outcome = 'land';
  document.querySelector<HTMLButtonElement>('[data-testid=picker-refresh]')!.click();
  await waitFor(() => store.probedModels['claude::a-claude-main'] !== undefined && probing() === null);
  search.value = '';
  search.dispatchEvent(new Event('input', { bubbles: true }));
  await waitFor(() => rows() > 0);

});

test('a model probe that resolves after navigation cannot update the next thread or its remembered choice', async () => {
  const client = await mountAt('landing');
  await store.probeModels('claude', 'a-claude-main');
  const first = await client.call('threads.create', {
    projectId: 'p-boite', providerId: 'claude', accountId: 'a-claude-main', model: 'claude-sonnet-5-5', title: 'Picker source'
  });
  const next = await client.call('threads.create', {
    projectId: 'p-boite', providerId: 'claude', accountId: 'a-claude-main', model: 'claude-fable-5-1', title: 'Picker destination'
  });
  await waitFor(() => store.threads.some((thread) => thread.id === first.id) && store.threads.some((thread) => thread.id === next.id));
  await store.open(first.id);
  await waitFor(() => store.openThread?.id === first.id);

  let now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const gate = deferred();
  let heldProbes = 0;
  const original = FakeClient.prototype.call;
  vi.spyOn(FakeClient.prototype, 'call').mockImplementation(async function (this: FakeClient, method, params) {
    if (method === 'providers.probe' && (params as { accountId?: string }).accountId === 'a-claude-main') {
      heldProbes++;
      await gate.promise;
    }
    return original.call(this, method, params) as never;
  });

  try {
    const update = vi.spyOn(store, 'update');
    document.querySelector<HTMLButtonElement>('[data-testid=composer-picker]')!.click();
    await waitFor(() => document.querySelector('[data-testid=composer-picker-menu]') !== null && document.querySelector('[data-model="claude-opus-5-5"]') !== null);
    // Opening the picker reused the fresh catalog. Age it only after its rows
    // appeared, so the model click itself starts the held refresh.
    now += 5 * 60_000 + 1;
    document.querySelector<HTMLButtonElement>('[data-model="claude-opus-5-5"]')!.click();
    await waitFor(() => heldProbes === 1);

    await store.open(next.id);
    await waitFor(() => store.openThread?.id === next.id);
    const prefsAtDestination = { ...store.prefs };
    gate.resolve();
    await waitFor(() => !store.isProbing('claude', 'a-claude-main'));
    flushSync();

    expect(update.mock.calls.filter(([threadId]) => threadId === next.id)).toHaveLength(0);
    expect((await client.call('threads.get', { threadId: first.id })).model).toBe('claude-sonnet-5-5');
    expect((await client.call('threads.get', { threadId: next.id })).model).toBe('claude-fable-5-1');
    expect(store.openThread?.model).toBe('claude-fable-5-1');
    expect(store.prefs).toEqual(prefsAtDestination);
  } finally { gate.resolve(); }
});

test('a signed-in Claude seat is probed before its model and account are applied to a thread', async () => {
  const client = await mountAt('landing');
  await client.call('accounts.login', { accountId: 'a-claude-side' });
  await client.call('accounts.loginInput', { accountId: 'a-claude-side', text: 'test-code' });
  await waitFor(() => store.accountOf('a-claude-side')?.status === 'ok');
  await store.probeModels('claude', 'a-claude-main');
  const thread = await client.call('threads.create', {
    projectId: 'p-boite', providerId: 'claude', accountId: 'a-claude-main', model: 'claude-sonnet-5-5', title: 'Second seat picker'
  });
  await store.open(thread.id);
  await waitFor(() => store.openThread?.id === thread.id);

  const sideKey = 'claude::a-claude-side';
  expect(store.probedModels[sideKey]).toBeUndefined();
  const gate = deferred();
  const calls: { method: string; params: unknown }[] = [];
  const original = FakeClient.prototype.call;
  vi.spyOn(FakeClient.prototype, 'call').mockImplementation(async function (this: FakeClient, method, params) {
    if (method === 'providers.probe' && (params as { accountId?: string }).accountId === 'a-claude-side') {
      calls.push({ method, params });
      await gate.promise;
    }
    if (method === 'threads.update') calls.push({ method, params });
    return original.call(this, method, params) as never;
  });

  try {
    document.querySelector<HTMLButtonElement>('[data-testid=composer-picker]')!.click();
    await waitFor(() => document.querySelector('[data-testid=composer-picker-menu]') !== null && document.querySelector('[data-instance="claude::a-claude-side"]') !== null);
    const seat = document.querySelector<HTMLButtonElement>('[data-instance="claude::a-claude-side"]')!;
    expect(seat.disabled).toBe(false);
    seat.click();
    await waitFor(() => calls.some(({ method, params }) => method === 'providers.probe' && (params as { accountId?: string }).accountId === 'a-claude-side'));
    flushSync();

    expect(calls.some(({ method, params }) => method === 'providers.probe' && (params as { accountId?: string }).accountId === 'a-claude-side')).toBe(true);
    expect(calls.some(({ method, params }) => method === 'threads.update' && (params as { accountId?: string }).accountId === 'a-claude-side')).toBe(false);
    expect(store.openThread?.accountId).toBe('a-claude-main');
    expect(store.probedModels[sideKey]).toBeUndefined();
    expect(seat.disabled).toBe(true);

    gate.resolve();
    await waitFor(() => calls.some(({ method, params }) => method === 'threads.update' && (params as { accountId?: string }).accountId === 'a-claude-side') && store.openThread?.accountId === 'a-claude-side');
    expect(store.probedModels[sideKey]?.some((model) => model.id === store.openThread?.model)).toBe(true);
    const probeIndex = calls.findIndex(({ method, params }) => method === 'providers.probe' && (params as { accountId?: string }).accountId === 'a-claude-side');
    const updateIndex = calls.findIndex(({ method, params }) => method === 'threads.update' && (params as { accountId?: string }).accountId === 'a-claude-side');
    expect(probeIndex).toBeGreaterThanOrEqual(0);
    expect(updateIndex).toBeGreaterThan(probeIndex);
  } finally {
    gate.resolve();
  }
});

test('a provider turned off leaves the picker, its favorites and the draft that was on it', async () => {
  await mountAt('landing');
  const tiles = () => [...document.querySelectorAll('[data-testid=composer-picker-menu] .tile[data-provider]')]
    .map((tile) => tile.getAttribute('data-provider'))
    .filter((id) => id !== 'favorites' && id !== 'more');
  const trigger = () => document.querySelector<HTMLButtonElement>('[data-testid=composer-picker]')!;
  trigger().click();
  await waitFor(() => tiles().length > 1);
  const chosen = store.defaultChoice()!.providerId;
  const other = tiles().find((id) => id !== chosen)!;
  expect(tiles()).toContain(chosen);
  // An experimental provider nobody turned on was never offered.
  expect(tiles()).not.toContain('opencode-v2');

  expect(await store.setProviderEnabled(other, false)).toBe(true);
  await waitFor(() => !tiles().includes(other));
  expect(tiles()).toContain(chosen);

  // The provider the draft sits on: the composer moves to one that is still on.
  expect(await store.setProviderEnabled(chosen, false)).toBe(true);
  await waitFor(() => !tiles().includes(chosen));
  expect(store.defaultChoice()?.providerId).not.toBe(chosen);
  expect(store.offeredProviders.map((provider) => provider.id)).not.toContain(chosen);

  expect(await store.setProviderEnabled(other, true)).toBe(true);
  await waitFor(() => tiles().includes(other));
});

test('a thread whose provider is turned off says so beside the picker, and the chip leads to Providers', async () => {
  await mountAt('recent');
  await waitFor(() => store.openThread !== null);
  const chip = () => document.querySelector<HTMLButtonElement>('[data-testid=composer-provider-off]');
  expect(chip()).toBeNull();
  const provider = store.providerOf(store.openThread!.providerId)!;
  expect(await store.setProviderEnabled(provider.id, false)).toBe(true);
  await waitFor(() => chip() !== null);
  expect(chip()!.textContent).toBe('Turned off');
  expect(chip()!.title).toBe(`${provider.name} is turned off. Turn it on in Settings > Providers to continue this conversation.`);
  chip()!.click();
  await waitFor(() => store.page === 'settings' && store.settingsTab === 'accounts');
  store.showChat();
  expect(await store.setProviderEnabled(provider.id, true)).toBe(true);
  await waitFor(() => chip() === null);
});

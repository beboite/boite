import { afterEach, expect, test, vi } from 'vitest';
import { mount, unmount } from 'svelte';
import type { ModelInfo } from '@boite/contracts';
import App from '../App.svelte';
import { store } from '../lib/store.svelte';
import { closeTour } from '../lib/onboarding.svelte';
import { FIRST_MODELS } from '../lib/model-list';

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

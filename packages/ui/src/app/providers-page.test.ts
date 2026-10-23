import { expect, vi } from 'vitest';
import { store } from '../lib/store.svelte';
import { mountOnFake, openProviderDetails, query, shownModels, test, waitFor } from '../test/app';

vi.mock('@tauri-apps/plugin-opener', () => import('../test/opener'));

test('a provider Boite installs waits in Settings, one tile away, and joins the rail once signed in', async ({ app: _app }) => {
  // An open thread locks its provider; a draft is where another one can be picked.
  query<HTMLButtonElement>('[data-testid=new-thread]').click();
  await waitFor(() => store.draft !== null);
  query<HTMLButtonElement>('[data-testid=composer-picker]').click();
  await waitFor(() => document.querySelector('[data-testid=composer-picker-menu]') !== null);

  // Nothing is on the machine yet, so the rail leaves it out and its last
  // tile goes where it is installed and signed into.
  expect(document.querySelector('[data-testid=composer-picker-menu] [data-provider=antigravity]')).toBeNull();
  query<HTMLButtonElement>('[data-testid=picker-more-providers]').click();
  await waitFor(() => store.page === 'settings' && store.settingsTab === 'accounts');
  // The picker closed on the way out.
  await waitFor(() => document.querySelector('[data-testid=composer-picker-menu]') === null);

  // The fake ticks for about two seconds; installed is not yet signed in, so the rail still waits.
  await store.installProvider('antigravity');
  await waitFor(() => store.installOf('antigravity')?.state === 'installed');
  store.showChat();
  await waitFor(() => document.querySelector('[data-testid=composer-picker]') !== null);
  query<HTMLButtonElement>('[data-testid=composer-picker]').click();
  await waitFor(() => document.querySelector('[data-testid=composer-picker-menu]') !== null);
  expect(document.querySelector('[data-testid=composer-picker-menu] [data-provider=antigravity]')).toBeNull();

  // Signed in, it is one tile like any other, in the open rail too.
  store.accounts = store.accounts.map((account) => account.id === 'a-antigravity' ? { ...account, status: 'ok' as const } : account);
  await waitFor(() => document.querySelector('[data-testid=composer-picker-menu] [data-provider=antigravity]') !== null);
  query<HTMLButtonElement>('[data-testid=composer-picker-menu] [data-provider=antigravity]').click();
  // Its models are read once it is shown: Claude's leave the column first.
  await waitFor(() => shownModels().length > 0 && !shownModels().includes('claude-opus-5-5'));

  expect(shownModels()).not.toContain('default');
  query<HTMLButtonElement>('[data-testid=composer-picker-menu] [data-model]').click();
  await waitFor(() => document.querySelector('[data-testid=composer-picker-menu]') === null);
  expect(store.defaultChoice()?.providerId).toBe('antigravity');
});

test('Providers keeps installation details and updates the managed copy that runs', async () => {
  store.draft = null;
  await mountOnFake();
  query<HTMLButtonElement>('[data-testid=nav-settings]').click();
  await waitFor(() => document.querySelector('[data-testid=settings-tab-accounts]') !== null);
  // The nav entry is named after what the page is now about.
  expect(query('[data-testid=settings-tab-accounts]').textContent?.trim()).toBe('Providers');

  query<HTMLButtonElement>('[data-testid=settings-tab-accounts]').click();
  // One Antigravity row, the download Boite manages.
  const absent = '[data-testid=provider-settings][data-provider-id=antigravity]';
  await waitFor(() => document.querySelector(absent) !== null);
  expect(document.querySelectorAll(absent)).toHaveLength(1);

  // Nothing on the machine: the size rides in the words, the button is one verb.
  expect(query(absent).getAttribute('data-step')).toBe('install');
  expect(query(`${absent} [data-testid=provider-state]`).textContent?.trim()).toBe('Not installed · 447 MB');
  expect(query(`${absent} [data-testid=install-start]`).textContent?.trim()).toBe('Install');

  // The fake's OpenCode runs from the user's own install, so its own updater
  // owns the version and the row offers no Update beside it.
  const behind = '[data-testid=provider-settings][data-provider-id=opencode]';
  await waitFor(() => store.harnessUpdates.some((update) => update.providerId === 'opencode'));
  expect(store.harnessUpdates.find((update) => update.providerId === 'opencode')?.route).toBe('self');
  expect(document.querySelector(`${behind} [data-testid=install-update]`)).toBeNull();
  await waitFor(() => document.querySelector('[data-testid=machine-agent-update][data-provider-id=opencode]') !== null);
  expect(document.querySelector('[data-testid=machine-agent-update][data-provider-id=opencode] [data-testid=install-update]')).toBeNull();
  expect(query('[data-testid=machine-agent-update][data-provider-id=opencode] .version').textContent).toBe('1.18.31');

  // The provider's row says whose copy runs; its version and its update sit in the page's agent card.
  store.harnessUpdates = store.harnessUpdates.filter((update) => update.providerId !== 'opencode');
  await openProviderDetails('opencode');
  expect(query(`${behind} [data-testid=install-status]`).textContent?.trim()).toBe('Installed by Boite');
  expect(document.querySelector(`${behind} [data-testid=install-remove]`)).not.toBeNull();
  expect(document.querySelector(`${behind} [data-testid=install-update]`)).toBeNull();

  const update = '[data-testid=machine-agent-update][data-provider-id=opencode]';
  await waitFor(() => document.querySelector(`${update} [data-testid=install-update]`) !== null);
  expect(query(`${update} [data-testid=install-update]`).textContent?.trim()).toBe('Update');
  expect(query(update).textContent).toContain('0.4.12 → 0.5.0');

  // The update is the same download: the track and Cancel, the same a first install draws.
  query<HTMLButtonElement>(`${update} [data-testid=install-update]`).click();
  await waitFor(() => document.querySelector(`${update} [data-testid=install-progress]`) !== null);
  expect(document.querySelector(`${update} [data-testid=install-cancel]`)).not.toBeNull();

  await waitFor(
    () => store.installOf('opencode')?.state === 'installed' && document.querySelector(`${update} .version`)?.textContent?.trim() === '0.5.0'
  );
  expect(document.querySelector('[data-testid=install-update]')).toBeNull();

  // The store is one module-level singleton: leave the next test on the chat.
  query<HTMLButtonElement>('[data-testid=settings-back]').click();
  await waitFor(() => store.page === 'chat');
});

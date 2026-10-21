import { expect, vi } from 'vitest';
import { store } from '../lib/store.svelte';
import { effortDots, groupLabels, press, query, seats, shownModels, test, tiles, type, waitFor } from '../test/app';

vi.mock('@tauri-apps/plugin-opener', () => import('../test/opener'));

test('the picker rails the providers as logos and gives the shown one its accounts and models', async ({ app: _app }) => {
  await store.client!.call('accounts.login', { accountId: 'a-claude-side' });
  await store.client!.call('accounts.loginInput', { accountId: 'a-claude-side', text: 'test-code' });
  await waitFor(() => store.accountOf('a-claude-side')?.status === 'ok');
  query<HTMLButtonElement>('[data-testid=new-thread]').click();
  await waitFor(() => store.draft !== null);

  // A draft opens on the first available provider, its default model.
  await waitFor(() => query('[data-testid=composer-picker]').textContent?.includes('Opus 5.5') === true);

  query<HTMLButtonElement>('[data-testid=composer-picker]').click();
  await waitFor(() => document.querySelector('[data-testid=composer-picker-menu]') !== null);
  await waitFor(() => shownModels().length === 3);
  // One tile per provider an account answers for, in the core's order: the
  // one still to download or sign into is Settings' business, one tile away.
  expect(tiles()).toEqual(['favorites', 'claude', 'echo', 'opencode', 'codex', 'pi', 'grok', 'muse', 'more']);
  // Claude is the shown one and has two logins, so they sit beside its name.
  expect(seats()).toEqual(['claude::a-claude-main', 'claude::a-claude-side']);
  expect(shownModels()).toEqual(['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5']);

  // One account: nothing beside the name.
  query<HTMLButtonElement>('[data-testid=composer-picker-menu] [data-provider=echo]').click();
  await waitFor(() => shownModels().length === 1);
  expect(seats()).toEqual([]);

  query<HTMLButtonElement>('[data-testid=composer-picker-menu] [data-provider=claude]').click();
  await waitFor(() => shownModels().length === 3);
  query<HTMLButtonElement>('[data-testid=picker-legacy]').click();
  await waitFor(() => document.querySelectorAll('[data-model]').length === 7);

  // The second account of the same provider, then a model: one thread with both.
  query<HTMLButtonElement>('[data-instance="claude::a-claude-side"]').click();
  await waitFor(() => document.querySelector('[data-instance="claude::a-claude-side"]')?.getAttribute('aria-pressed') === 'true' &&
    store.probedModels['claude::a-claude-side'] !== undefined && document.querySelector('[data-model="claude-opus-5-5"]') !== null);
  query<HTMLButtonElement>('[data-model="claude-opus-5-5"]').click();
  await waitFor(() => document.querySelector('[data-testid=composer-picker-menu]') === null);
  expect(query('[data-testid=composer-picker]').textContent).toContain('Opus 5.5 · Second seat');

  const input = query<HTMLTextAreaElement>('[data-testid=composer-input]');
  input.value = 'On the second seat';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await waitFor(() => !query<HTMLButtonElement>('[data-testid=composer-send]').disabled);
  query<HTMLButtonElement>('[data-testid=composer-send]').click();
  await waitFor(() => store.openThread !== null && store.draft === null);
  expect(store.openThread?.accountId).toBe('a-claude-side');
  expect(store.openThread?.model).toBe('claude-opus-5-5');
});

test('the picker reads an ACP agent models, showing the descriptor and a probing line meanwhile', async ({ app: _app }) => {
  query<HTMLButtonElement>('[data-testid=new-thread]').click();
  await waitFor(() => store.draft !== null);
  await waitFor(() => query('[data-testid=composer-picker]').textContent?.includes('Opus 5.5') === true);

  query<HTMLButtonElement>('[data-testid=composer-picker]').click();
  await waitFor(() => document.querySelector('[data-testid=composer-picker-menu]') !== null);
  query<HTMLButtonElement>('[data-testid=composer-picker-menu] [data-provider=opencode]').click();

  // While the agent is being asked, its descriptor's one model stands.
  await waitFor(() => document.querySelector('[data-testid=picker-probing]') !== null);
  expect(shownModels()).toEqual([]);

  await waitFor(() => document.querySelector('[data-testid=picker-probing]') === null);
  // The agent lists more than the column shows at once; the first three are the ones it names first.
  expect(shownModels().length).toBe(22);
  expect(shownModels()).not.toContain('default');
  expect(shownModels()).toContain('openai/gpt-5-codex');

  query<HTMLButtonElement>('[data-model="openai/gpt-5-codex"]').click();
  await waitFor(() => document.querySelector('[data-testid=composer-picker-menu]') === null);
  expect(query('[data-testid=composer-picker]').textContent).toContain('GPT-5 Codex');

  // The reasoning scale comes from the same answer, not from the descriptor, and
  // it is the composer's own chip that carries it.
  await waitFor(() => document.querySelector('[data-testid=composer-effort]') !== null);
  await waitFor(() => document.querySelector('[data-testid=composer-effort]') !== null);
  query<HTMLButtonElement>('[data-testid=composer-effort]').click();
  await waitFor(() => document.querySelector('[data-testid=composer-effort-menu]') !== null);
  expect(effortDots()).toEqual(['think', 'think-hard']);
  press('Escape');
  await waitFor(() => document.querySelector('[data-testid=composer-effort-menu]') === null);

  // The probed model reaches the thread the first send creates.
  const input = query<HTMLTextAreaElement>('[data-testid=composer-input]');
  input.value = 'On the agent own model';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await waitFor(() => !query<HTMLButtonElement>('[data-testid=composer-send]').disabled);
  query<HTMLButtonElement>('[data-testid=composer-send]').click();
  await waitFor(() => store.openThread !== null && store.draft === null);
  expect(store.openThread?.model).toBe('openai/gpt-5-codex');
});

test('past twelve models the column gets a search field, prefix groups and keyboard picking', async ({ app: _app }) => {
  query<HTMLButtonElement>('[data-testid=new-thread]').click();
  await waitFor(() => store.draft !== null);
  await waitFor(() => query('[data-testid=composer-picker]').textContent?.includes('Opus 5.5') === true);

  query<HTMLButtonElement>('[data-testid=composer-picker]').click();
  await waitFor(() => document.querySelector('[data-testid=composer-picker-menu]') !== null);
  await waitFor(() => document.querySelector('[data-testid=picker-search]') !== null);
  // Search is available even on the shorter Claude list.
  expect(document.querySelector('[data-testid=picker-search]')).not.toBeNull();
  await type(query<HTMLInputElement>('[data-testid=picker-search]'), 'opus 4.8');
  await waitFor(() => shownModels().length === 1);
  expect(shownModels()).toEqual(['claude-opus-4-8']);
  expect(document.querySelector('[data-testid=picker-legacy]')).toBeNull();

  query<HTMLButtonElement>('[data-testid=composer-picker-menu] [data-provider=opencode]').click();
  await waitFor(() => document.querySelector('[data-testid=picker-probing]') === null);
  await waitFor(() => document.querySelector('[data-testid=picker-search]') !== null);
  await waitFor(() => shownModels().length === 22);
  expect(shownModels().length).toBe(22);
  expect(groupLabels().sort()).toEqual(['anthropic', 'nvidia', 'openai', 'opencode', 'openrouter']);
  // The column opens on a long list, so the field already has the caret.
  const search = query<HTMLInputElement>('[data-testid=picker-search]');
  expect(document.activeElement).toBe(search);

  await type(search, 'sonnet');
  await waitFor(() => shownModels().length === 3);
  // The agent's own default is pinned first whatever the query.
  expect(shownModels()).toEqual([
    'anthropic/claude-sonnet-5',
    'opencode/claude-sonnet-5',
    'openrouter/anthropic/claude-sonnet-4-5'
  ]);
  expect(groupLabels()).toEqual(['anthropic', 'opencode', 'openrouter']);

  // Down onto the first named match, Enter to take it.
  press('ArrowDown');
  expect((document.activeElement as HTMLElement).getAttribute('data-model')).toBe('anthropic/claude-sonnet-5');
  press('Enter');
  await waitFor(() => document.querySelector('[data-testid=composer-picker-menu]') === null);
  expect(query('[data-testid=composer-picker]').textContent).toContain('Sonnet 5');

  // A query nothing answers says so, and Escape clears it before it closes anything.
  query<HTMLButtonElement>('[data-testid=composer-picker]').click();
  await waitFor(() => document.querySelector('[data-testid=picker-search]') !== null);
  await type(query<HTMLInputElement>('[data-testid=picker-search]'), 'nothing here');
  await waitFor(() => document.querySelector('[data-testid=picker-no-models]') !== null);
  expect(shownModels()).toEqual([]);

  press('Escape');
  await waitFor(() => shownModels().length === 22);
  expect(document.querySelector('[data-testid=composer-picker-menu]')).not.toBeNull();
  expect(query<HTMLInputElement>('[data-testid=picker-search]').value).toBe('');

  press('Escape');
  await waitFor(() => document.querySelector('[data-testid=composer-picker-menu]') === null);

  // The searched model is the one the first send writes on the thread.
  const input = query<HTMLTextAreaElement>('[data-testid=composer-input]');
  input.value = 'On the model I searched for';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await waitFor(() => !query<HTMLButtonElement>('[data-testid=composer-send]').disabled);
  query<HTMLButtonElement>('[data-testid=composer-send]').click();
  await waitFor(() => store.openThread !== null && store.draft === null);
  expect(store.openThread?.model).toBe('anthropic/claude-sonnet-5');
});

test('the reasoning slider sets the effort of the picked model, and the chip follows', async ({ app: _app }) => {
  query<HTMLButtonElement>('[data-testid=new-thread]').click();
  await waitFor(() => store.draft !== null);
  await waitFor(() => query('[data-testid=composer-picker]').textContent?.includes('Opus 5.5') === true);

  await waitFor(() => document.querySelector('[data-testid=composer-effort]') !== null);
  query<HTMLButtonElement>('[data-testid=composer-effort]').click();
  await waitFor(() => document.querySelector('[data-testid=composer-effort-menu]') !== null);
  expect(effortDots()).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultrathink']);
  // Nothing chosen yet, so the model's own default reads as the active one.
  const track = query('[data-testid=effort-track]');
  expect(track.getAttribute('aria-valuenow')).toBe('2');
  expect(track.getAttribute('aria-valuetext')).toBe('High');

  query<HTMLButtonElement>('[data-testid=composer-effort-menu] [data-value=xhigh]').click();
  await waitFor(() => query('[data-testid=effort-track]').getAttribute('aria-valuenow') === '3');
  // Picking a level keeps the popover open: it is a setting of the model, not a choice of its own.
  expect(document.querySelector('[data-testid=composer-effort-menu]')).not.toBeNull();
  // The level reads on its own chip; the picker's label names the model alone.
  expect(query('[data-testid=composer-picker]').textContent).toContain('Opus 5.5');
  expect(query('[data-testid=composer-picker]').textContent).not.toContain('Xhigh');
  await waitFor(() => query('[data-testid=composer-effort]').textContent?.trim() === 'Xhigh');

  // The dots are filled up to the one that is live, and no further.
  const filled = Array.from(document.querySelectorAll('[data-dot]')).filter((dot) => dot.classList.contains('on'));
  expect(filled.map((dot) => dot.getAttribute('data-dot'))).toEqual(['low', 'medium', 'high', 'xhigh']);

  query<HTMLButtonElement>('[data-testid=composer-effort-menu] [data-value=high]').click();
  await waitFor(() => query('[data-testid=composer-effort]').textContent?.trim() === 'High');

  // The draft carries the effort into the thread the first send creates.
  query<HTMLButtonElement>('[data-testid=composer-effort-menu] [data-value=xhigh]').click();
  await waitFor(() => query('[data-testid=composer-effort]').textContent?.trim() === 'Xhigh');
  press('Escape');
  const input = query<HTMLTextAreaElement>('[data-testid=composer-input]');
  input.value = 'Think harder about the caps';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await waitFor(() => !query<HTMLButtonElement>('[data-testid=composer-send]').disabled);
  query<HTMLButtonElement>('[data-testid=composer-send]').click();
  await waitFor(() => store.openThread !== null && store.draft === null);
  expect(store.openThread?.effort).toBe('xhigh');
});

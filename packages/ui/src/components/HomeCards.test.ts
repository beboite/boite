import { afterEach, expect, test } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import HomeCards from './HomeCards.svelte';
import { FakeClient } from '../lib/fake-client';
import { Store } from '../lib/store.svelte';

let running: Record<string, unknown> | null = null;

afterEach(() => {
  if (running) unmount(running, { outro: false });
  running = null;
  document.body.innerHTML = '';
});

async function show(client: FakeClient): Promise<void> {
  const store = new Store();
  store.attach(client);
  await store.connect();
  running = mount(HomeCards, { target: document.body, props: { store } });
  flushSync();
  await new Promise(resolve => setTimeout(resolve, 0));
  flushSync();
}

test('a card shows its figures and rows, keeps details behind an "i", and its button refreshes it', async () => {
  const client = new FakeClient({ delayMs: 0, homeCardsDemo: true });
  await show(client);

  const card = document.querySelector('[data-testid=home-card]')!;
  expect(card.querySelector('h2')?.textContent).toBe('Release train');
  expect([...card.querySelectorAll('.stat')].map(stat => stat.textContent?.replace(/\s+/g, ' ').trim())).toEqual(['12 Shipped', '3 Ready', '2 Running', '0 Failing']);
  expect([...card.querySelectorAll('li')].map(row => row.textContent?.trim())).toEqual(['android-store', 'docs-site', 'cli-arm64', 'desktop-win', 'server-image']);
  // The detail is not on the page until its "i" is opened.
  expect(card.textContent).not.toContain('store review slot');
  expect(card.querySelectorAll('[data-testid=home-card-detail]')).toHaveLength(4);
  expect(card.querySelector('[data-testid=home-card-age]')?.textContent?.trim()).toMatch(/^Updated /);

  const updates: boolean[] = [];
  const off = client.on('homeCards.updated', cards => updates.push(cards[0]!.refresh!.running));
  card.querySelector<HTMLButtonElement>('[data-testid=home-card-refresh]')!.click();
  flushSync();
  await new Promise(resolve => setTimeout(resolve, 10));
  flushSync();
  off();
  expect(updates).toEqual([true, false]);
  expect(document.querySelector<HTMLButtonElement>('[data-testid=home-card-refresh]')!.disabled).toBe(false);
  await tick();
});

test('nothing shows without cards or on a core too old to have them', async () => {
  await show(new FakeClient({ delayMs: 0 }));
  expect(document.querySelector('[data-testid=home-cards]')).toBeNull();
  unmount(running!, { outro: false });
  running = null;

  await show(new FakeClient({ delayMs: 0, homeCardsDemo: true, missing: ['homeCards.list'] }));
  expect(document.querySelector('[data-testid=home-cards]')).toBeNull();
  expect(document.querySelector('[role=alert]')).toBeNull();
});

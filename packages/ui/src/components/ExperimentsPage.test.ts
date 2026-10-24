import { afterEach, beforeEach, expect, test } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import ExperimentsPage from './ExperimentsPage.svelte';
import { EXPERIMENTS_STORAGE_KEY } from '../lib/experiments';
import type { Store } from '../lib/store.svelte';

let running: Record<string, unknown> | null = null;

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  if (running) unmount(running, { outro: false });
  running = null;
  document.body.innerHTML = '';
  window.localStorage.clear();
});

function query<T extends Element>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`no ${selector}`);
  return node;
}

test('the page carries one switch per experiment and a toggle writes the enabled ids', async () => {
  running = mount(ExperimentsPage, { target: document.body });
  flushSync();
  await tick();

  // The page says these are unfinished before it offers anything.
  expect(query('[data-testid=experiments-page] > header h1').textContent?.trim()).toBe('Experiments');
  query<HTMLButtonElement>('[data-testid=experiments-page] > header [data-testid=info-tip]').click();
  flushSync();
  expect(query('[data-testid=info-tip-text]').textContent).toContain('unfinished');

  const grain = query<HTMLInputElement>('[data-testid=experiment-theme-grain]');
  expect(grain.checked).toBe(false);
  expect(grain.closest('label')?.textContent).toContain('Grain theme');
  expect(window.localStorage.getItem(EXPERIMENTS_STORAGE_KEY)).toBeNull();

  const links = query<HTMLInputElement>('[data-testid=experiment-open-chat-links]');
  expect(links.checked).toBe(false);
  const linksHelp = links.closest('label')!.querySelector<HTMLButtonElement>('[data-testid=info-tip]')!;
  linksHelp.click();
  flushSync();
  expect(document.getElementById(linksHelp.getAttribute('aria-describedby')!)?.textContent).toContain('default app');
  expect(links.checked).toBe(false);
  // Graduated features have their switch in the page they belong to, not here.
  expect(document.querySelector('[data-testid=experiment-chat-artifacts]')).toBeNull();

  grain.click();
  flushSync();
  await tick();

  expect(window.localStorage.getItem(EXPERIMENTS_STORAGE_KEY)).toBe('["theme-grain"]');
  expect(query<HTMLInputElement>('[data-testid=experiment-theme-grain]').checked).toBe(true);

  query<HTMLInputElement>('[data-testid=experiment-theme-grain]').click();
  flushSync();
  await tick();

  expect(window.localStorage.getItem(EXPERIMENTS_STORAGE_KEY)).toBe('[]');
  expect(query<HTMLInputElement>('[data-testid=experiment-theme-grain]').checked).toBe(false);
});

test('a click on a row name flips its switch, the "i" beside it only opens the tip', async () => {
  running = mount(ExperimentsPage, { target: document.body });
  flushSync();
  await tick();

  const grain = query<HTMLInputElement>('[data-testid=experiment-theme-grain]');
  const row = grain.closest('label')!;
  // The switch is named by its title alone, not by the button's label too.
  expect(document.getElementById(grain.getAttribute('aria-labelledby')!)?.textContent).toBe('Grain theme');

  row.querySelector<HTMLButtonElement>('[data-testid=info-tip]')!.click();
  flushSync();
  expect(grain.checked).toBe(false);
  expect(query('[data-testid=info-tip-text]').textContent).toBeTruthy();

  document.getElementById(grain.getAttribute('aria-labelledby')!)!.click();
  flushSync();
  await tick();
  expect(grain.checked).toBe(true);
  expect(window.localStorage.getItem(EXPERIMENTS_STORAGE_KEY)).toBe('["theme-grain"]');
});

test('a paired device sees the reviewed goals switch but no checklist model', async () => {
  // Only the owner may save the machine's settings: a paired device's pick would be refused.
  window.localStorage.setItem(EXPERIMENTS_STORAGE_KEY, '["goal2"]');
  const store = { owner: false, settings: { goalTracker: null }, providers: [], accountsOf: () => [], modelsOf: () => [], saveSettings: async () => true } as unknown as Store;
  running = mount(ExperimentsPage, { target: document.body, props: { store } });
  flushSync();
  await tick();
  expect(query<HTMLInputElement>('[data-testid=experiment-goal2]').checked).toBe(true);
  expect(document.querySelector('[data-testid=goal2-tracker]')).toBeNull();
});

test('the reviewed goals switch shows its checklist model only while it is on', async () => {
  const store = { owner: true, settings: { goalTracker: null }, providers: [], accountsOf: () => [], modelsOf: () => [], saveSettings: async () => true } as unknown as Store;
  running = mount(ExperimentsPage, { target: document.body, props: { store } });
  flushSync();
  await tick();
  expect(document.querySelector('[data-testid=goal2-tracker]')).toBeNull();

  query<HTMLInputElement>('[data-testid=experiment-goal2]').click();
  flushSync();
  await tick();
  // Right under its switch, the way a setting of that switch reads.
  const tracker = query('[data-testid=goal2-tracker]');
  expect(tracker.previousElementSibling?.querySelector('[data-testid=experiment-goal2]')).not.toBeNull();
  expect(tracker.textContent).toContain('Checklist model');
  expect(query('[data-testid=goal2-tracker-model]').textContent).toContain('Automatic');

  query<HTMLInputElement>('[data-testid=experiment-goal2]').click();
  flushSync();
  await tick();
  expect(document.querySelector('[data-testid=goal2-tracker]')).toBeNull();
});

test('the owner turns the live device stream on; a paired device does not see the switch', async () => {
  const saved: unknown[] = [];
  const store = { owner: true, settings: { deviceStream: false }, providers: [], accountsOf: () => [], modelsOf: () => [], saveSettings: async (patch: unknown) => { saved.push(patch); return true; } } as unknown as Store;
  running = mount(ExperimentsPage, { target: document.body, props: { store } });
  flushSync();
  await tick();
  const toggle = query<HTMLInputElement>('[data-testid=device-stream-on]');
  expect(toggle.checked).toBe(false);
  toggle.click();
  flushSync();
  await tick();
  expect(saved).toEqual([{ deviceStream: true }]);
  unmount(running);
  running = mount(ExperimentsPage, { target: document.body, props: { store: { ...store, owner: false } as unknown as Store } });
  flushSync();
  await tick();
  expect(document.querySelector('[data-testid=device-stream-settings]')).toBeNull();
});
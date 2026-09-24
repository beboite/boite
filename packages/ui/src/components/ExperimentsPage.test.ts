import { afterEach, beforeEach, expect, test } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import ExperimentsPage from './ExperimentsPage.svelte';
import { EXPERIMENTS_STORAGE_KEY } from '../lib/experiments';

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

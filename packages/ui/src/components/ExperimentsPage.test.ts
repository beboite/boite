import { afterEach, beforeEach, expect, onTestFinished, test } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import ExperimentsPage from './ExperimentsPage.svelte';
import { EXPERIMENTS_STORAGE_KEY, followDesktopOf, heardDesktop, isExperimentEnabled } from '../lib/experiments';
import { FakeClient } from '../lib/fake-client';
import { Store } from '../lib/store.svelte';

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

  const sessions = query<HTMLInputElement>('[data-testid=experiment-session-import]');
  expect(sessions.checked).toBe(false);
  const sessionsHelp = sessions.closest('label')!.querySelector<HTMLButtonElement>('[data-testid=info-tip]')!;
  sessionsHelp.click();
  flushSync();
  expect(document.getElementById(sessionsHelp.getAttribute('aria-describedby')!)?.textContent).toContain('terminal');
  expect(sessions.checked).toBe(false);
  // Graduated features have their switch in the page they belong to, not here.
  for (const id of ['chat-artifacts', 'open-chat-links', 'preview-comments', 'edge-scrollbars', 'press-preload', 'goal2']) {
    expect(document.querySelector(`[data-testid=experiment-${id}]`)).toBeNull();
  }

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

test('a stored list that still names goal2 loads the rest and drops it on the next save', async () => {
  window.localStorage.setItem(EXPERIMENTS_STORAGE_KEY, '["goal2","theme-grain"]');
  running = mount(ExperimentsPage, { target: document.body });
  flushSync();
  await tick();
  expect(query<HTMLInputElement>('[data-testid=experiment-theme-grain]').checked).toBe(true);
  query<HTMLInputElement>('[data-testid=experiment-whip]').click();
  flushSync();
  await tick();
  expect(window.localStorage.getItem(EXPERIMENTS_STORAGE_KEY)).toBe('["theme-grain","whip"]');
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

test('the owner turns the live device stream and background compaction on; a paired device does not see the switches', async () => {
  const saved: unknown[] = [];
  const store = { owner: true, settings: { deviceStream: false, backgroundCompaction: false }, providers: [], accountsOf: () => [], modelsOf: () => [], saveSettings: async (patch: unknown) => { saved.push(patch); return true; } } as unknown as Store;
  running = mount(ExperimentsPage, { target: document.body, props: { store } });
  flushSync();
  await tick();
  for (const id of ['device-stream-on', 'background-compaction-on']) {
    const toggle = query<HTMLInputElement>(`[data-testid=${id}]`);
    expect(toggle.checked).toBe(false);
    toggle.click();
    flushSync();
    await tick();
  }
  expect(saved).toEqual([{ deviceStream: true }, { backgroundCompaction: true }]);
  unmount(running);
  running = mount(ExperimentsPage, { target: document.body, props: { store: { ...store, owner: false } as unknown as Store } });
  flushSync();
  await tick();
  expect(document.querySelector('[data-testid=device-stream-settings]')).toBeNull();
  expect(document.querySelector('[data-testid=background-compaction-settings]')).toBeNull();
});
test('a phone has the desktop app\'s experiments until it flips one of its own, and can follow again', async () => {
  window.localStorage.setItem(EXPERIMENTS_STORAGE_KEY, '["theme-grain"]');
  const client = new FakeClient({ delayMs: 0 });
  const store = new Store();
  followDesktopOf(store);
  onTestFinished(() => { followDesktopOf(null); store.detach(); client.close(); });
  client.reportDesktopExperiments(['prompt-cache']);
  store.attach(client);
  await store.connect();
  const settle = async () => { for (let i = 0; i < 10; i++) { await Promise.resolve(); flushSync(); } };
  await settle();
  running = mount(ExperimentsPage, { target: document.body });
  await settle();
  const on = (id: string) => query<HTMLInputElement>(`[data-testid=experiment-${id}]`).checked;

  // The report's answer names the desktop app's switches; this phone's own wait underneath.
  expect(query<HTMLInputElement>('[data-testid=experiments-follow]').checked).toBe(true);
  expect([on('prompt-cache'), on('theme-grain')]).toEqual([true, false]);
  expect(isExperimentEnabled('prompt-cache')).toBe(true);
  // A flip on the desktop reaches the open page.
  client.reportDesktopExperiments(['prompt-cache', 'whip']);
  await settle();
  expect(on('whip')).toBe(true);
  // A second machine's desktop app is not the one followed.
  heardDesktop(new Store(), ['contacts']);
  expect(isExperimentEnabled('contacts')).toBe(false);

  // A flip here keeps what was shown, with it, as this phone's own.
  query<HTMLInputElement>('[data-testid=experiment-theme-grain]').click();
  await settle();
  expect(query<HTMLInputElement>('[data-testid=experiments-follow]').checked).toBe(false);
  expect(window.localStorage.getItem(EXPERIMENTS_STORAGE_KEY)).toBe('["theme-grain","prompt-cache","whip"]');
  client.reportDesktopExperiments(['contacts']);
  await settle();
  expect([on('contacts'), on('whip')]).toEqual([false, true]);

  query<HTMLInputElement>('[data-testid=experiments-follow]').click();
  await settle();
  expect([on('contacts'), on('whip'), on('theme-grain')]).toEqual([true, false, false]);
});

test('a core that has heard no desktop app keeps its own set, not another machine\'s', () => {
  window.localStorage.setItem(EXPERIMENTS_STORAGE_KEY, '["theme-grain"]');
  const owner = {};
  followDesktopOf(owner);
  onTestFinished(() => followDesktopOf(null));
  heardDesktop(owner, ['contacts'], 'core-a');
  heardDesktop(owner, null, 'core-a');
  expect(isExperimentEnabled('contacts')).toBe(true);
  heardDesktop(owner, null, 'core-b');
  expect([isExperimentEnabled('contacts'), isExperimentEnabled('theme-grain')]).toEqual([false, true]);
});

test('the desktop app follows no one', async () => {
  const shell = window as unknown as { __TAURI_INTERNALS__?: unknown };
  shell.__TAURI_INTERNALS__ = {};
  onTestFinished(() => { delete shell.__TAURI_INTERNALS__; followDesktopOf(null); });
  const owner = {};
  followDesktopOf(owner);
  heardDesktop(owner, ['whip']);
  running = mount(ExperimentsPage, { target: document.body });
  flushSync();
  await tick();
  expect(document.querySelector('[data-testid=experiments-follow]')).toBeNull();
  expect(query<HTMLInputElement>('[data-testid=experiment-whip]').checked).toBe(false);
});
test('Automatic goals is off by default; on, its threshold row sits under the switch and saves a valid length', async () => {
  const saved: unknown[] = [];
  const store = { owner: true, settings: {}, providers: [], accountsOf: () => [], modelsOf: () => [], saveSettings: async (patch: unknown) => { saved.push(patch); return true; } } as unknown as Store;
  running = mount(ExperimentsPage, { target: document.body, props: { store } });
  flushSync();
  await tick();
  const toggle = query<HTMLInputElement>('[data-testid=experiment-auto-goal]');
  expect(toggle.checked).toBe(false);
  expect(toggle.closest('label')?.textContent).toContain('Automatic goals');
  expect(document.querySelector('[data-testid=auto-goal-settings]')).toBeNull();

  toggle.click();
  flushSync();
  await tick();
  expect(window.localStorage.getItem(EXPERIMENTS_STORAGE_KEY)).toBe('["auto-goal"]');
  const row = query('[data-testid=auto-goal-settings]');
  expect(toggle.closest('label')!.nextElementSibling).toBe(row);
  const field = query<HTMLInputElement>('[data-testid=auto-goal-min-chars]');
  expect(field.value).toBe('1500');
  expect(row.textContent).toContain('Prompt length');

  field.value = '150';
  field.dispatchEvent(new Event('input', { bubbles: true }));
  field.dispatchEvent(new Event('change', { bubbles: true }));
  flushSync();
  await tick();
  expect(query('[data-testid=auto-goal-min-chars-error]').textContent).toContain('200 to 20000');
  expect(saved).toEqual([]);

  field.value = '800';
  field.dispatchEvent(new Event('input', { bubbles: true }));
  field.dispatchEvent(new Event('change', { bubbles: true }));
  flushSync();
  await tick();
  expect(saved).toEqual([{ autoGoalMinChars: 800 }]);

  // A paired device has the switch, never the core's threshold.
  unmount(running);
  running = mount(ExperimentsPage, { target: document.body, props: { store: { ...store, owner: false } as unknown as Store } });
  flushSync();
  await tick();
  expect(query<HTMLInputElement>('[data-testid=experiment-auto-goal]').checked).toBe(true);
  expect(document.querySelector('[data-testid=auto-goal-settings]')).toBeNull();
});

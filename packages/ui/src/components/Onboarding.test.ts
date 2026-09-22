import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import Onboarding from './Onboarding.svelte';
import { FakeClient } from '../lib/fake-client';
import { LOCALE_STORAGE_KEY, setLocaleSetting } from '../lib/i18n.svelte';
import { ONBOARDING_STORAGE_KEY, ONBOARDING_VERSION, readOnboarding, steps } from '../lib/onboarding';
import { closeTour, openTour, tourRequested, tourSeen } from '../lib/onboarding.svelte';
import { Store } from '../lib/store.svelte';
import { THEME_STORAGE_KEY } from '../lib/theme';
import { PREFS_STORAGE_KEY } from '../lib/prefs';
import { work, WORK_STORAGE_KEY } from '../lib/work-prefs.svelte';

/**
 * The tour: the screens it walks, the switches it carries, and the record it
 * leaves so it opens once. Every control here writes where the Settings page
 * writes, so the checks read the same storage the settings tests read.
 */

let running: Record<string, unknown> | null = null;
let store: Store;

beforeEach(async () => {
  window.localStorage.clear();
  work.load();
  store = new Store();
  store.attach(new FakeClient({ delayMs: 0 }));
  await store.connect();
});

afterEach(() => {
  if (running) unmount(running, { outro: false });
  running = null;
  document.body.innerHTML = '';
  window.localStorage.clear();
  setLocaleSetting('system');
  delete document.documentElement.dataset.theme;
  vi.restoreAllMocks();
  store.detach();
});

function query<T extends Element>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`no ${selector}`);
  return node;
}

function step(): string {
  return query<HTMLElement>('[data-testid=onboarding-step]').dataset['step'] ?? '';
}

async function open(): Promise<void> {
  running = mount(Onboarding, { target: document.body, props: { store } });
  flushSync();
  await tick();
}

async function click(testid: string): Promise<void> {
  query<HTMLButtonElement>(`[data-testid=${testid}]`).click();
  flushSync();
  await tick();
}

/** Leaving plays the exit first: the record lands once the overlay is gone. */
async function settle(): Promise<void> {
  await tick();
  flushSync();
  await tick();
}

test('demo artwork stays English while the surrounding tour stays French', async () => {
  setLocaleSetting('fr');
  await open();
  await click('onboarding-dot-agents');
  await click('onboarding-example-voice');
  expect(query('[data-testid=onboarding-animation]').textContent).toContain('Build my portfolio');
  await click('onboarding-animation-pause');
  expect(query('[data-testid=onboarding-animation-pause]').textContent).toContain('Reprendre');
  expect(query('[data-testid=onboarding-animation-replay]').textContent).toContain('Rejouer');
  expect(query('[data-testid=onboarding-next]').textContent).toContain('Suivant');
});

test('the tour walks its screens, the dots follow, and the last one closes it', async () => {
  const screens = steps();
  await open();

  expect(step()).toBe('welcome');
  expect(document.querySelector('header .count')).toBeNull();
  expect(query<HTMLButtonElement>('[data-testid=onboarding-back]').disabled).toBe(true);
  expect(document.querySelectorAll('.dots .dot').length).toBe(screens.length);

  for (let at = 1; at < screens.length; at++) {
    await click('onboarding-next');
    expect(step()).toBe(screens[at]);
    expect(query(`[data-testid=onboarding-dot-${screens[at]}]`).getAttribute('aria-current')).toBe('step');
  }

  // The last screen sends the user into the app rather than to another one.
  expect(query('[data-testid=onboarding-next]').textContent?.trim()).toBe("Let's Boite");
  expect(readOnboarding()).toBeNull();

  await click('onboarding-next');
  await settle();

  expect(document.querySelector('[data-testid=onboarding]')).toBeNull();
  expect(tourSeen()).toBe(true);
  expect(JSON.parse(window.localStorage.getItem(ONBOARDING_STORAGE_KEY) ?? 'null')).toMatchObject({ version: ONBOARDING_VERSION });
});

test('a dot jumps to its screen and Back walks the way it came', async () => {
  await open();

  await click('onboarding-dot-reach');
  expect(step()).toBe('reach');

  await click('onboarding-back');
  expect(step()).toBe('usage');
});

test('the language switch changes the tour it is on, and the choice is the settings one', async () => {
  await open();

  expect(query('[data-testid=onboarding-next]').textContent?.trim()).toBe('Next');

  await click('onboarding-locale-fr');

  expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('fr');
  expect(document.documentElement.lang).toBe('fr');
  expect(query('[data-testid=onboarding-next]').textContent?.trim()).toBe('Suivant');
  expect(query('[data-testid=onboarding-locale-fr]').getAttribute('aria-pressed')).toBe('true');

  await click('onboarding-locale-system');
  expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('system');
  expect(query('[data-testid=onboarding-next]').textContent?.trim()).toBe('Next');
});

test('the theme switch writes the same key the appearance page writes', async () => {
  await open();

  await click('onboarding-theme-light');

  expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
  expect(document.documentElement.dataset.theme).toBe('light');
  expect(query('[data-testid=onboarding-theme-light]').getAttribute('aria-pressed')).toBe('true');
});

test('Escape leaves the tour, and the device remembers it either way', async () => {
  await open();
  expect(document.querySelector('[data-testid=onboarding]')).not.toBeNull();

  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  flushSync();
  await settle();

  expect(document.querySelector('[data-testid=onboarding]')).toBeNull();
  expect(tourSeen()).toBe(true);
  expect(window.localStorage.getItem(ONBOARDING_STORAGE_KEY)).not.toBeNull();
});

test('usage and reach explain themselves without delayed account lists or exits', async () => {
  await open();
  await click('onboarding-dot-usage');

  await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync();
  await tick();
  const switches = document.querySelectorAll('[data-testid^=onboarding-quota-]');
  expect(switches.length).toBe(0);
  expect(document.body.textContent).toContain('24% used');
  expect(document.body.textContent).toContain('5-hour limit');
  expect(document.body.textContent).toContain('beside the clock');

  await click('onboarding-dot-reach');
  expect(document.querySelector('[data-testid=onboarding-pair]')).toBeNull();
  expect(document.querySelector('[data-testid=onboarding-machines]')).toBeNull();
  expect(readOnboarding()).toBeNull();
});

test('the voice screen says where the core stands instead of describing dictation in the air', async () => {
  await open();
  await click('onboarding-dot-agents');
  await click('onboarding-example-voice');

  // The fake core answers `speech.status` with an engine already installed.
  await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync();
  await tick();

  expect(query('[data-testid=onboarding-voice-ready]').textContent).toContain('Dictation is ready');
  expect(document.querySelector('[data-testid=onboarding-voice]')).toBeNull();
});

test('the panel example shows changes beside chat instead of a keybinding list', async () => {
  await open();
  await click('onboarding-dot-agents');
  await click('onboarding-example-panel');

  const keys = [...document.querySelectorAll('[data-testid=onboarding-step] kbd')].map((node) => node.textContent?.trim());
  expect(keys).toEqual([]);
  expect(query('[data-testid=onboarding-scene]').getAttribute('data-scene')).toBe('panel');
  expect(readOnboarding()).toBeNull();
});

test('demo choices are labelled buttons and dictation keeps word spacing', async () => {
  await open();
  await click('onboarding-dot-agents');
  for (const demo of ['agents', 'voice', 'panel']) {
    expect(query(`[data-testid=onboarding-example-${demo}]`).tagName).toBe('BUTTON');
  }
  await click('onboarding-example-voice');
  expect(query('[data-testid=onboarding-scene]').textContent).toContain('Make the buttons easier to read');
  expect(query('[data-testid=onboarding-scene]').textContent).not.toContain('Illustration');
  expect(query('[data-testid=onboarding-animation-replay]').textContent).toContain('Replay');
});

test('skipping at the first screen counts as seen, the same as finishing it', async () => {
  await open();
  expect(step()).toBe('welcome');

  await click('onboarding-skip');
  await settle();

  expect(document.querySelector('[data-testid=onboarding]')).toBeNull();
  expect(tourSeen()).toBe(true);
  expect(readOnboarding()?.version).toBe(ONBOARDING_VERSION);
  // Asking for it again puts it back without forgetting that it was seen.
  openTour();
  expect(tourRequested()).toBe(true);
  closeTour();
  expect(tourSeen()).toBe(true);
});

test('losing owner access on the last screen keeps the step and count valid', async () => {
  await open();
  await click('onboarding-dot-privacy');
  store.principal = 'session';
  flushSync();
  await tick();
  expect(step()).toBe('quiet');
  expect(document.querySelectorAll('.dots .dot')).toHaveLength(6);
});

test('continuing the privacy step keeps basic counters without opting into details', async () => {
  await open();
  await click('onboarding-dot-privacy');
  await new Promise(resolve => setTimeout(resolve, 0));
  flushSync();
  const inputs = [...document.querySelectorAll<HTMLInputElement>('[data-testid=telemetry-settings] input')];
  expect(inputs.map(input => input.checked)).toEqual([true, false]);
  await click('onboarding-next');
  expect(await store.client!.call('telemetry.state', {})).toMatchObject({ mode: 'basic' });
});

test('the privacy switch opts in explicitly and replay preserves a saved opt-out', async () => {
  await open();
  await click('onboarding-dot-privacy');
  await new Promise(resolve => setTimeout(resolve, 0));
  flushSync();
  const inputs = document.querySelectorAll<HTMLInputElement>('[data-testid=telemetry-settings] input');
  inputs[1]!.click();
  await new Promise(resolve => setTimeout(resolve, 0));
  flushSync();
  expect(await store.client!.call('telemetry.state', {})).toMatchObject({ mode: 'enhanced' });
  await store.client!.call('telemetry.configure', { mode: 'off' });
  await click('onboarding-dot-welcome');
  await click('onboarding-dot-privacy');
  await new Promise(resolve => setTimeout(resolve, 0));
  flushSync();
  expect([...document.querySelectorAll<HTMLInputElement>('[data-testid=telemetry-settings] input')].map(input => input.checked)).toEqual([false, false]);
});

test('an accidental opt-out can be reversed while deletion is pending, without data-management buttons', async () => {
  await store.client!.call('telemetry.configure', { mode: 'enhanced' });
  await open();
  await click('onboarding-dot-privacy');
  await new Promise(resolve => setTimeout(resolve, 0)); flushSync();
  query<HTMLInputElement>('[data-testid=telemetry-settings] input').click();
  await new Promise(resolve => setTimeout(resolve, 0)); flushSync();
  expect(await store.client!.call('telemetry.state', {})).toMatchObject({ mode: 'off', pendingDeletion: true });
  const enhanced = document.querySelectorAll<HTMLInputElement>('[data-testid=telemetry-settings] input')[1]!;
  expect(enhanced.disabled).toBe(false);
  enhanced.click();
  await new Promise(resolve => setTimeout(resolve, 0)); flushSync();
  expect(await store.client!.call('telemetry.state', {})).toMatchObject({ mode: 'enhanced', pendingDeletion: true });
  expect(document.querySelector('[data-testid=telemetry-settings] button')).toBeNull();
  expect(document.querySelector('[data-testid=onboarding]')).not.toBeNull();
});

test('voice setup failures stay in the tour and preserve their message across status reads', async () => {
  const client = store.client!;
  const call = client.call.bind(client);
  const calls: string[] = [];
  vi.spyOn(client, 'call').mockImplementation((async (method: string, params: never) => {
    calls.push(method);
    if (method === 'speech.status') return { ready: false, localReady: false, installing: false, canInstallRuntime: true, engine: 'local' };
    if (method === 'speech.install') throw new Error('download unavailable');
    return call(method as never, params);
  }) as typeof client.call);
  await open();
  await click('onboarding-dot-agents');
  await click('onboarding-example-voice');
  await new Promise(resolve => setTimeout(resolve, 0)); flushSync();
  expect(calls).not.toContain('speech.install');
  await click('onboarding-voice-install');
  await new Promise(resolve => setTimeout(resolve, 0)); flushSync();
  expect(query('[role=alert]').textContent).toContain('download unavailable');
  expect(document.querySelector('[data-testid=onboarding]')).not.toBeNull();
  expect(store.page).not.toBe('settings');
  await click('onboarding-next');
  expect(step()).toBe('usage');
});

test('focus stays in the dialog and navigation focuses its new heading', async () => {
  await open();
  await click('onboarding-next');
  await settle();
  expect(document.activeElement).toBe(query('h1'));
  query<HTMLButtonElement>('[data-testid=onboarding-next]').focus();
  document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
  expect(document.activeElement).toBe(query('[data-testid=onboarding-skip]'));
  document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
  expect(document.activeElement).toBe(query('[data-testid=onboarding-next]'));
});

test('the second screen asks who is using Boite and writes the preset at once', async () => {
  await open();
  await click('onboarding-next');
  expect(step()).toBe('profile');
  expect(query('[data-testid=onboarding-profile-everyday]').textContent).toContain("I'm not a developer! Don't confuse me with code and commands!");
  expect(query('[data-testid=onboarding-profile-developer]').textContent).toContain("I'm a developer, give me the works.");

  store.prefs = { ...store.prefs, permissionMode: 'bypassPermissions' };
  await click('onboarding-profile-everyday');
  expect(query('[data-testid=onboarding-profile-everyday]').getAttribute('aria-pressed')).toBe('true');
  expect(JSON.parse(window.localStorage.getItem(WORK_STORAGE_KEY) ?? 'null')).toEqual({ profile: 'everyday', pins: { effort: false, worktree: false }, startIn: 'drafts', panel: 'files' });
  // The everyday answer asks before each action.
  expect(JSON.parse(window.localStorage.getItem(PREFS_STORAGE_KEY) ?? 'null')).toMatchObject({ permissionMode: 'default' });

  // Changing the answer rewrites the whole preset, and skipping keeps it.
  await click('onboarding-profile-developer');
  expect(query('[data-testid=onboarding-profile-everyday]').getAttribute('aria-pressed')).toBe('false');
  await click('onboarding-skip');
  await settle();
  expect(JSON.parse(window.localStorage.getItem(WORK_STORAGE_KEY) ?? 'null')).toEqual({ profile: 'developer', pins: { effort: true, worktree: true }, startIn: 'project', panel: 'changes' });
});

import { afterEach, beforeEach, expect, test } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import Onboarding from './Onboarding.svelte';
import { FakeClient } from '../lib/fake-client';
import { LOCALE_STORAGE_KEY, setLocaleSetting } from '../lib/i18n.svelte';
import { ONBOARDING_STORAGE_KEY, ONBOARDING_VERSION, readOnboarding, steps } from '../lib/onboarding';
import { closeTour, openTour, tourRequested, tourSeen } from '../lib/onboarding.svelte';
import { Store } from '../lib/store.svelte';
import { THEME_STORAGE_KEY } from '../lib/theme';

/**
 * The tour: the screens it walks, the switches it carries, and the record it
 * leaves so it opens once. Every control here writes where the Settings page
 * writes, so the checks read the same storage the settings tests read.
 */

let running: Record<string, unknown> | null = null;
let store: Store;

beforeEach(async () => {
  window.localStorage.clear();
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

test('the tour walks its screens, the dots follow, and the last one closes it', async () => {
  const screens = steps();
  await open();

  expect(step()).toBe('welcome');
  expect(query('header .count').textContent?.trim()).toBe(`Step 1 of ${screens.length}`);
  expect(query<HTMLButtonElement>('[data-testid=onboarding-back]').disabled).toBe(true);
  expect(document.querySelectorAll('.dots .dot').length).toBe(screens.length);

  for (let at = 1; at < screens.length; at++) {
    await click('onboarding-next');
    expect(step()).toBe(screens[at]);
    expect(query(`[data-testid=onboarding-dot-${screens[at]}]`).getAttribute('aria-current')).toBe('step');
  }

  // The last screen sends the user into the app rather than to another one.
  expect(query('[data-testid=onboarding-next]').textContent?.trim()).toBe('Open Boite');
  expect(tourSeen()).toBe(false);

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

test('continuing the privacy step keeps basic counters without opting into details', async () => {
  await open();
  await click('onboarding-next');
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

test('the usage screen offers the accounts it can read, and the reach screen the two ways out', async () => {
  await open();
  await click('onboarding-dot-usage');

  // The fake core answers `quotas.list`, so the switches are the real rows.
  await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync();
  await tick();
  const switches = document.querySelectorAll('[data-testid^=onboarding-quota-]');
  expect(switches.length > 0 || document.querySelector('[data-testid=onboarding-providers]') !== null).toBe(true);

  await click('onboarding-dot-reach');
  expect(document.querySelector('[data-testid=onboarding-pair]')).not.toBeNull();
  expect(document.querySelector('[data-testid=onboarding-machines]')).not.toBeNull();

  // Either button hands over to a settings tab and ends the tour there.
  await click('onboarding-machines');
  await settle();
  expect(store.page).toBe('settings');
  expect(store.settingsTab).toBe('machines');
  expect(tourSeen()).toBe(true);
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

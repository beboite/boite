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

test('demo artwork speaks the language of the tour around it', async () => {
  setLocaleSetting('fr');
  await open();
  expect(query('[data-testid=onboarding-animation]').textContent).toContain('Créer mon portfolio');
  await click('onboarding-dot-agents');
  await click('onboarding-example-voice');
  expect(query('[data-testid=onboarding-animation]').textContent).toContain('Rends les boutons plus lisibles');
  expect(query('[data-testid=onboarding-animation]').textContent).not.toContain('Build my portfolio');
  await click('onboarding-animation-pause');
  expect(query('[data-testid=onboarding-animation-pause]').textContent).toContain('Reprendre');
  expect(query('[data-testid=onboarding-animation-replay]').textContent).toContain('Rejouer');
  expect(query('[data-testid=onboarding-next]').textContent).toContain('Suivant');
});

/** The consent rows answer through the fake core before the tour closes. */
async function answer(testid: string): Promise<void> {
  await click(testid);
  await new Promise(resolve => setTimeout(resolve, 0));
  flushSync();
  await settle();
}

test('the tour walks its screens, the dots follow, and the consent choice closes it', async () => {
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

  // The owner's last screen is the trade offer: its two rows are the only way on.
  expect(step()).toBe('privacy');
  expect(document.querySelector('[data-testid=onboarding-next]')).toBeNull();
  expect(readOnboarding()).toBeNull();

  await answer('onboarding-telemetry-enhanced');

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
  // A guest's last screen has no consent to give: its button closes the tour.
  expect(query('[data-testid=onboarding-next]').textContent?.trim()).toBe("Let's Boite");
});

test('refusing the deal keeps basic counters, turns the row red and closes after the clip', async () => {
  await open();
  await click('onboarding-dot-privacy');
  expect(document.querySelector('.soul')).not.toBeNull();
  await new Promise(resolve => setTimeout(resolve, 0)); flushSync();
  await answer('onboarding-telemetry-basic');
  expect(await store.client!.call('telemetry.state', {})).toMatchObject({ mode: 'basic' });
  expect(query('[data-testid=onboarding-telemetry-basic]').classList.contains('refused')).toBe(true);
  expect(query<HTMLButtonElement>('[data-testid=onboarding-telemetry-enhanced]').disabled).toBe(true);
  // The refusal clip plays before the tour goes away.
  expect(document.querySelector('[data-testid=onboarding]')).not.toBeNull();
});

test('the note under the rows turns everything off in one click and closes the tour', async () => {
  await open();
  await click('onboarding-dot-privacy');
  await new Promise(resolve => setTimeout(resolve, 0)); flushSync();
  expect(query('[data-testid=onboarding-telemetry-basic]').textContent).toContain('basic counters');
  await answer('onboarding-telemetry-off');
  expect(await store.client!.call('telemetry.state', {})).toMatchObject({ mode: 'off' });
  expect(document.querySelector('[data-testid=onboarding]')).toBeNull();
  expect(tourSeen()).toBe(true);
});

test('under reduced motion refusing closes at once, and a replay keeps a saved opt-out', async () => {
  document.documentElement.dataset.motion = 'reduced';
  try {
    await store.client!.call('telemetry.configure', { mode: 'off' });
    await open();
    await click('onboarding-dot-privacy');
    await new Promise(resolve => setTimeout(resolve, 0)); flushSync();
    await answer('onboarding-telemetry-basic');
    expect(await store.client!.call('telemetry.state', {})).toMatchObject({ mode: 'off' });
    expect(document.querySelector('[data-testid=onboarding]')).toBeNull();
    expect(tourSeen()).toBe(true);
  } finally { delete document.documentElement.dataset.motion; }
});

test('refusing waits for the saved mode, so an unread opt-out is never overwritten', async () => {
  const client = store.client!;
  const call = client.call.bind(client);
  vi.spyOn(client, 'call').mockImplementation((async (method: string, params: never) => {
    if (method === 'telemetry.state') throw new Error('state unreadable');
    return call(method as never, params);
  }) as typeof client.call);
  await call('telemetry.configure', { mode: 'off' } as never);
  await open();
  await click('onboarding-dot-privacy');
  await new Promise(resolve => setTimeout(resolve, 0)); flushSync();
  expect(query<HTMLButtonElement>('[data-testid=onboarding-telemetry-basic]').disabled).toBe(true);
  await answer('onboarding-telemetry-basic');
  expect(await call('telemetry.state', {} as never)).toMatchObject({ mode: 'off' });
  expect(query('[data-testid=telemetry-deal] [role=alert]').textContent).toContain('state unreadable');
});

test('a client swapped under the screen is asked for its own saved mode before refusing', async () => {
  document.documentElement.dataset.motion = 'reduced';
  try {
    await open();
    await click('onboarding-dot-privacy');
    await new Promise(resolve => setTimeout(resolve, 0)); flushSync();
    // The first client said basic; the one attached now has opted out.
    const next = new FakeClient({ delayMs: 0 });
    store.attach(next);
    await store.connect();
    await next.call('telemetry.configure', { mode: 'off' } as never);
    await answer('onboarding-telemetry-basic');
    await new Promise(resolve => setTimeout(resolve, 0)); flushSync();
    expect(await next.call('telemetry.state', {} as never)).toMatchObject({ mode: 'off' });
  } finally { delete document.documentElement.dataset.motion; }
});

test('the deal opts into enhanced analytics and ends the tour', async () => {
  await open();
  await click('onboarding-dot-privacy');
  await answer('onboarding-telemetry-enhanced');
  expect(await store.client!.call('telemetry.state', {})).toMatchObject({ mode: 'enhanced' });
  expect(document.querySelector('[data-testid=onboarding]')).toBeNull();
});

test('a failed consent write stays on the screen with its error', async () => {
  const client = store.client!;
  const call = client.call.bind(client);
  vi.spyOn(client, 'call').mockImplementation((async (method: string, params: never) => {
    if (method === 'telemetry.configure') throw new Error('relay unreachable');
    return call(method as never, params);
  }) as typeof client.call);
  await open();
  await click('onboarding-dot-privacy');
  await answer('onboarding-telemetry-enhanced');
  expect(query('[data-testid=telemetry-deal] [role=alert]').textContent).toContain('relay unreachable');
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

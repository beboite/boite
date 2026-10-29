// Shared by the app suite under src/app: the fake-core mount, its cleanup and the DOM helpers its tests drive.
import { afterEach, expect, vi } from 'vitest';
import { test as fixtureTest } from './fake-client';
import { flushSync, mount, unmount } from 'svelte';
import { type RpcMethodName } from '@boite/contracts';
import App from '../App.svelte';
import { type FakeClient } from '../lib/fake-client';
import { confirm } from '../lib/confirm.svelte';
import { store } from '../lib/store.svelte';
import { workspace } from '../lib/workspace.svelte';
import { setExperiment, writeExperiments } from '../lib/experiments';
import { storeEndpoint, upsertEnvironment } from '../lib/endpoint';
import { closeTour } from '../lib/onboarding.svelte';
import { work } from '../lib/work-prefs.svelte';
import { rightPanel } from '../lib/right-panel.svelte';
import { count } from '../lib/format';
import { projectThreadView } from '../lib/project-threads.svelte';
import { sidebarRows } from '../lib/sidebar-rows.svelte';
import { openUrl } from './opener';

let running: Record<string, unknown> | null = null;

// The settings page scrolls to the card it was opened on; jsdom draws nothing to scroll.
Element.prototype.scrollIntoView ??= vi.fn();

export const test = fixtureTest.extend<{ app: void }>({
  app: async ({}, use) => {
    await mountOnFake();
    await use();
  },
});

afterEach(() => {
  if (running) unmount(running, { outro: false });
  running = null;
  document.body.innerHTML = '';
  delete document.documentElement.dataset.theme;
  // Through the writer, so the reactive mirror hears the reset too.
  writeExperiments([]);
  rightPanel.floating = false;
  rightPanel.maximized = false;
  window.localStorage.clear();
  work.load();
  delete window.__TAURI_INTERNALS__;
  openUrl.mockClear();
});

/** Unmounts the app a test mounted, so the same test can mount it again. */
export function unmountApp(): void {
  if (running) unmount(running, { outro: false });
  running = null;
}

// The first settings mount waits on the dynamic import of the whole settings
// subtree: on a CI worker that one wait already took 1.2 s. The wait stops at
// a deadline well inside the test timeout (vitest.config.ts), so a slow wait
// fails here with the page's text rather than as a bare "Test timed out".
export async function waitFor(check: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  if (check()) return;
  throw new Error(`gave up waiting, body was:\n${document.body.textContent ?? ''}`);
}

/** The model ids the right column of the picker is showing, in order. */
export function shownModels(): (string | null)[] {
  return Array.from(document.querySelectorAll('[data-model]')).map((el) => el.getAttribute('data-model'));
}

/** The provider ids the rail draws a logo tile for, in order. */
export function tiles(): (string | null)[] {
  return Array.from(document.querySelectorAll('[data-testid=composer-picker-menu] [data-provider]')).map((el) =>
    el.getAttribute('data-provider')
  );
}

/** The account chips beside the shown provider's name, in order. */
export function seats(): (string | null)[] {
  return Array.from(document.querySelectorAll('[data-seat]')).map((el) => el.getAttribute('data-instance'));
}

/** The levels the open reasoning slider draws a dot for, in the model's order. */
export function effortDots(): (string | null)[] {
  return Array.from(document.querySelectorAll('[data-testid=composer-effort-menu] [data-dot]')).map((el) =>
    el.getAttribute('data-dot')
  );
}

/** The prefix labels the model column groups its matches under, in order. */
export function groupLabels(): (string | null)[] {
  return Array.from(document.querySelectorAll('[data-group]')).map((el) => el.getAttribute('data-group'));
}

/** Type into a field the way a user does, then let the effects settle. */
export async function type(field: HTMLInputElement, text: string): Promise<void> {
  field.focus();
  field.value = text;
  field.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** A key on whatever holds the focus, so it walks the same path a real one would. */
export function press(key: string, init: KeyboardEventInit = {}): void {
  (document.activeElement ?? document.body).dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  );
}

export function query<T extends Element = HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`nothing matches ${selector}`);
  return found;
}

/** The command ids the open palette is drawing a row for, in order. */
export function paletteIds(): (string | null)[] {
  return Array.from(document.querySelectorAll('[data-testid=palette-row]')).map((el) =>
    el.getAttribute('data-palette-id')
  );
}

/** The ids of the rows the open context menu is showing, separators aside. */
export function menuValues(): (string | null)[] {
  return Array.from(document.querySelectorAll('[data-testid=context-menu] [data-value]')).map((el) =>
    el.getAttribute('data-value')
  );
}

/** Lands on the most recent thread, what most of these tests are about; `open=` in `search` overrides it. */
export async function mountOnFake(search = '/?fake=1'): Promise<void> {
  window.history.replaceState(null, '', search.includes('open=') ? search : `${search}&open=recent`);
  const target = document.createElement('div');
  document.body.appendChild(target);
  // The store is a singleton and keeps the previous test's open thread, so
  // `booted` is the only honest signal that this mount finished its own boot.
  store.booted = false;
  store.openThread = null;
  store.draft = null;
  store.page = 'chat';
  store.composerStates = {};
  store.projectPickerOpen = false;
  // A device that has never seen the tour gets it over everything on boot,
  // which is the point of it and not what these tests are about.
  closeTour();
  running = mount(App, { target });
  // `.app.ready` is what the screen shows: outside the shell it also waits for the phone's navigation chunk (App.svelte).
  await waitFor(() => store.booted && (store.openThread !== null || store.draft !== null) && document.querySelector('.app.ready') !== null);
}

/** The thread every workbench test works in, with an empty strip to start on. */
export async function openWorkbench(): Promise<void> {
  await mountOnFake();
  await waitFor(() => document.querySelector('[data-thread-id="t-trace"]') !== null);
  query<HTMLButtonElement>('[data-thread-id="t-trace"]').click();
  await waitFor(() => store.openThread?.id === 't-trace');
  store.panel.closeAll();
}

/** The paths the tree is drawing a row for, in order. */
export function treePaths(): (string | null)[] {
  return Array.from(document.querySelectorAll('[data-testid=files-row]')).map((row) =>
    row.getAttribute('data-path')
  );
}

export const SEEDED_THINKING = 'The table wants a row per process';

/** A provider's accounts sit behind its row's chevron. */
export async function openProviderDetails(providerId: string): Promise<void> {
  const row = `[data-testid=provider-settings][data-provider-id=${providerId}]`;
  await waitFor(() => document.querySelector(row) !== null);
  if (document.querySelector(`${row} [data-testid=provider-details]`) === null)
    query<HTMLButtonElement>(`${row} [data-testid=provider-details-toggle]`).click();
  await waitFor(() => document.querySelector(`${row} [data-testid=provider-details]`) !== null);
}

/** Opens the Accounts page on the fake and returns the login link it shows. */
export async function loginLink(): Promise<HTMLAnchorElement> {
  await mountOnFake();
  query<HTMLButtonElement>('[data-testid=nav-settings]').click();
  await waitFor(() => document.querySelector('[data-testid=settings-tab-accounts]') !== null);
  query<HTMLButtonElement>('[data-testid=settings-tab-accounts]').click();
  await waitFor(() => document.querySelector('[data-testid=accounts-page]') !== null);
  await openProviderDetails('claude');
  query<HTMLButtonElement>('[data-testid=account-login]').click();
  await waitFor(() => document.querySelector('[data-testid=account-login-url]') !== null);
  return query<HTMLAnchorElement>('[data-testid=account-login-url]');
}

/** The store is one module-level singleton: leave the next test on the chat. */
export async function backToChat(): Promise<void> {
  query<HTMLButtonElement>('[data-testid=settings-back]').click();
  await waitFor(() => document.querySelector('[data-testid=settings]') === null);
}

export const LOGIN_URL = 'https://example.invalid/login?code=fake';

export async function sendPrompt(text: string): Promise<void> {
  const input = query<HTMLTextAreaElement>('[data-testid=composer-input]');
  input.value = text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await waitFor(() => !query<HTMLButtonElement>('[data-testid=composer-send]').disabled);
  query<HTMLButtonElement>('[data-testid=composer-send]').click();
}

export const STREAMED_TOOL_INPUT = '{"command":"echo streamed","description":"a streamed input"}';

/** The app as a first launch sees it: no project, no thread, nothing open. */
export async function emptyCore(): Promise<void> {
  store.projects = [];
  store.threads = [];
  store.openThread = null;
  store.draft = null;
  await store.openWhereLeft();
}

export async function showMobileThreads(): Promise<void> {
  // jsdom does not implement dialog methods; the browser suite exercises the modal.
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function(this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function(this: HTMLDialogElement) { this.open = false; } });
  // A conversation hides the bottom bar: Back leads to the list that has it.
  if (!document.querySelector('[data-testid=mobile-tabs]')) {
    query<HTMLButtonElement>('[data-testid=mobile-back]').click();
    await waitFor(() => document.querySelector('[data-testid=mobile-tabs]') !== null);
  }
  query<HTMLButtonElement>('[data-testid=mobile-conversations]').click();
  await waitFor(() => document.querySelector('[data-testid=mobile-project]') !== null);
}

/** Everything owner-only that is drawn without leaving the chat. The panel is not: its Agents and Workflows surfaces are the device's to follow. */
export const OWNER_ONLY_IN_CHAT = ['[data-testid=add-project]'];

/** Everything owner-only on the settings nav and its Machines page. */
export const OWNER_ONLY_IN_SETTINGS = [
  '[data-testid=settings-tab-accounts]',
  '[data-testid=settings-tab-plugins]',
  '[data-testid=settings-tab-resources]',
  '[data-testid=group-add-device]'
];

/** How a phone reaches this machine, on Advanced: the owner's to change. */
export const OWNER_ONLY_IN_ADVANCED = ['[data-testid=setting-listen-on-lan]'];

/** The palette ids that each end in a method a device may not call. */
export const OWNER_ONLY_COMMANDS = ['add-project', 'trace', 'providers', 'pair'];

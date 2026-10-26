import { afterEach, expect, test, vi } from 'vitest';
import { mount, unmount } from 'svelte';
import App from '../App.svelte';
import { store } from '../lib/store.svelte';
import { closeTour } from '../lib/onboarding.svelte';
import { archiveThread } from '../lib/archive';
import type { FakeClient } from '../lib/fake-client';
import { workspace } from '../lib/workspace.svelte';

/** The phone has no General page: the archive it can fill must be reachable from its own settings list. */

const { openUrl } = vi.hoisted(() => ({ openUrl: vi.fn(async (_url: string) => {}) }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl }));

let running: Record<string, unknown> | null = null;
// jsdom has no scrolling: a page opened on a card scrolls to it.
Element.prototype.scrollIntoView ??= vi.fn();

afterEach(() => {
  vi.unstubAllGlobals();
  if (running) unmount(running, { outro: false });
  running = null;
  document.body.innerHTML = '';
  window.localStorage.clear();
});

async function waitFor(check: () => boolean, attempts = 2000): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`gave up waiting, body was:\n${document.body.textContent ?? ''}`);
}

function query<T extends Element = HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`nothing matches ${selector}`);
  return found;
}

/** A phone-width window: only the layout query answers yes. */
function phoneWidth() {
  vi.stubGlobal('matchMedia', (media: string) => Object.assign(new EventTarget(), {
    media, matches: media.includes('max-width: 720px'), onchange: null, addListener() {}, removeListener() {}
  }));
}

test('a thread archived on the phone comes back from its own settings list', async () => {
  phoneWidth();
  window.history.replaceState(null, '', '/?fake=1&open=recent');
  const target = document.createElement('div');
  document.body.appendChild(target);
  store.booted = false;
  store.openThread = null;
  store.draft = null;
  store.page = 'chat';
  store.composerStates = {};
  store.projectPickerOpen = false;
  closeTour();
  running = mount(App, { target });
  await waitFor(() => store.booted && (store.openThread !== null || store.draft !== null));

  const client = store.client as FakeClient;
  expect(await archiveThread(store, 't-trace')).toBe(true);
  await waitFor(() => !store.threads.some((t) => t.id === 't-trace' && !t.archived));
  const account = (await client.call('accounts.list', {})).find(account => account.providerId === 'echo')!;
  const merged = await client.call('threads.create', { projectId: 'p-boite', providerId: 'echo', accountId: account.id, title: 'Merged phone conversation', worktree: { branch: 'merged-phone-fixture' } });
  client.setMergedPrFixture(merged.id, { repository: 'github.com/example/repo', branch: merged.branch!, tip: 'a'.repeat(40), clean: true, candidates: [{ repository: 'github.com/example/repo', branch: merged.branch!, sha: 'a'.repeat(40), number: 7, url: 'https://github.com/example/repo/pull/7', mergedAt: '2026-10-01T12:00:00Z' }] });
  expect(await client.sweepMergedPrArchives()).toBe(1);
  store.showSettings('general');
  await waitFor(() => document.querySelector('[data-testid=mobile-settings-home]') !== null);
  query<HTMLButtonElement>('[data-testid=mobile-settings-archived]').click();
  // The page of its own reads the list at once: no second tap on Show.
  await waitFor(() => document.querySelector('[data-testid=archived-restore]') !== null);
  expect(query('[data-testid=archived-list]').textContent).toContain('Finish the trace tab');
  const mergedReason = query(`[data-thread-id="${merged.id}"] [data-testid=archive-merged-reason]`);
  expect(mergedReason.textContent).toContain('Archived after PR #7 merged');
  expect(mergedReason.querySelector('a')?.getAttribute('href')).toBe('https://github.com/example/repo/pull/7');
  expect(mergedReason.querySelector('time')?.getAttribute('datetime')).not.toBeNull();
  query<HTMLButtonElement>('[data-thread-id=t-trace] [data-testid=archived-restore]').click();
  await waitFor(() => store.threads.find((t) => t.id === 't-trace')?.archived === false);

  query<HTMLButtonElement>('[data-testid=mobile-settings-back]').click();
  await waitFor(() => document.querySelector('[data-testid=mobile-settings-home]') !== null);

  // The desktop's jump to the card (palette, project menu) lands on the same page here.
  // The jump scrolls the card into view, which jsdom does not draw.
  Element.prototype.scrollIntoView ??= vi.fn();
  store.showSettings('general', 'archived');
  await waitFor(() => document.querySelector('[data-testid=archived-list], [data-testid=archived-empty]') !== null);
  expect(document.querySelector('[data-testid=archived-show]')).toBeNull();
  expect(query('[data-testid=mobile-settings-detail]')).toBeTruthy();
  expect(query(`[data-thread-id="${merged.id}"] [data-testid=archive-merged-reason]`).textContent).toContain('PR #7');
  query<HTMLButtonElement>(`[data-thread-id="${merged.id}"] [data-testid=archived-restore]`).click();
  await waitFor(() => store.threads.find(thread => thread.id === merged.id)?.archived === false);
  expect(await client.sweepMergedPrArchives()).toBe(0);
});

test('the phone settings hold this phone\'s three screens and the machine\'s essentials, Usage and Limits on one screen', async () => {
  phoneWidth();
  // The usage chart and the composer measure themselves; jsdom has no observer.
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  window.history.replaceState(null, '', '/?fake=1');
  const target = document.createElement('div');
  document.body.appendChild(target);
  store.booted = false;
  store.openThread = null;
  store.draft = null;
  store.page = 'chat';
  store.composerStates = {};
  store.projectPickerOpen = false;
  closeTour();
  running = mount(App, { target });
  await waitFor(() => store.booted && (store.openThread !== null || store.draft !== null));

  const home = () => document.querySelector('[data-testid=mobile-settings-home]') !== null;
  const back = async () => { query<HTMLButtonElement>('[data-testid=mobile-settings-back]').click(); await waitFor(home); };
  store.showSettings();
  await waitFor(home);
  expect([...document.querySelectorAll<HTMLElement>('[data-testid=mobile-settings-home] .row')].map(row => row.dataset.testid)).toEqual([
    'mobile-settings-phone', 'settings-tab-appearance', 'mobile-settings-privacy', 'settings-tab-experiments',
    'mobile-settings-connection', 'settings-tab-usage', 'settings-tab-voice', 'mobile-settings-browser-profiles', 'mobile-settings-compaction', 'mobile-settings-windows', 'mobile-settings-archived',
    'mobile-settings-secrets'
  ]);
  // The header already says Settings, and the list's display options group the threads.
  expect(document.querySelector('[data-testid=mobile-settings-home] h1')).toBeNull();
  expect(document.querySelector('[data-testid=setting-group-working-threads]')).toBeNull();

  // Experiments are this phone's own: Bots on the computer does not give the phone its tab until it is switched on here.
  expect(document.querySelector('[data-testid=mobile-agents]')).toBeNull();
  query<HTMLButtonElement>('[data-testid=settings-tab-experiments]').click();
  await waitFor(() => document.querySelector('[data-testid=experiment-resident-agents]') !== null);
  query<HTMLInputElement>('[data-testid=experiment-resident-agents]').click();
  await waitFor(() => document.querySelector('[data-testid=mobile-tabs] [data-testid=mobile-agents]') !== null);
  await back();

  query<HTMLButtonElement>('[data-testid=mobile-settings-browser-profiles]').click();
  await waitFor(() => document.querySelector('[data-testid=browser-profiles-card]') !== null);
  await back();

  Element.prototype.scrollIntoView ??= vi.fn();
  query<HTMLButtonElement>('[data-testid=mobile-settings-compaction]').click();
  await waitFor(() => document.querySelector('[data-testid=compaction-settings]') !== null);
  for (const type of ['common', 'agent', 'subagent', 'bot']) {
    expect(document.querySelector(`[data-testid=compaction-target-${type}]`)).not.toBeNull();
  }
  query<HTMLButtonElement>('[data-testid=compaction-target-subagent]').click();
  await waitFor(() => document.querySelector('[data-testid=compaction-inherited]') !== null);
  expect(query<HTMLInputElement>('[data-testid=compaction-customize]').checked).toBe(false);
  await back();

  // The analytics switches have a screen of their own, out of the notifications.
  query<HTMLButtonElement>('[data-testid=mobile-settings-phone]').click();
  await waitFor(() => document.querySelector('[data-testid=phone-settings]') !== null);
  expect(document.querySelector('[data-testid=telemetry-settings]')).toBeNull();
  await back();
  query<HTMLButtonElement>('[data-testid=mobile-settings-privacy]').click();
  await waitFor(() => document.querySelector('[data-testid=telemetry-settings]') !== null);
  await back();

  query<HTMLButtonElement>('[data-testid=settings-tab-usage]').click();
  await waitFor(() => document.querySelector('[data-testid=mobile-usage-tab-usage][aria-selected=true]') !== null);
  query<HTMLButtonElement>('[data-testid=mobile-usage-tab-limits]').click();
  await waitFor(() => store.settingsTab === 'limits' && document.querySelector('[data-testid=mobile-usage-tab-limits][aria-selected=true]') !== null);
  await back();

  // Appearance takes the files and previews and element reference switches, and leaves the desktop's rows behind.
  query<HTMLButtonElement>('[data-testid=settings-tab-appearance]').click();
  await waitFor(() => document.querySelector('[data-testid=appearance-page]') !== null);
  expect(document.querySelector('[data-testid=setting-chat-artifacts]')).not.toBeNull();
  expect(document.querySelector('[data-testid=setting-preview-comments]')).not.toBeNull();
  for (const id of ['chat-width-comfortable', 'terminal-gpu', 'settings-buttons', 'start-in-drafts', 'setting-edge-scrollbars']) expect(document.querySelector(`[data-testid=${id}]`)).toBeNull();
});

test('on a phone too, a page of one machine is picked above it without moving the window', async () => {
  phoneWidth();
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  window.history.replaceState(null, '', '/?fake=1&machines=1');
  const target = document.createElement('div');
  document.body.appendChild(target);
  store.booted = false;
  store.page = 'chat';
  closeTour();
  running = mount(App, { target });
  await waitFor(() => store.booted && workspace.machines.length === 2 && workspace.machines.every((machine) => machine.store.connection === 'ready'));
  const remote = workspace.machines.find((machine) => machine.store !== store)!;
  await remote.store.client!.call('settings.set', { muteAgents: true });
  await store.client!.call('settings.set', { muteAgents: true });
  store.showSettings('resources');
  await waitFor(() => document.querySelector('[data-testid=settings-machine]') !== null && document.querySelector('[data-testid=setting-mute-agents]') !== null);
  query<HTMLButtonElement>('[data-testid=settings-machine]').click();
  await waitFor(() => document.querySelector('[data-testid=settings-machine-menu]') !== null);
  query<HTMLElement>(`[data-testid=settings-machine-menu] [data-value="${remote.id}"]`).click();
  await waitFor(() => query('[data-testid=settings-machine]').textContent?.includes(remote.label) === true);
  query<HTMLInputElement>('[data-testid=setting-mute-agents]').click();
  await waitFor(() => remote.store.settings?.muteAgents === false);
  expect(store.settings?.muteAgents).toBe(true);
  expect(workspace.active).toBe(store);
});

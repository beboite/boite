import { afterEach, expect, test, vi } from 'vitest';
import { mount, unmount } from 'svelte';
import App from '../App.svelte';
import { store } from '../lib/store.svelte';
import { closeTour } from '../lib/onboarding.svelte';
import { archiveThread } from '../lib/archive';
import type { FakeClient } from '../lib/fake-client';

/** The phone has no General page: the archive it can fill must be reachable from its own settings list. */

const { openUrl } = vi.hoisted(() => ({ openUrl: vi.fn(async (_url: string) => {}) }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl }));

let running: Record<string, unknown> | null = null;

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

  const managedProjectId = store.openProject!.id;
  query<HTMLButtonElement>('[data-testid=mobile-project-actions]').click();
  await waitFor(() => document.querySelector('[data-value=manage]') !== null);
  query<HTMLButtonElement>('[data-value=manage]').click();
  await waitFor(() => document.querySelector('[data-value=auto-archive-merged-pr]') !== null);
  expect(query('[data-value=auto-archive-merged-pr]').getAttribute('role')).toBe('menuitemcheckbox');
  expect(query('[data-value=auto-archive-merged-pr]').getAttribute('aria-checked')).toBe('true');
  query<HTMLButtonElement>('[data-value=auto-archive-merged-pr]').click();
  await waitFor(() => store.projects.find(project => project.id === managedProjectId)?.autoArchiveMergedPr === false);
  const client = store.client as FakeClient;
  expect((await client.call('projects.list', {})).find(project => project.id === managedProjectId)?.autoArchiveMergedPr).toBe(false);
  await store.setProjectAutoArchiveMergedPr(managedProjectId, true);

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

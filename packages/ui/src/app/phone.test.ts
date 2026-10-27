import { expect, vi } from 'vitest';
import { flushSync } from 'svelte';
import { confirm } from '../lib/confirm.svelte';
import { store } from '../lib/store.svelte';
import { workspace } from '../lib/workspace.svelte';
import { OWNER_ONLY_COMMANDS, OWNER_ONLY_IN_ADVANCED, OWNER_ONLY_IN_CHAT, OWNER_ONLY_IN_SETTINGS, menuValues, mountOnFake, paletteIds, press, query, showMobileThreads, test, waitFor } from '../test/app';

vi.mock('@tauri-apps/plugin-opener', () => import('../test/opener'));

test('a dialog waiting for an answer holds the window chords', async ({ app: _app }) => {
  const open = store.openThread?.id;
  const page = store.page;

  const answer = confirm.ask({
    title: 'Remove this project?',
    confirmLabel: 'Remove',
    cancelLabel: 'Cancel',
    danger: true
  });
  await waitFor(() => document.querySelector('[data-testid=confirm-dialog]') !== null);

  // The three the user reaches for out of habit while a dialog is up.
  press('n', { ctrlKey: true });
  press('k', { ctrlKey: true });
  press(',', { ctrlKey: true });

  expect(store.draft).toBeNull();
  expect(store.openThread?.id).toBe(open);
  expect(store.paletteOpen).toBe(false);
  expect(store.page).toBe(page);
  // It is still the dialog asking, and the promise it holds is still pending.
  expect(document.querySelector('[data-testid=confirm-dialog]')).not.toBeNull();

  query<HTMLButtonElement>('[data-testid=confirm-cancel]').click();
  expect(await answer).toBe(false);

  // Answered, the same chord moves the app again.
  press('k', { ctrlKey: true });
  expect(store.paletteOpen).toBe(true);
  store.paletteOpen = false;
});

/*
 * The device boundary, seen from the screen. `packages/core/src/access.ts`
 * refuses a paired device every method outside `DEVICE_METHODS`, so the two
 * tests below walk the same surfaces twice: once as the phone, which must not
 * be offered them, once as the desktop, which must still have every one.
 */

test('a paired device is offered none of the affordances the core refuses it', async () => {
  await mountOnFake('/?fake=1&principal=session');
  expect(store.principal).toBe('session');
  expect(store.owner).toBe(false);
  // The boot itself is the first proof: the fake refuses what the core does,
  // so one owner-only call left in it would have failed the load.
  expect(store.error).toBeNull();
  expect(store.threads.length).toBe(4);

  for (const selector of OWNER_ONLY_IN_CHAT) expect(document.querySelector(selector)).toBeNull();

  store.paletteOpen = true;
  await waitFor(() => document.querySelector('[data-testid=palette]') !== null);
  const commands = paletteIds();
  expect(commands).toContain('new-thread');
  for (const id of OWNER_ONLY_COMMANDS) expect(commands).not.toContain(id);
  store.paletteOpen = false;

  // A paired device's project menu: no Remove, and no transcript import behind it.
  query('[data-testid=project-row]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  await waitFor(() => document.querySelector('[data-testid=context-menu]') !== null);
  expect(menuValues()).toEqual(['new', 'copy', 'rename', 'archived', 'manage']);
  query<HTMLButtonElement>('[data-testid=context-menu] [data-value=manage]').click();
  await waitFor(() => document.querySelector('[data-testid=context-menu] [data-value=archive-project]') !== null);
  expect(menuValues()).toEqual(['back', 'secrets', 'archive-project']);
  press('Escape');
  await waitFor(() => document.querySelector('[data-testid=context-menu]') === null);
  // The phone's own header manages no project at all.
  await showMobileThreads();
  expect(document.querySelector('[data-testid=mobile-project-actions]')).toBeNull();

  store.showSettings('machines');
  await waitFor(() => document.querySelector('[data-testid=machines-page]') !== null);
  for (const selector of OWNER_ONLY_IN_SETTINGS) expect(document.querySelector(selector)).toBeNull();
  // Neither a way to add a device nor a group to join: a device changes nothing in the group.
  expect(document.querySelector('[data-testid=group-join-input]')).toBeNull();
  store.showSettings('advanced', 'phone');
  await waitFor(() => document.querySelector('[data-testid=phone-settings]') !== null);
  for (const selector of OWNER_ONLY_IN_ADVANCED) expect(document.querySelector(selector)).toBeNull();
  expect(store.error).toBeNull();
});

test('the desktop still has every one of them', async ({ app: _app }) => {
  expect(store.principal).toBe('owner');
  expect(store.owner).toBe(true);

  for (const selector of OWNER_ONLY_IN_CHAT) expect(document.querySelector(selector)).not.toBeNull();

  store.paletteOpen = true;
  await waitFor(() => document.querySelector('[data-testid=palette]') !== null);
  const commands = paletteIds();
  for (const id of OWNER_ONLY_COMMANDS) expect(commands).toContain(id);
  store.paletteOpen = false;

  query('[data-testid=project-row]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  await waitFor(() => document.querySelector('[data-testid=context-menu]') !== null);
  expect(menuValues()).toEqual(['new', 'copy', 'rename', 'archived', 'manage']);
  query<HTMLButtonElement>('[data-testid=context-menu] [data-value=manage]').click();
  await waitFor(() => document.querySelector('[data-testid=context-menu] [data-value=archive-project]') !== null);
  expect(menuValues()).toEqual(['back', 'worktree-default', 'worktrees', 'auto-archive-merged-pr', 'auto-remove-worktrees', 'windows', 'refresh-icon', 'secrets', 'archive-project', 'remove']);
  const policyProjectId = query('[data-testid=project-row]').getAttribute('data-project-id')!;
  const policy = query<HTMLButtonElement>('[data-value=auto-archive-merged-pr]');
  expect(policy.getAttribute('role')).toBe('menuitemcheckbox');
  expect(policy.getAttribute('aria-checked')).toBe('true');
  const ownerClient = store.client!, call = ownerClient.call.bind(ownerClient);
  let release!: () => void;
  const held = new Promise<void>(done => { release = done; });
  const policyCalls = vi.spyOn(ownerClient, 'call').mockImplementation(async (method, params) => {
    if (method === 'projects.setAutoArchiveMergedPr') { await held; throw new Error('The project policy could not be saved'); }
    return call(method, params);
  });
  policy.click();
  await waitFor(() => store.projectAutoArchiveMergedPrBusy(policyProjectId));
  query('[data-testid=project-row]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  await waitFor(() => document.querySelector('[data-value=manage]') !== null);
  query<HTMLButtonElement>('[data-value=manage]').click();
  await waitFor(() => document.querySelector('[data-value=auto-archive-merged-pr]') !== null);
  expect(query<HTMLButtonElement>('[data-value=auto-archive-merged-pr]').disabled).toBe(true);
  query<HTMLButtonElement>('[data-value=auto-archive-merged-pr]').click();
  expect(policyCalls.mock.calls.filter(([method]) => method === 'projects.setAutoArchiveMergedPr')).toHaveLength(1);
  release();
  await waitFor(() => (document.body.textContent ?? '').includes('The project policy could not be saved'));
  await waitFor(() => !query<HTMLButtonElement>('[data-value=auto-archive-merged-pr]').disabled);
  expect(store.projects.find(project => project.id === policyProjectId)?.autoArchiveMergedPr).toBe(true);
  policyCalls.mockRestore(); store.error = null;
  press('Escape');
  query('[data-testid=project-row]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  await waitFor(() => document.querySelector('[data-value=manage]') !== null);
  query<HTMLButtonElement>('[data-value=manage]').click();
  await waitFor(() => document.querySelector('[data-value=auto-archive-merged-pr]') !== null);
  query<HTMLButtonElement>('[data-value=auto-archive-merged-pr]').click();
  await waitFor(() => store.projects.find(project => project.id === policyProjectId)?.autoArchiveMergedPr === false);
  expect((await ownerClient.call('projects.list', {})).find(project => project.id === policyProjectId)?.autoArchiveMergedPr).toBe(false);
  query('[data-testid=project-row]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  await waitFor(() => document.querySelector('[data-value=manage]') !== null);
  query<HTMLButtonElement>('[data-value=manage]').click();
  await waitFor(() => document.querySelector('[data-value=auto-archive-merged-pr]') !== null);
  expect(query('[data-value=auto-archive-merged-pr]').getAttribute('aria-checked')).toBe('false');
  const preference = query<HTMLButtonElement>('[data-value=worktree-default]');
  expect(preference.getAttribute('role')).toBe('menuitemcheckbox');
  expect(preference.getAttribute('aria-checked')).toBe('false');
  query<HTMLButtonElement>('[data-testid=context-menu] [data-value=back]').click();
  await waitFor(() => document.querySelector('[data-testid=context-menu] [data-value=new]') !== null);
  expect(menuValues()).toEqual(['new', 'copy', 'rename', 'archived', 'manage']);
  press('Escape');
  await waitFor(() => document.querySelector('[data-testid=context-menu]') === null);
  // The phone's own header manages no project at all.
  await showMobileThreads();
  expect(document.querySelector('[data-testid=mobile-project-actions]')).toBeNull();

  store.showSettings('machines');
  await waitFor(() => document.querySelector('[data-testid=group-add-device]') !== null);
  for (const selector of OWNER_ONLY_IN_SETTINGS) expect(document.querySelector(selector)).not.toBeNull();
  store.showSettings('advanced', 'phone');
  await waitFor(() => document.querySelector('[data-testid=phone-settings]') !== null);
  for (const selector of OWNER_ONLY_IN_ADVANCED) expect(document.querySelector(selector)).not.toBeNull();
  store.showSettings('resources');
  await waitFor(() => document.querySelector('[data-testid=resources-page]') !== null);
  for (const id of ['setting-focus-guard', 'setting-mute-agents']) {
    const input = query(`[data-testid=${id}]`) as HTMLInputElement;
    expect(input.checked).toBe(true);
    input.click();
    await waitFor(() => input.checked === false);
  }
  expect(store.settings?.focusGuard).toBe(false);
  expect(store.settings?.muteAgents).toBe(false);
  store.showSettings('general');
  await waitFor(() => document.querySelector('[data-testid=settings-page]') !== null);
  expect(document.querySelector('[data-testid=setting-focus-guard]')).toBeNull();
  store.showSettings('resources');
  await waitFor(() => document.querySelector('[data-testid=setting-focus-guard]') !== null);
  expect((query('[data-testid=setting-focus-guard]') as HTMLInputElement).checked).toBe(false);

});

test("a mouse's back and forward buttons walk the threads, settings tabs and machines shown", async () => {
  await mountOnFake('/?fake=1&machines=1');
  await waitFor(() => workspace.machines.length === 2);
  const remote = workspace.machines.find(machine => machine.store !== store)!.store;
  const remoteThread = remote.threads.find(thread => !thread.archived && !thread.parentThreadId)!.id;
  /** The release of a side button, and whether the page kept the browser from navigating. */
  const side = async (button: 3 | 4, shows: () => boolean): Promise<void> => {
    const event = new MouseEvent('mouseup', { button, bubbles: true, cancelable: true });
    document.body.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    await waitFor(shows);
  };
  const first = store.openThread!.id;
  // Each view is on screen for a frame, as it is under a hand.
  await store.open('t-scheduler');
  flushSync();
  store.showSettings();
  flushSync();
  store.showSettings('appearance');
  flushSync();
  await workspace.select(remote, remoteThread);
  flushSync();

  await side(3, () => workspace.active === store && store.page === 'settings' && store.settingsTab === 'appearance');
  await side(3, () => store.page === 'settings' && store.settingsTab === 'home');
  await side(3, () => store.page === 'chat' && store.openThread?.id === 't-scheduler');
  await side(3, () => store.openThread?.id === first);
  // The first view has nothing behind it: the button is still the page's, and nothing moves.
  const spent = new MouseEvent('mouseup', { button: 3, bubbles: true, cancelable: true });
  document.body.dispatchEvent(spent);
  expect(spent.defaultPrevented).toBe(true);
  await side(4, () => store.openThread?.id === 't-scheduler');
  await side(4, () => store.page === 'settings' && store.settingsTab === 'home');
  await side(4, () => store.settingsTab === 'appearance');
  await side(4, () => workspace.active === remote && remote.page === 'chat' && remote.openThread?.id === remoteThread);

  // A thread opened after going back replaces what was ahead.
  await side(3, () => workspace.active === store && store.settingsTab === 'appearance');
  await store.open(first);
  flushSync();
  const ahead = new MouseEvent('mouseup', { button: 4, bubbles: true, cancelable: true });
  document.body.dispatchEvent(ahead);
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(workspace.active).toBe(store);
  expect(store.openThread?.id).toBe(first);
  await side(3, () => store.page === 'settings' && store.settingsTab === 'appearance');
  // Views shown after a button's move are still recorded, one by one.
  await store.open('t-scheduler');
  flushSync();
  await store.open(first);
  flushSync();
  await side(3, () => store.page === 'chat' && store.openThread?.id === 't-scheduler');
  await workspace.select(store, first);
});

test("on a phone a mouse's back button stays the browser's, which closes the open sheet", async () => {
  const original = window.matchMedia;
  window.matchMedia = ((media: string) => ({ ...original(media), media, matches: media.includes('max-width: 720px') })) as typeof window.matchMedia;
  try {
    await mountOnFake();
    const opened = store.openThread!.id;
    await store.open('t-scheduler');
    flushSync();
    const event = new MouseEvent('mouseup', { button: 3, bubbles: true, cancelable: true });
    document.body.dispatchEvent(event);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(event.defaultPrevented).toBe(false);
    expect(store.openThread?.id).toBe('t-scheduler');
    expect(opened).not.toBe('t-scheduler');
  } finally { window.matchMedia = original; }
});

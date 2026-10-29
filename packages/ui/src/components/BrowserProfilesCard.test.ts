import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { Settings } from '@boite/contracts';
import BrowserProfilesCard from './BrowserProfilesCard.svelte';
import { browserProfiles } from '../lib/browser-profiles.svelte';
import { store } from '../lib/store.svelte';
import { browserBridge } from '../lib/browser-bridge';
import { confirm } from '../lib/confirm.svelte';

const originalDelete = browserBridge.deleteProfile;

let app: ReturnType<typeof mount> | undefined;

afterEach(async () => {
  if (app) await unmount(app);
  app = undefined;
  confirm.answer(false);
  browserBridge.deleteProfile = originalDelete;
  browserProfiles.source = null;
  store.settings = null;
  document.body.innerHTML = '';
});

function showDeletableProfile() {
  store.settings = { browserProfiles: [{ id: 'p-one', name: 'One' }] } as Settings;
  const save = vi.fn(async (patch: Partial<Settings>) => {
    store.settings = { ...store.settings!, ...patch };
    return true;
  });
  browserProfiles.source = { get settings() { return store.settings; }, saveSettings: save };
  app = mount(BrowserProfilesCard, { target: document.body });
  flushSync();
  return save;
}

function deleteProfile() {
  query<HTMLButtonElement>('[data-testid=browser-profile-delete]').click();
  flushSync();
  if (confirm.current) confirm.answer(true);
}

test('a client without profile erasure retains the profile and explains how to delete it', async () => {
  browserBridge.deleteProfile = undefined;
  const save = showDeletableProfile();
  deleteProfile();
  await vi.waitFor(() => {
    flushSync();
    expect(query('[data-testid=browser-profile-error]').textContent).toContain('desktop app');
  });
  expect(save).not.toHaveBeenCalled();
  expect(store.settings?.browserProfiles).toEqual([{ id: 'p-one', name: 'One' }]);
});

test('a failed profile erase retains the entry and a retry removes it only after erasure', async () => {
  browserBridge.deleteProfile = async () => { throw new Error('data locked'); };
  const save = showDeletableProfile();
  deleteProfile();
  await vi.waitFor(() => {
    flushSync();
    expect(query('[data-testid=browser-profile-error]').textContent).toContain('data locked');
  });
  expect(save).not.toHaveBeenCalled();
  expect(store.settings?.browserProfiles).toEqual([{ id: 'p-one', name: 'One' }]);
  let erased!: () => void;
  browserBridge.deleteProfile = () => new Promise<void>(resolve => { erased = resolve; });
  deleteProfile();
  await vi.waitFor(() => expect(erased).toBeTypeOf('function'));
  expect(save).not.toHaveBeenCalled();
  erased();
  await vi.waitFor(() => expect(store.settings?.browserProfiles).toEqual([]));
  expect(save).toHaveBeenCalledTimes(1);
});

function query<T extends HTMLElement = HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`nothing matches ${selector}`);
  return element;
}

test('overlapping User-Agent saves and a rename preserve every profile change', async () => {
  store.settings = { browserProfiles: [{ id: 'p-one', name: 'One' }, { id: 'p-two', name: 'Two' }] } as Settings;
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const patches: Partial<Settings>[] = [];
  browserProfiles.source = {
    get settings() { return store.settings; },
    async saveSettings(patch) {
      patches.push(patch);
      await pending;
      store.settings = { ...store.settings!, ...patch };
      return true;
    },
  };
  app = mount(BrowserProfilesCard, { target: document.body });
  flushSync();
  try {
    for (const [id, marker] of [['p-one', 'Bounty/1'], ['p-two', 'Bounty/2']] as const) {
      const row = `[data-profile=${id}]`;
      query<HTMLButtonElement>(`${row} [data-testid=browser-user-agent-edit]`).click();
      flushSync();
      const input = query<HTMLInputElement>(`${row} [data-testid=browser-user-agent-value]`);
      input.value = marker;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      query<HTMLFormElement>(`${row} form.user-agent`).requestSubmit();
      flushSync();
    }
    query<HTMLButtonElement>('[data-profile=p-one] [data-testid=browser-profile-rename]').click();
    flushSync();
    const name = query<HTMLInputElement>('[data-testid=browser-profile-rename-input]');
    name.value = 'Renamed';
    name.dispatchEvent(new Event('input', { bubbles: true }));
    query<HTMLFormElement>('form.rename').requestSubmit();
    await vi.waitFor(() => expect(patches.length).toBeGreaterThan(0));
    expect(patches).toHaveLength(1);
  } finally {
    finish();
    await vi.waitFor(() => expect(patches).toHaveLength(3));
  }
  await vi.waitFor(() => expect(store.settings?.browserProfiles).toEqual([
    { id: 'p-one', name: 'Renamed', userAgent: { mode: 'suffix', value: 'Bounty/1' } },
    { id: 'p-two', name: 'Two', userAgent: { mode: 'suffix', value: 'Bounty/2' } },
  ]));
});

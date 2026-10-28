import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { FakeClient } from '../lib/fake-client';
import { Store, type SettingsTab } from '../lib/store.svelte';
import MobileSettings from './MobileSettings.svelte';

let mounted: ReturnType<typeof mount> | undefined;
let client: FakeClient;
let store: Store;
const settle = async () => { for (let i = 0; i < 20; i++) { await Promise.resolve(); flushSync(); } };
afterEach(async () => {
  if (mounted) await unmount(mounted);
  mounted = undefined;
  store?.detach(); client?.close();
  vi.restoreAllMocks(); document.body.innerHTML = ''; localStorage.clear();
});

/** What a phone shows for a route: the page a desktop shows for it, the card's own page, or Home where the phone has no such page. */
const ROUTES: { owner: boolean; tab: SettingsTab; section?: string; shows: string }[] = [
  // The model picker's add-provider button opens Providers, on a phone too.
  { owner: true, tab: 'accounts', shows: 'accounts-page' },
  { owner: true, tab: 'plugins', shows: 'plugins-page' },
  { owner: true, tab: 'general', section: 'secrets', shows: 'secrets-card' },
  { owner: true, tab: 'keyboard', shows: 'mobile-settings-home' },
  { owner: false, tab: 'accounts', shows: 'mobile-settings-home' },
  { owner: false, tab: 'general', section: 'worktrees', shows: 'mobile-settings-home' },
  { owner: false, tab: 'general', section: 'secrets', shows: 'secrets-card' }
];

test.each(ROUTES)('$tab $section on a phone, owner $owner, shows $shows', async ({ owner, tab, section, shows }) => {
  client = new FakeClient({ delayMs: 0 });
  store = new Store(); store.attach(client); await store.connect();
  vi.spyOn(store, 'owner', 'get').mockReturnValue(owner);
  store.showSettings(tab, section ?? null);
  mounted = mount(MobileSettings, { target: document.body, props: { store } });
  await settle();
  expect(document.querySelector(`[data-testid=${shows}]`)).not.toBeNull();
});

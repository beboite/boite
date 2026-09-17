import { afterEach, expect, test } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import AccountsPage from './AccountsPage.svelte';
import { Store } from '../lib/store.svelte';
import { FakeClient } from '../lib/fake-client';

let mounted: ReturnType<typeof mount> | undefined;
afterEach(() => { if (mounted) unmount(mounted); document.body.innerHTML = ''; });

test('missing providers offer setup and managed installation inside their cards', async () => {
  const client = new FakeClient();
  await client.connect();
  const store = new Store();
  const { loaded } = await client.call('providers.list', {});
  store.providers = loaded.map(provider => ({ ...provider, available: false, executable: null }));
  mounted = mount(AccountsPage, { target: document.body, props: { store } });
  flushSync();
  const card = document.querySelector('[data-provider-id="antigravity"]');
  expect(card?.querySelector('[data-testid="install-start"]')).not.toBeNull();
  expect(document.querySelector('[data-provider-id="claude"] a')?.getAttribute('href')).toContain('code.claude.com');
  expect(document.querySelector('[data-testid="providers-refresh"]')).not.toBeNull();
  expect(document.querySelector('.connect:disabled')).toBeNull();
  client.close();
});

import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import PluginUpdateNotice from './PluginUpdateNotice.svelte';
import type { Store } from '../lib/store.svelte';
import { FakeClient } from '../lib/fake-client';
import { FAKE_RELEASES } from '../lib/fake-client/plugins-seed';
import { PLUGIN_UPDATE_ANSWERS_KEY } from '../lib/plugin-update-notice';

let mounted: ReturnType<typeof mount> | undefined;
let client: FakeClient | undefined;
const shipped = FAKE_RELEASES['bots']!.version;
afterEach(() => {
  if (mounted) unmount(mounted);
  mounted = undefined;
  client?.close();
  client = undefined;
  FAKE_RELEASES['bots']!.version = shipped;
  window.localStorage.removeItem(PLUGIN_UPDATE_ANSWERS_KEY);
  document.body.innerHTML = '';
});

const notice = () => document.querySelector<HTMLElement>('[data-testid="plugin-update-notice"]');
const click = (testId: string) => { document.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!.click(); flushSync(); };

async function show(owner = true) {
  if (client === undefined) {
    client = new FakeClient({ delayMs: 0 });
    await client.connect();
  }
  vi.restoreAllMocks();
  const call = vi.spyOn(client, 'call');
  const store = { client, connection: 'ready', owner, clientGeneration: 1, reportError: vi.fn() } as unknown as Store;
  mounted = mount(PluginUpdateNotice, { target: document.body, props: { machines: [{ id: 'pc', label: 'PC', store }] } });
  return { store, call };
}

/** What the core's own check does when the source publishes a newer release. */
async function release() {
  await client!.call('plugins.checkUpdates', {});
  flushSync();
}

test('a newer release shows once per version, and Later holds until a newer one', async () => {
  const { call } = await show();
  await vi.waitFor(() => expect(call).toHaveBeenCalledWith('plugins.list', {}));
  expect(notice()).toBeNull();

  await release();
  await vi.waitFor(() => expect(notice()?.getAttribute('data-version')).toBe('0.1.10'));
  expect(notice()?.textContent).toContain('B.O.T.S 0.1.10 is available');
  click('plugin-update-later');
  expect(notice()).toBeNull();
  expect(JSON.parse(window.localStorage.getItem(PLUGIN_UPDATE_ANSWERS_KEY)!)).toEqual({ 'pc:bots': '0.1.10' });

  // Checked again, or the app opened again: the same version stays answered.
  await release();
  unmount(mounted!);
  await show();
  await new Promise((resolve) => setTimeout(resolve, 10));
  flushSync();
  expect(notice()).toBeNull();

  FAKE_RELEASES['bots']!.version = '0.1.11';
  await release();
  await vi.waitFor(() => expect(notice()?.getAttribute('data-version')).toBe('0.1.11'));
});

test('Update installs the release and the notice leaves for good', async () => {
  const { call } = await show();
  await release();
  await vi.waitFor(() => expect(notice()).not.toBeNull());
  click('plugin-update-run');
  expect(notice()).toBeNull();
  expect(call).toHaveBeenCalledWith('plugins.install', { id: 'bots' });
  await vi.waitFor(async () => {
    const bots = (await client!.call('plugins.list', {})).find((plugin) => plugin.id === 'bots');
    expect(bots).toMatchObject({ status: 'installed', version: '0.1.10', updates: { available: null } });
  }, { timeout: 5_000 });
  expect(notice()).toBeNull();
});

test('a paired device neither reads the plugins nor sees a notice', async () => {
  const { call } = await show(false);
  await release();
  await new Promise((resolve) => setTimeout(resolve, 10));
  flushSync();
  expect(notice()).toBeNull();
  expect(call.mock.calls.map(([method]) => method)).not.toContain('plugins.list');
});

import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { HarnessUpdate } from '@boite/contracts';
import { FakeClient } from '../lib/fake-client';
import { Store } from '../lib/store.svelte';
import { workspace } from '../lib/workspace.svelte';
import HarnessUpdateNotices from './HarnessUpdateNotices.svelte';
import HarnessUpdatesCard from './HarnessUpdatesCard.svelte';

let mounted: ReturnType<typeof mount> | undefined;
afterEach(async () => {
  if (mounted) await unmount(mounted);
  mounted = undefined;
  workspace.machines = [];
  document.body.innerHTML = '';
  vi.useRealTimers();
});

const settle = async () => { for (let i = 0; i < 20; i++) { await Promise.resolve(); flushSync(); } };
const notices = () => [...document.querySelectorAll<HTMLElement>('[data-testid="harness-update-notice"]')];

async function machine(id: string, label: string): Promise<Store> {
  const store = new Store();
  store.machineId = id;
  store.attach(new FakeClient());
  await store.connect();
  await settle();
  workspace.machines = [...workspace.machines, { id, label, store }];
  return store;
}

test('a pending update is a notice that stays until Update or Skip, answered by its own machine', async () => {
  const local = await machine('local', 'This PC');
  const remote = await machine('http://builder.test', 'Builder');
  expect(local.harnessUpdates.filter((update) => update.pending)).toHaveLength(2);

  mounted = mount(HarnessUpdateNotices, { target: document.body });
  await settle();
  // Two agents behind on two machines, capped at three cards, each naming its machine.
  expect(notices()).toHaveLength(3);
  expect(notices()[0]!.textContent).toContain('Claude Code 2.1.278 is available');
  expect(notices()[0]!.textContent).toContain('On This PC');
  expect(notices()[2]!.textContent).toContain('On Builder');

  // Skip answers on the local machine only: the remote one still offers its own.
  notices()[0]!.querySelector<HTMLButtonElement>('[data-testid="harness-update-skip"]')!.click();
  await settle();
  expect(local.harnessUpdates.find((update) => update.providerId === 'claude')).toMatchObject({ pending: false, skipped: '2.1.278' });
  expect(remote.harnessUpdates.find((update) => update.providerId === 'claude')?.pending).toBe(true);
  expect(notices().map((notice) => notice.dataset['updateProvider'])).toEqual(['codex', 'claude', 'codex']);
});

test('Update shows the agent updating, then the notice leaves once the core says it is current', async () => {
  vi.useFakeTimers();
  const local = await machine('local', 'This PC');
  mounted = mount(HarnessUpdateNotices, { target: document.body });
  await settle();

  const codex = notices().find((notice) => notice.dataset['updateProvider'] === 'codex')!;
  // One machine: the notice does not name it.
  expect(codex.textContent).not.toContain('On This PC');
  codex.querySelector<HTMLButtonElement>('[data-testid="harness-update-run"]')!.click();
  await settle();
  const updating = notices().find((notice) => notice.dataset['updateProvider'] === 'codex')!;
  expect(updating.dataset['state']).toBe('updating');
  expect(updating.querySelector('button')).toBeNull();

  await vi.advanceTimersByTimeAsync(1500);
  await settle();
  expect(notices().map((notice) => notice.dataset['updateProvider'])).toEqual(['claude']);
  expect(local.harnessUpdates.find((update) => update.providerId === 'codex')).toMatchObject({ current: '0.155.1', pending: false });
});

test('a failed update keeps its notice, with the reason and a retry', async () => {
  const local = await machine('local', 'This PC');
  const failed: HarnessUpdate = { ...local.harnessUpdates[0]!, state: 'failed', pending: true, message: '`update` exited with 1: the disk is full' };
  local.harnessUpdates = [failed];
  mounted = mount(HarnessUpdateNotices, { target: document.body });
  await settle();
  expect(notices()).toHaveLength(1);
  expect(notices()[0]!.textContent).toContain('the disk is full');
  expect(notices()[0]!.querySelector('[data-testid="harness-update-run"]')!.textContent).toContain('Try again');
});

test('the settings card carries the automatic switch, the versions and a way back from a skip', async () => {
  const local = await machine('local', 'This PC');
  mounted = mount(HarnessUpdatesCard, { target: document.body, props: { store: local } });
  await settle();

  const rows = [...document.querySelectorAll<HTMLElement>('[data-testid="harness-update-row"]')];
  expect(rows.map((row) => row.dataset['updateProvider'])).toEqual(['claude', 'codex', 'opencode']);
  expect(rows[0]!.textContent).toContain('2.1.267 → 2.1.278');
  expect(rows[2]!.textContent).toContain('Up to date');

  const auto = document.querySelector<HTMLInputElement>('[data-testid="setting-auto-update-harnesses"]')!;
  expect(auto.checked).toBe(false);
  auto.click();
  await settle();
  expect(local.settings?.autoUpdateHarnesses).toBe(true);

  await local.skipHarnessUpdate('claude', '2.1.278');
  await settle();
  const unskip = document.querySelector<HTMLButtonElement>('[data-testid="harness-update-unskip"]')!;
  expect(unskip).not.toBeNull();
  unskip.click();
  await settle();
  expect(local.harnessUpdates.find((update) => update.providerId === 'claude')).toMatchObject({ skipped: null, pending: true });
});

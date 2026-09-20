import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { AccountQuota } from '@boite/contracts';
import type { Store } from '../lib/store.svelte';
import LimitsPage from './LimitsPage.svelte';

let mounted: ReturnType<typeof mount> | undefined;
afterEach(async () => { if (mounted) await unmount(mounted); mounted = undefined; document.body.innerHTML = ''; });

const settle = async () => { for (let i = 0; i < 20; i++) { await Promise.resolve(); flushSync(); } };
const quota = (providerName: string): AccountQuota => ({
  accountId: `${providerName}-account`, providerId: 'claude', providerName, label: 'Default', enabled: true,
  status: 'ready', windows: [{ id: 'week', label: 'Weekly', usedPercent: 20, resetsAt: null }], checkedAt: null, error: null,
});

test('a refresh asked while the first read is in flight keeps the refreshed rows', async () => {
  const pending: ((rows: AccountQuota[]) => void)[] = [];
  const call = vi.fn(async (method: string) => {
    if (method !== 'quotas.list') throw new Error(method);
    return new Promise<AccountQuota[]>((resolve) => { pending.push(resolve); });
  });
  mounted = mount(LimitsPage, { target: document.body, props: {
    store: { client: { call, on: () => () => {} }, connection: 'ready', owner: true } as unknown as Store,
  } });
  await settle();

  document.querySelector<HTMLButtonElement>('[data-testid="limits-refresh"]')!.click();
  await settle();
  expect(pending).toHaveLength(2);

  // The refresh answers first, then the read it overtook: the older rows stay out.
  pending[1]!([quota('Fresh')]);
  await settle();
  pending[0]!([quota('Stale')]);
  await settle();
  expect(document.body.textContent).toContain('Fresh');
  expect(document.body.textContent).not.toContain('Stale');
});

test('a device is told where the limits are read, and asks for none', async () => {
  const call = vi.fn(async () => []);
  mounted = mount(LimitsPage, { target: document.body, props: {
    store: { client: { call, on: () => () => {} }, connection: 'ready', owner: false } as unknown as Store,
  } });
  await settle();
  expect(document.querySelector('[data-testid="usage-limits-owner"]')).not.toBeNull();
  expect(document.querySelector('[data-testid="limits-refresh"]')).toBeNull();
  expect(call).not.toHaveBeenCalled();
});

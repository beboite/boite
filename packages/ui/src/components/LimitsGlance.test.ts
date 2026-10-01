import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { AccountQuota } from '@boite/contracts';
import type { Store } from '../lib/store.svelte';
import LimitsGlance from './LimitsGlance.svelte';

let mounted: ReturnType<typeof mount> | undefined;
afterEach(async () => { if (mounted) await unmount(mounted); mounted = undefined; document.body.innerHTML = ''; });

const settle = async () => { for (let i = 0; i < 20; i++) { await Promise.resolve(); flushSync(); } };
const quota: AccountQuota = {
  accountId: 'claude-account', providerId: 'claude', providerName: 'Claude', label: 'Default', enabled: true,
  status: 'ready', windows: [{ id: 'week', label: 'Weekly', usedPercent: 20, resetsAt: null }], checkedAt: null, error: null,
};

test('a failed first read says so and offers a retry instead of asking to connect a provider', async () => {
  let fail = true;
  const call = vi.fn(async () => { if (fail) throw new Error('core unreachable'); return [quota]; });
  const store = { client: { call, on: () => () => {} }, owner: true, endpointUrl: 'glance-failing-core', accounts: [{ id: 'claude-account', status: 'ok' }] } as unknown as Store;
  mounted = mount(LimitsGlance, { target: document.body, props: { store } });
  document.querySelector<HTMLButtonElement>('[data-testid="nav-limits"]')!.click();
  await settle();

  expect(document.querySelector('[data-testid="limits-glance-error"]')!.textContent).toContain('core unreachable');
  expect(document.querySelector('[data-testid="quota-empty"]')).toBeNull();

  fail = false;
  document.querySelector<HTMLButtonElement>('[data-testid="limits-glance-retry"]')!.click();
  await settle();
  expect(call).toHaveBeenLastCalledWith('quotas.list', { refresh: true, requestId: expect.any(String) });
  expect(document.querySelector('[data-testid="limits-glance-error"]')).toBeNull();
  expect(document.querySelectorAll('[data-testid="quota-provider"]')).toHaveLength(1);
});

test('a failed refresh keeps the rows already read on screen under the error', async () => {
  let fail = false;
  const call = vi.fn(async () => { if (fail) throw new Error('timed out'); return [quota]; });
  const store = { client: { call, on: () => () => {} }, owner: true, endpointUrl: 'glance-refresh-core', accounts: [{ id: 'claude-account', status: 'ok' }] } as unknown as Store;
  mounted = mount(LimitsGlance, { target: document.body, props: { store } });
  document.querySelector<HTMLButtonElement>('[data-testid="nav-limits"]')!.click();
  await settle();
  expect(document.querySelectorAll('[data-testid="quota-provider"]')).toHaveLength(1);

  fail = true;
  document.querySelector<HTMLButtonElement>('[data-testid="limits-glance-refresh"]')!.click();
  await settle();
  expect(document.querySelector('[data-testid="limits-glance-error"]')!.textContent).toContain('timed out');
  expect(document.querySelectorAll('[data-testid="quota-provider"]')).toHaveLength(1);
});

test('an individual quota failure shows its reason beside the provider', async () => {
  const row = { ...quota, providerId: 'grok', providerName: 'Grok', windows: [], status: 'unavailable', error: 'Grok login is missing or expired. Run grok login, then refresh.' };
  const store = { client: { call: async () => [row], on: () => () => {} }, owner: true, endpointUrl: 'glance-grok-error', accounts: [] } as unknown as Store;
  mounted = mount(LimitsGlance, { target: document.body, props: { store } });
  document.querySelector<HTMLButtonElement>('[data-testid="nav-limits"]')!.click();
  await settle();
  const provider = document.querySelector('[data-testid="quota-provider"][data-provider="grok"]')!;
  expect(provider.querySelector('[role="status"]')?.textContent).toContain(row.error);
});

test('the glance shows fallback allowances without expanding and dates cached Muse observations', async () => {
  const row: AccountQuota = { ...quota,
    windows: [{ ...quota.windows[0]!, usedPercent: 100 }], resetCredits: { availableCount: 1, nextExpiresAt: null },
    credits: { kind: 'balance', enabled: true, remaining: 0.04, limit: null, unlimited: false } };
  const observed: AccountQuota = { ...quota, accountId: 'muse-account', providerId: 'muse', providerName: 'Muse Code', source: 'observation', checkedAt: Date.now() - 600_000 };
  const store = { client: { call: async () => [row, observed], on: () => () => {} }, owner: true, endpointUrl: 'glance-observed-core', accounts: [] } as unknown as Store;
  mounted = mount(LimitsGlance, { target: document.body, props: { store } });
  document.querySelector<HTMLButtonElement>('[data-testid="nav-limits"]')!.click();
  await settle();
  expect(document.body.textContent).toContain('Observed');
  expect(document.querySelector('[data-testid=quota-banked-resets]')).toBeNull();
  expect(document.body.textContent).toContain('0.04 credits');
  expect(document.querySelector('[aria-expanded="false"][aria-controls="usage-claude-account"]')).not.toBeNull();
});

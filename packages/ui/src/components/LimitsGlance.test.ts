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
  expect(call).toHaveBeenLastCalledWith('quotas.list', { refresh: true });
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

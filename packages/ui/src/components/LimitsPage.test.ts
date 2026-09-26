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

test('the last reading stays up while the next one loads, and only signed-in accounts the user reads are listed', async () => {
  let answer: ((rows: AccountQuota[]) => void) | undefined;
  const call = vi.fn(async () => new Promise<AccountQuota[]>((resolve) => { answer = resolve; }));
  const rows: AccountQuota[] = [
    { ...quota('Claude'), accountId: 'signed-in' },
    { ...quota('Claude'), accountId: 'signed-out' },
    { ...quota('Antigravity'), accountId: 'quota:antigravity-cli', providerId: 'antigravity', enabled: false, status: 'disabled', windows: [] },
    { ...quota('Pi'), accountId: 'pi', providerId: 'pi', status: 'unsupported', windows: [] },
  ];
  const accounts = [{ id: 'signed-in', status: 'ok' }, { id: 'signed-out', status: 'unauthenticated' }];
  const store = { client: { call, on: () => () => {} }, connection: 'ready', owner: true, endpointUrl: 'cached-core', accounts } as unknown as Store;
  mounted = mount(LimitsPage, { target: document.body, props: { store } });
  await settle();
  answer!(rows);
  await settle();
  expect(document.querySelectorAll('[data-testid="usage-limit-account"]')).toHaveLength(1);
  expect(document.body.textContent).not.toContain('Antigravity');
  await unmount(mounted);

  // Opened again, the page draws the reading it had while a new one is on its way.
  mounted = mount(LimitsPage, { target: document.body, props: { store } });
  await settle();
  expect(call).toHaveBeenCalledTimes(2);
  expect(document.querySelectorAll('[data-testid="usage-limit-account"]')).toHaveLength(1);
  expect(document.querySelector('[data-testid="usage-limits"]')!.classList.contains('loading')).toBe(true);
  expect(document.querySelector('[data-testid="limits-refresh"]')!.getAttribute('aria-busy')).toBe('true');
  answer!(rows);
  await settle();
  expect(document.querySelector('[data-testid="usage-limits"]')!.classList.contains('loading')).toBe(false);
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

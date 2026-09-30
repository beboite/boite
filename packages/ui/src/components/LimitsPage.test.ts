import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { AccountQuota } from '@boite/contracts';
import { SvelteMap } from 'svelte/reactivity';
import type { Store } from '../lib/store.svelte';
import { strings } from '../lib/strings';
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
  expect(document.querySelector('[data-testid="usage-limits"]')!.textContent).not.toContain('Antigravity');
  // The switches: the signed-in account on, the CLI source off, nothing for a signed-out account or a provider with no limits.
  const switches = [...document.querySelectorAll<HTMLInputElement>('[data-testid="quota-monitor"]')];
  expect(switches.map((input) => [input.dataset.accountId, input.checked])).toEqual([['signed-in', true], ['quota:antigravity-cli', false]]);
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

test('the read waits for the socket, a failure shows with a retry, and a kept reading reads as stale', async () => {
  const pending: { resolve(rows: AccountQuota[]): void; reject(error: Error): void }[] = [];
  const call = vi.fn(async () => new Promise<AccountQuota[]>((resolve, reject) => { pending.push({ resolve, reject }); }));
  const state = new SvelteMap([['connection', 'connecting']]);
  const store = { client: { call, on: () => () => {} }, owner: true, endpointUrl: 'socket-core', get connection() { return state.get('connection'); } } as unknown as Store;
  mounted = mount(LimitsPage, { target: document.body, props: { store } });
  await settle();
  // A call now would be refused with "not connected" and never asked again.
  expect(call).not.toHaveBeenCalled();
  state.set('connection', 'ready');
  await settle();
  expect(call).toHaveBeenCalledTimes(1);

  pending[0]!.reject(new Error('socket dropped'));
  await settle();
  expect(document.querySelector('[data-testid="limits-error"]')!.textContent).toContain('socket dropped');
  expect(document.querySelector('[data-testid="limits-empty"]')).toBeNull();

  document.querySelector<HTMLButtonElement>('[data-testid="limits-retry"]')!.click();
  await settle();
  const stale = { ...quota('Claude'), accountId: 'claude', status: 'unavailable', checkedAt: Date.UTC(2026, 8, 30, 9), error: 'Claude quota requests are rate limited. Retrying in five minutes.' } satisfies AccountQuota;
  const agy = { ...quota('Antigravity'), accountId: 'quota:antigravity-cli', providerId: 'antigravity', status: 'unavailable', windows: [] } satisfies AccountQuota;
  pending[1]!.resolve([stale, agy]);
  await settle();
  expect(document.querySelector('[data-testid="limits-error"]')).toBeNull();
  const [claudeCard, agyCard] = [...document.querySelectorAll<HTMLElement>('[data-testid="usage-limit-account"]')];
  expect(claudeCard!.classList.contains('stale')).toBe(true);
  expect(claudeCard!.querySelector('[data-testid="usage-limit-stale"]')!.textContent).toContain(strings.quotas.stale);
  expect(claudeCard!.textContent).toContain('rate limited');
  expect(agyCard!.textContent).toContain(strings.quotas.unavailable);

  // While a read runs, a row with nothing yet says it is being read, not that there is nothing.
  document.querySelector<HTMLButtonElement>('[data-testid="limits-refresh"]')!.click();
  await settle();
  expect(agyCard!.textContent).toContain(strings.quotas.loading);
  expect(agyCard!.textContent).toContain(strings.quotas.slowHint);
  expect(agyCard!.textContent).not.toContain(strings.quotas.unavailable);

  // A reconnect reads again.
  state.set('connection', 'connecting');
  await settle();
  state.set('connection', 'ready');
  await settle();
  expect(call).toHaveBeenCalledTimes(4);
});

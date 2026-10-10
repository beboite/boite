import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { AccountQuota } from '@boite/contracts';
import { SvelteMap } from 'svelte/reactivity';
import { Store } from '../lib/store.svelte';
import { strings } from '../lib/strings';
import LimitsPage from './LimitsPage.svelte';
import { FakeClient } from '../lib/fake-client';
import { quotaReader, REFRESH_SHOWN_MS } from '../lib/quota-reader.svelte';

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
  // A retry is a refresh: its answer shows once the refresh's minimum is over.
  await new Promise((resolve) => setTimeout(resolve, REFRESH_SHOWN_MS));
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


test('renaming a tracked subscription updates cached cards immediately and cancelling leaves it alone', async () => {
  const store = new Store();
  const client = new FakeClient({ delayMs: 0 });
  store.attach(client);
  await store.connect();
  const read = vi.spyOn(client, 'call');
  mounted = mount(LimitsPage, { target: document.body, props: { store } });
  await vi.waitFor(() => expect(document.querySelector('[data-testid="tracked-account"][data-account-id="a-codex"]')).not.toBeNull());
  const row = () => document.querySelector<HTMLElement>('[data-testid="tracked-account"][data-account-id="a-codex"]')!;
  try {
    row().querySelector<HTMLButtonElement>('[data-testid="account-rename"]')!.click(); flushSync();
    const input = row().querySelector<HTMLInputElement>('[data-testid="account-name"]')!;
    expect(document.activeElement).toBe(input);
    input.value = ' ';
    input.dispatchEvent(new Event('input', { bubbles: true })); flushSync();
    expect(row().querySelector<HTMLButtonElement>('[data-testid="account-save"]')!.disabled).toBe(true);
    input.value = ' Personal ';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(store.accountOf('a-codex')!.label).toBe('Personal'));
    await settle();
    expect(document.querySelector('[data-testid="usage-limit-provider"][data-account-id="a-codex"] strong')!.textContent).toBe('Personal');
    expect(row().querySelector('.account')!.textContent).toBe('Personal');
    // No quota refresh is needed and the cache itself still has the older label.
    expect(read.mock.calls.filter(([method]) => method === 'quotas.list')).toHaveLength(1);
    expect(quotaReader(store.endpointUrl ?? 'here').rows!.find(row => row.accountId === 'a-codex')!.label).toBe('Default');
    row().querySelector<HTMLButtonElement>('[data-testid="account-rename"]')!.click(); flushSync();
    row().querySelector<HTMLInputElement>('[data-testid="account-name"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();
    expect(row().querySelector('[data-testid="account-name"]')).toBeNull();
    expect(document.activeElement).toBe(row().querySelector('[data-testid="account-rename"]'));
    expect(store.accountOf('a-codex')!.label).toBe('Personal');
  } finally { store.detach(); client.close(); }
});

const douane = { enabled: true, kind: 'douane' as const, baseUrl: 'http://gateway.test:8787', dashboardUrl: 'http://gateway.test:8787/admin/#quotas' };

test('Douane quotas are native cards grouped by provider, with plan, status, credits and an average count', async () => {
  const store = new Store();
  const client = new FakeClient({ delayMs: 0 });
  store.attach(client);
  await store.connect();
  store.settings = await client.call('subscriptionProxy.configure', { subscriptionProxy: douane });
  const open = vi.spyOn(window, 'open').mockReturnValue(null);
  mounted = mount(LimitsPage, { target: document.body, props: { store } });
  try {
    await vi.waitFor(() => expect(document.querySelectorAll('[data-testid="gateway-quotas"]')).toHaveLength(3));
    expect(document.querySelector('[data-testid="subscription-proxy-dashboard-page"]')).toBeNull();
    const groups = [...document.querySelectorAll<HTMLElement>('[data-testid="gateway-quotas"]')];
    expect(groups.map(group => group.dataset.provider)).toEqual(['claude', 'codex', 'antigravity']);
    expect(groups[0]!.querySelector('h2')!.textContent).toContain('via Douane');
    const claude = groups[0]!.querySelectorAll('[data-testid="usage-limit-provider"]');
    expect(claude).toHaveLength(2);
    expect(claude[0]!.querySelector('[data-testid="usage-limit-plan"]')!.textContent).toBe('Max 20x');
    expect(claude[1]!.querySelector('[data-testid="usage-limit-status"]')!.textContent).toBe('Cooling down');
    expect(claude[0]!.querySelectorAll('[role="meter"]')).toHaveLength(2);
    expect(groups[1]!.querySelector('[data-testid="usage-limit-credit"]')!.textContent).toMatch(/Credits.*62,500 credits/);
    // An average stands for its accounts: Boite names it, in the app's language.
    expect(groups[2]!.querySelector('strong')!.textContent).toBe('Antigravity · 10 accounts');
    // The gateway's entries are always read: no monitor switch for them.
    expect(document.querySelector('[data-testid="quota-monitor"][data-account-id^="proxy:"]')).toBeNull();
    document.querySelector<HTMLButtonElement>('[data-testid="subscription-proxy-open"]')!.click();
    expect(open).toHaveBeenCalledWith(douane.dashboardUrl, '_blank', 'noopener,noreferrer');
  } finally { store.detach(); client.close(); }
});

test('CLIProxyAPI and a Douane without the route keep the embedded dashboard', async () => {
  for (const [kind, status] of [['cliproxyapi', 'unsupported'], ['douane', 'unsupported']] as const) {
    const call = vi.fn(async (method: string) => method === 'subscriptionProxy.quotas'
      ? { status, providers: [], updatedAt: null, checkedAt: null, error: null } : []);
    mounted = mount(LimitsPage, { target: document.body, props: {
      store: { client: { call, on: () => () => {} }, connection: 'ready', owner: true, endpointUrl: `fallback-${kind}`,
        settings: { subscriptionProxy: { ...douane, kind } } } as unknown as Store,
    } });
    await settle();
    expect(document.querySelector('[data-testid="subscription-proxy-dashboard-page"]'), kind).not.toBeNull();
    expect(document.querySelector('[data-testid="gateway-quotas"]')).toBeNull();
    // CLIProxyAPI has no quotas route to ask.
    expect(call.mock.calls.some(([method]) => method === 'subscriptionProxy.quotas')).toBe(kind === 'douane');
    await unmount(mounted); mounted = undefined;
  }
});

test('a failed Douane read shows once above its dimmed last bars', async () => {
  const error = 'Douane quotas returned HTTP 502.';
  const row: AccountQuota = { ...quota('Claude'), accountId: 'proxy:claude:one', status: 'unavailable', error, checkedAt: Date.UTC(2026, 9, 4, 9),
    gateway: { kind: 'douane', entryId: 'one', display: 'accounts', plan: null, accounts: 1, status: 'ready', credits: [] } };
  const call = vi.fn(async (method: string) => method === 'subscriptionProxy.quotas'
    ? { status: 'unavailable', providers: [], updatedAt: null, checkedAt: row.checkedAt, error } : [row]);
  mounted = mount(LimitsPage, { target: document.body, props: {
    store: { client: { call, on: () => () => {} }, connection: 'ready', owner: true, endpointUrl: 'gateway-failed',
      settings: { subscriptionProxy: douane } } as unknown as Store,
  } });
  await settle();
  expect(document.querySelector('[data-testid="gateway-quotas-error"]')!.textContent).toContain(error);
  expect(document.body.textContent!.split(error)).toHaveLength(2);
  expect(document.querySelector('[data-testid="usage-limit-account"]')!.classList.contains('stale')).toBe(true);
});
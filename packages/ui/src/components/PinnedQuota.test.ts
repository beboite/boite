import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { AccountQuota } from '@boite/contracts';
import type { Store } from '../lib/store.svelte';
import { pinnedQuotas } from '../lib/pinned-quotas.svelte';
import { setExperiment } from '../lib/experiments';
import { strings } from '../lib/strings';
import PinnedQuota from './PinnedQuota.svelte';
import QuotaPin from './QuotaPin.svelte';

let mounted: ReturnType<typeof mount> | undefined;
afterEach(async () => {
  if (mounted) await unmount(mounted);
  mounted = undefined;
  document.body.innerHTML = '';
  pinnedQuotas.set(false, 'bottom-left');
  setExperiment('pinned-quotas', false);
  vi.useRealTimers();
});
const settle = async () => { for (let i = 0; i < 20; i++) { await Promise.resolve(); flushSync(); } };
const row: AccountQuota = {
  accountId: 'claude-main', providerId: 'claude', providerName: 'Claude', label: 'Personal', enabled: true,
  status: 'ready', windows: [{ id: 'weekly', label: 'Weekly', usedPercent: 35, resetsAt: null }], checkedAt: 1, error: null,
};
let sequence = 0;
function fixture(owner = true) {
  const off = vi.fn();
  const call = vi.fn(async () => [row]);
  const store = {
    endpointUrl: `pinned-component-${++sequence}`, owner, connection: 'ready', visible: true, settings: null, accounts: [], providers: [],
    openThread: { providerId: 'claude', accountId: row.accountId, model: 'claude-opus-5-5' },
    composerChoice: (choice: unknown) => choice, providerOf: () => ({ id: 'claude', protocol: 'claude-sdk' }), modelOf: () => null,
    client: { call, on: () => off },
  } as unknown as Store;
  return { store, off, call };
}

test('pin is opt-in and remembers both placement and unpinning', async () => {
  mounted = mount(QuotaPin, { target: document.body });
  await settle();
  expect(document.querySelector('[data-testid=quota-pin]')).toBeNull();
  setExperiment('pinned-quotas', true);
  await settle();
  document.querySelector<HTMLButtonElement>('[data-testid=quota-pin]')!.click();
  await settle();
  expect(pinnedQuotas.current).toEqual({ pinned: true, position: 'bottom-left' });
  pinnedQuotas.set(true, 'dock');
  await settle();
  document.querySelector<HTMLButtonElement>('[data-testid=quota-pin]')!.click();
  expect(pinnedQuotas.current).toEqual({ pinned: false, position: 'dock' });
  expect(JSON.parse(localStorage.getItem('boite.pinned-quotas.v1')!)).toEqual({ pinned: false, position: 'dock' });
});

test('failed refresh keeps the previous bars and a later read clears the failure', async () => {
  vi.useFakeTimers();
  const f = fixture();
  mounted = mount(PinnedQuota, { target: document.body, props: { store: f.store } });
  await settle();
  expect(document.querySelector('[role=meter]')?.getAttribute('aria-valuenow')).toBe('65');
  f.call.mockRejectedValueOnce(new Error('gateway unreachable'));
  document.querySelector<HTMLButtonElement>('[data-testid=pinned-quota-refresh]')!.click();
  await settle();
  expect(f.call).toHaveBeenLastCalledWith('quotas.list', { refresh: true, requestId: expect.any(String) });
  expect(document.querySelector('[role=alert]')?.textContent).toContain('gateway unreachable');
  expect(document.querySelector('[role=meter]')?.getAttribute('aria-valuenow')).toBe('65');
  await vi.advanceTimersByTimeAsync(1000);
  await settle();
  document.querySelector<HTMLButtonElement>('[data-testid=pinned-quota-refresh]')!.click();
  await settle();
  expect(document.querySelector('[role=alert]')).toBeNull();
  await unmount(mounted);
  mounted = undefined;
  expect(f.off).toHaveBeenCalled();
  const reads = f.call.mock.calls.length;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(f.call).toHaveBeenCalledTimes(reads);
});

test('paired refresh reads the owning core cache without forcing a provider read', async () => {
  const f = fixture(false);
  mounted = mount(PinnedQuota, { target: document.body, props: { store: f.store } });
  await settle();
  document.querySelector<HTMLButtonElement>('[data-testid=pinned-quota-refresh]')!.click();
  await settle();
  expect(f.call).toHaveBeenLastCalledWith('quotas.list', { refresh: false, requestId: expect.any(String) });
});

test('a wallet quota is displayed without claiming the reading is unavailable', async () => {
  const f = fixture();
  f.call.mockResolvedValue([{ ...row, windows: [], credits: { kind: 'balance', remaining: 50, limit: null, unlimited: false, enabled: true } }]);
  mounted = mount(PinnedQuota, { target: document.body, props: { store: f.store } });
  await settle();
  expect(document.querySelector('[data-testid=quota-credits]')).not.toBeNull();
  expect(document.body.textContent).not.toContain(strings.quotas.noReading);
});

test('the focused card keeps keyboard placement without a move button', async () => {
  const f = fixture();
  mounted = mount(PinnedQuota, { target: document.body, props: { store: f.store } });
  await settle();
  const card = document.querySelector<HTMLElement>('[data-testid=pinned-quota]')!;
  expect(document.querySelector('[data-testid=pinned-quota-position]')).toBeNull();
  expect(card.tabIndex).toBe(0);
  card.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  await settle();
  expect(pinnedQuotas.current.position).toBe('bottom-right');
  card.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
  await settle();
  expect(pinnedQuotas.current.position).toBe('top-right');
  card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
  await settle();
  expect(pinnedQuotas.current.position).toBe('dock');
});

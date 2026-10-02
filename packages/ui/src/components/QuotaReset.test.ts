import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { AccountQuota, QuotaResetResult } from '@boite/contracts';
import type { Store } from '../lib/store.svelte';
import { confirm } from '../lib/confirm.svelte';
import { quotaReader } from '../lib/quota-reader.svelte';
import { strings } from '../lib/strings';
import ConfirmDialog from './ConfirmDialog.svelte';
import QuotaReset from './QuotaReset.svelte';

const mounted: ReturnType<typeof mount>[] = [];
afterEach(async () => {
  confirm.answer(false);
  for (const component of mounted.splice(0)) await unmount(component);
  document.body.innerHTML = '';
});
const settle = async () => { for (let i = 0; i < 20; i++) { await Promise.resolve(); flushSync(); } };
const click = (id: string) => document.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!.click();
let sequence = 0;
const row: AccountQuota = { accountId: 'fixture-account', providerId: 'codex', providerName: 'Codex', label: 'Work subscription',
  enabled: true, status: 'ready', windows: [{ id: 'week', label: 'Weekly', usedPercent: 100, resetsAt: null }],
  checkedAt: 1, error: null, resetCredits: { availableCount: 1, nextExpiresAt: null } };
const result: QuotaResetResult = { outcome: 'reset', quota: { ...row, windows: [{ ...row.windows[0]!, usedPercent: 0 }], resetCredits: { availableCount: 0, nextExpiresAt: null } } };

async function render(options: { quota?: AccountQuota; call?: ReturnType<typeof vi.fn>; disabled?: boolean; connection?: 'idle' | 'ready' } = {}) {
  const call = options.call ?? vi.fn(async () => result);
  const state = { client: { call }, endpointUrl: `quota-reset-test-${++sequence}`, owner: true, connection: options.connection ?? 'ready',
    accounts: [{ id: row.accountId, identity: 'fixture@example.invalid' }] };
  const store = state as unknown as Store;
  mounted.push(mount(QuotaReset, { target: document.body, props: { row: options.quota ?? row, store, disabled: options.disabled ?? false } }));
  mounted.push(mount(ConfirmDialog, { target: document.body }));
  await settle();
  return { store, call, state };
}

test('a bare click only asks confirmation, names the subscription and focuses Cancel', async () => {
  const { call } = await render();
  click('quota-use-reset');
  await settle();
  expect(document.querySelector('[data-testid="confirm-dialog"]')?.textContent).toContain('Work subscription');
  expect(document.querySelector('[data-testid="confirm-dialog"]')?.textContent).toContain(strings.quotas.resetConfirmBody.replace('{provider}', 'Codex'));
  expect(document.querySelector('[data-testid="confirm-dialog"]')?.getAttribute('aria-describedby')).toBe('confirm-body');
  expect(document.activeElement?.getAttribute('data-testid')).toBe('confirm-cancel');
  expect(call).not.toHaveBeenCalled();
  click('confirm-cancel');
  await settle();
  expect(call).not.toHaveBeenCalled();
  click('quota-use-reset');
  await settle();
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await settle();
  expect(confirm.current).toBeNull();
  expect(call).not.toHaveBeenCalled();
});

test('explicit confirmation sends once, blocks repeated clicks and applies the fresh account reading', async () => {
  let release!: (result: QuotaResetResult) => void;
  const call = vi.fn(() => new Promise<QuotaResetResult>(resolve => { release = resolve; }));
  const { store } = await render({ call });
  click('quota-use-reset'); await settle();
  const confirmation = document.querySelector<HTMLButtonElement>('[data-testid="confirm-ok"]')!;
  confirmation.click(); confirmation.click(); await settle();
  click('quota-use-reset'); click('quota-use-reset'); await settle();
  expect(call).toHaveBeenCalledExactlyOnceWith('quotas.reset', { accountId: row.accountId, confirmed: true });
  expect(document.querySelector<HTMLButtonElement>('[data-testid="quota-use-reset"]')!.disabled).toBe(true);
  release(result); await settle();
  expect(quotaReader(store.endpointUrl!).rows).toContainEqual(result.quota);
  expect(document.querySelector('[data-testid="quota-reset-status"]')?.textContent).toBe(strings.quotas.resetApplied);
});

test('changing the owning connection while confirmation is open cancels without sending', async () => {
  const { state, call } = await render();
  click('quota-use-reset'); await settle();
  state.client = { call: vi.fn() };
  click('confirm-ok'); await settle();
  expect(call).not.toHaveBeenCalled();
});

test('a late reset result updates only its original machine and cannot claim success on a different connection', async () => {
  let release!: (result: QuotaResetResult) => void;
  const call = vi.fn(() => new Promise<QuotaResetResult>(resolve => { release = resolve; }));
  const { store, state } = await render({ call });
  const original = quotaReader(store.endpointUrl!);
  click('quota-use-reset'); await settle(); click('confirm-ok'); await settle();
  state.client = { call: vi.fn() };
  state.endpointUrl = `another-machine-${sequence}`;
  release(result); await settle();
  expect(original.rows).toContainEqual(result.quota);
  expect(quotaReader(state.endpointUrl).rows).toBeNull();
  expect(document.querySelector('[data-testid="quota-reset-status"]')).toBeNull();
});

test.each([{ disabled: true, connection: 'ready' }, { disabled: false, connection: 'idle' }] as const)('a pending read or idle connection blocks reset: %j', async options => {
  const { call } = await render(options);
  click('quota-use-reset'); await settle();
  expect(confirm.current).toBeNull();
  expect(call).not.toHaveBeenCalled();
});

test('a confirmed reset with an unavailable refresh reports that limitation, and a failed request reports its error', async () => {
  const call = vi.fn().mockResolvedValueOnce({ ...result, quota: { ...row, status: 'unavailable', error: 'Fixture offline' } }).mockRejectedValueOnce(new Error('Fixture timeout'));
  await render({ call });
  click('quota-use-reset'); await settle(); click('confirm-ok'); await settle();
  expect(document.querySelector('[data-testid="quota-reset-status"]')?.textContent).toBe(strings.quotas.resetRefreshFailed);
  click('quota-use-reset'); await settle(); click('confirm-ok'); await settle();
  expect(document.querySelector('[data-testid="quota-reset-status"]')?.textContent).toContain('Fixture timeout');
});

test('unavailable readings keep the reset action hidden', async () => {
  await render({ quota: { ...row, status: 'unavailable', error: 'Fixture offline' } });
  expect(document.querySelector('[data-testid="quota-use-reset"]')).toBeNull();
});

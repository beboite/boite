import { afterEach, expect, test } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { AccountQuota } from '@boite/contracts';
import QuotaOverview from './QuotaOverview.svelte';
import { quotaResetTime } from '../lib/format';

let component: ReturnType<typeof mount> | undefined;
afterEach(async () => { if (component) await unmount(component); component = undefined; document.body.innerHTML = ''; });

const quota = (accountId: string, label: string, usedPercent: number): AccountQuota => ({
  accountId, providerId: 'codex', providerName: 'Codex', label, enabled: true, status: 'ready',
  windows: [{ id: 'week', label: 'Weekly', usedPercent, resetsAt: null }], checkedAt: null, error: null,
});

test('each subscription has its own name, limits, error and expansion beside the provider logo', () => {
  component = mount(QuotaOverview, { target: document.body, props: {
    rows: [{ ...quota('personal', 'Personal', 10), credits: { kind: 'balance', enabled: null, remaining: 42, limit: null, unlimited: false } }, { ...quota('work', 'Work', 90), error: 'Work quota unavailable', status: 'unavailable' }], connect: () => {},
  } });
  flushSync();
  const rows = [...document.querySelectorAll<HTMLElement>('[data-testid="quota-provider"]')];
  expect(rows.map(row => row.querySelector('.name')!.textContent)).toEqual(['Personal', 'Work']);
  expect(rows.map(row => row.querySelector('.amount')!.textContent)).toEqual(['90%', '10%']);
  expect(rows.map(row => row.querySelector('[data-logo]')!.getAttribute('data-logo'))).toEqual(['codex', 'codex']);
  expect(rows[0]!.textContent).not.toContain('unavailable');
  expect(rows[0]!.querySelector('[data-testid=quota-credits]')!.textContent).toContain('42 credits');
  expect(rows[1]!.querySelector('[data-testid=quota-credits]')).toBeNull();
  expect(rows[1]!.querySelector('.meters')!.classList.contains('stale')).toBe(true);
  rows[0]!.querySelector<HTMLButtonElement>('button')!.click(); flushSync();
  expect(document.querySelectorAll('.details')).toHaveLength(1);
  expect(rows[0]!.querySelector('.details')!.textContent).toContain('90% left');
  rows[1]!.querySelector<HTMLButtonElement>('button')!.click(); flushSync();
  expect(rows[0]!.querySelector('.details')).toBeNull();
  expect(rows[1]!.querySelector('.details')!.textContent).toContain('10% left');
});

test('exhausted subscriptions put an available allowance first without claiming unconfirmed automatic spending', () => {
  const balance = { kind: 'balance' as const, enabled: true, remaining: 42.5, limit: null, unlimited: false };
  const variants = [
    { ...quota('paid', 'Personal', 100), credits: balance },
    { ...quota('unknown', 'Work', 100), credits: { ...balance, enabled: null } },
    { ...quota('stale', 'Stale', 100), credits: balance, status: 'unavailable' as const },
    { ...quota('empty', 'Empty', 100), credits: { ...balance, remaining: 0 } },
    { ...quota('rounded', 'Almost exhausted', 99.99), credits: balance },
  ];
  component = mount(QuotaOverview, { target: document.body, props: { rows: variants, connect: () => {} } });
  flushSync();
  const paid = document.querySelector('[data-account-id="paid"]')!;
  expect(paid.querySelector('.paid-label')!.textContent).toBe('Using credits');
  expect(paid.querySelector('.paid-amount')!.textContent).toBe('42.5 credits');
  expect(paid.querySelector('.amount')).toBeNull();
  expect(paid.querySelector('.meters')).toBeNull();
  expect(document.querySelector('[data-account-id="unknown"] .paid-label')!.textContent).toBe('Credits remaining');
  for (const id of ['stale', 'empty', 'rounded']) expect(document.querySelector(`[data-account-id="${id}"] .paid`)).toBeNull();
});

test('profile labels stay visible even for Default; missing labels fall back to the provider', async () => {
  for (const [label, name] of [['Default', 'Default'], ['Personal', 'Personal'], ['', 'Codex']]) {
    component = mount(QuotaOverview, { target: document.body, props: { rows: [quota('only', label!, 10)], connect: () => {} } });
    flushSync();
    expect(document.querySelector('.name')!.textContent).toBe(name);
    await unmount(component); component = undefined;
  }
});

test('an unread account remains reorderable from its row with the keyboard', () => {
  const writes: string[][] = [];
  component = mount(QuotaOverview, { target: document.body, props: {
    rows: [quota('known', 'Personal', 10), { ...quota('unread', 'Work', 0), windows: [] }],
    connect: () => {}, onreorder: async (ids) => { writes.push(ids); return true; },
  } });
  flushSync();
  const row = document.querySelector<HTMLButtonElement>('[data-account-id="unread"] .summary')!;
  expect(row.disabled).toBe(false);
  row.focus();
  row.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
  flushSync();
  expect(writes).toEqual([['unread', 'known']]);
  expect(document.querySelector('[data-testid="quota-provider"]')!.getAttribute('data-account-id')).toBe('unread');
  expect(document.activeElement).toBe(row);
});

test('the headline and reset come from the primary window, and hidden kinds leave the meters', () => {
  const soon = Date.now() + 3_600_000, later = Date.now() + 4 * 86_400_000;
  const row: AccountQuota = { ...quota('famille', 'Famille', 0), windows: [
    { id: 'five-hour', label: '5 hours', usedPercent: 51, resetsAt: soon },
    { id: 'seven-day', label: 'Weekly', usedPercent: 31, resetsAt: later },
  ] };
  component = mount(QuotaOverview, { target: document.body, props: { rows: [row], connect: () => {} } });
  flushSync();
  const article = () => document.querySelector<HTMLElement>('[data-testid="quota-provider"]')!;
  expect(article().querySelector('.amount')!.textContent).toBe('69%');
  expect(article().querySelectorAll('.mini-window')).toHaveLength(2);
  expect(article().querySelector('.caption.reset')!.textContent).toBe(quotaResetTime(later));
  unmount(component);
  document.body.innerHTML = '';
  component = mount(QuotaOverview, { target: document.body, props: { rows: [row], connect: () => {},
    display: { quotaHiddenWindows: ['weekly'], quotaPrimary: {} } } });
  flushSync();
  expect(article().querySelector('.amount')!.textContent).toBe('49%');
  expect(article().querySelectorAll('.mini-window')).toHaveLength(1);
  expect(article().querySelector('.caption.reset')!.textContent).toBe(quotaResetTime(soon));
});

import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { AccountQuota, Settings } from '@boite/contracts';
import type { Store } from '../lib/store.svelte';
import { setLocaleSetting } from '../lib/i18n.svelte';
import EffortSlider from './EffortSlider.svelte';
import UsageLimits from './UsageLimits.svelte';

let component: ReturnType<typeof mount> | undefined;

afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  document.body.innerHTML = '';
  await setLocaleSetting('en');
});

const friday = new Date(2026, 8, 25, 3, 30).getTime();
const quota: AccountQuota = {
  accountId: 'claude-default', providerId: 'claude', providerName: 'Claude', label: 'Work', enabled: true, status: 'ready',
  windows: [
    { id: 'five_hour', label: '5 hours', usedPercent: 13.5, resetsAt: friday },
    { id: 'seven_day', label: 'Weekly', usedPercent: 40, resetsAt: friday }
  ],
  checkedAt: friday, error: null
} as AccountQuota;

test('the limits and the effort chip read in French when the app speaks French, whatever the system', async () => {
  await setLocaleSetting('fr');
  component = mount(UsageLimits, { target: document.body, props: { rows: [quota] } });
  flushSync();
  const limits = document.body.textContent ?? '';
  expect(limits).toContain('5 heures');
  expect(limits).toContain('Hebdomadaire');
  expect(limits).toContain('86,5 % restants');
  expect(limits).not.toMatch(/Weekly|5 hours|Fri|AM|PM/);
  unmount(component);

  document.body.innerHTML = '';
  component = mount(EffortSlider, { target: document.body, props: {
    levels: [{ id: 'medium', label: 'Medium' }, { id: 'high', label: 'High' }], active: 'high', onpick: () => {},
    speeds: [{ id: 'fast', label: 'Fast' }], speed: 'fast', onspeed: () => {}
  } });
  flushSync();
  const chip = document.body.textContent ?? '';
  expect(chip).toContain('Élevé');
  expect(chip).not.toMatch(/High|Fast/);
  // The chip carries the fast mode as a bolt; its name is the bolt's title.
  const bolt = document.querySelector<HTMLElement>('[data-testid="effort-fast-mark"]')!;
  expect(bolt.title).toBe('Rapide');
});

test('exhausted accounts show read-only resets and the enabled monthly budget in French', async () => {
  await setLocaleSetting('fr');
  const row: AccountQuota = { ...quota, windows: [{ ...quota.windows[0]!, usedPercent: 100 }],
    resetCredits: { availableCount: 2, nextExpiresAt: friday },
    credits: { kind: 'budget', enabled: true, remaining: 75, limit: 100, unlimited: false } };
  component = mount(UsageLimits, { target: document.body, props: { rows: [row] } });
  flushSync();
  expect(document.body.textContent).toContain('2 resets en réserve');
  expect(document.body.textContent).toContain('2026');
  expect(document.body.textContent).toContain('Budget mensuel restant');
  expect(document.body.textContent).toContain('75 % restants');
  expect(document.querySelector('[data-testid=quota-credits] [role=meter]')?.getAttribute('aria-valuenow')).toBe('75');
  expect(document.querySelector('[data-testid=quota-extras] button')).toBeNull();
});

test('monthly budget fallback requires actual exhaustion and confirmed positive paid usage for that same account', () => {
  const row: AccountQuota = { ...quota, windows: [{ ...quota.windows[0]!, usedPercent: 100 }],
    credits: { kind: 'budget', enabled: true, remaining: 75, limit: 100, unlimited: false } };
  const variants: AccountQuota[] = [
    { ...row, accountId: 'disabled-paid', credits: { ...row.credits!, enabled: false } },
    { ...row, accountId: 'unknown-paid', credits: { ...row.credits!, enabled: null } },
    { ...row, accountId: 'zero-paid', credits: { ...row.credits!, remaining: 0 } },
    { ...row, accountId: 'missing-paid', credits: { ...row.credits!, remaining: null } },
    { ...row, accountId: 'unknown-cap', credits: { ...row.credits!, limit: null } },
    { ...row, accountId: 'rounded-zero', windows: [{ ...row.windows[0]!, usedPercent: 99.99 }] },
    { ...row, accountId: 'stale-paid', status: 'unavailable', resetCredits: { availableCount: 2, nextExpiresAt: null } },
    { ...row, accountId: 'monitoring-off', enabled: false },
    { ...row, accountId: 'not-exhausted', windows: quota.windows },
    { ...row, accountId: 'valid-budget' },
    { ...row, accountId: 'tiny-budget', credits: { ...row.credits!, remaining: 0.04 } },
    { ...row, accountId: 'valid-balance', credits: { ...row.credits!, kind: 'balance', remaining: 42.5, limit: null } },
  ];
  component = mount(UsageLimits, { target: document.body, props: { rows: variants } });
  flushSync();
  expect([...document.querySelectorAll('[data-testid=quota-extras]')].map((element) => element.getAttribute('data-account-id'))).toEqual(['valid-budget', 'tiny-budget', 'valid-balance']);
  expect(document.querySelectorAll('[data-testid=quota-credits] [role=meter]')).toHaveLength(2);
  expect(document.body.textContent).toContain('Less than 0.1% left');
  expect(document.body.textContent).toContain('42.5 credits');
});

test('Codex displays a reported credit balance without requiring automatic paid usage or exhaustion', () => {
  const row: AccountQuota = { ...quota, providerId: 'codex', providerName: 'Codex',
    windows: [{ ...quota.windows[0]!, usedPercent: 100 }],
    credits: { kind: 'balance', enabled: null, remaining: 42.5, limit: null, unlimited: false } };
  const variants: AccountQuota[] = [
    { ...row, accountId: 'exhausted' },
    { ...row, accountId: 'subscription-left', windows: quota.windows },
    { ...row, accountId: 'disabled-balance', credits: { ...row.credits!, enabled: false } },
    { ...row, accountId: 'zero-balance', credits: { ...row.credits!, remaining: 0 } },
    { ...row, accountId: 'unknown-balance', credits: { ...row.credits!, remaining: null } },
    { ...row, accountId: 'stale-balance', status: 'unavailable' },
    { ...row, accountId: 'monitoring-off', enabled: false },
  ];
  component = mount(UsageLimits, { target: document.body, props: { rows: variants } });
  flushSync();
  expect([...document.querySelectorAll('[data-testid=quota-extras]')].map((element) => element.getAttribute('data-account-id'))).toEqual(['exhausted', 'subscription-left']);
  expect(document.querySelectorAll('[data-testid=quota-credits]')).toHaveLength(2);
  expect(document.body.textContent).toContain('42.5 credits');
  expect(document.querySelector('[data-testid=quota-credits] [role=meter]')).toBeNull();
});


test('subscriptions from the same provider get separate cards with their chosen labels', () => {
  component = mount(UsageLimits, { target: document.body, props: {
    rows: [quota, { ...quota, accountId: 'personal', label: 'Personal', checkedAt: null }],
  } });
  flushSync();
  const cards = [...document.querySelectorAll('[data-testid="usage-limit-provider"]')];
  expect(cards.map(card => card.querySelector('strong')!.textContent)).toEqual(['Work', 'Personal']);
  expect(cards.map(card => card.getAttribute('data-account-id'))).toEqual(['claude-default', 'personal']);
  expect(cards[0]!.querySelector('header small')).not.toBeNull();
  expect(cards[1]!.querySelector('header small')).toBeNull();
});

test('the weekly window leads the card with its reset, and pinning another one saves it as the primary', async () => {
  const saveSettings = vi.fn(async () => true);
  const store = (quotaPrimary: Record<string, string>) => ({ owner: true, settings: { quotaPrimary }, saveSettings }) as unknown as Store;
  component = mount(UsageLimits, { target: document.body, props: { rows: [quota], store: store({ other: 'week' }) } });
  flushSync();
  const primary = () => document.querySelector<HTMLElement>('[data-testid="usage-limit-primary"]')!;
  expect(primary().dataset.windowId).toBe('seven_day');
  expect(primary().querySelector('.primary-left')!.textContent).toBe('60%');
  expect(primary().querySelector('.primary-reset')!.textContent).toContain('Resets');
  expect(document.querySelector('[data-testid="usage-limit-unpin"]')).toBeNull();
  document.querySelector<HTMLButtonElement>('[data-testid="usage-limit-pin"]')!.click();
  await vi.waitFor(() => expect(saveSettings).toHaveBeenCalledWith({ quotaPrimary: { other: 'week', 'claude-default': 'five_hour' } }));
  await unmount(component);

  document.body.innerHTML = '';
  component = mount(UsageLimits, { target: document.body, props: { rows: [quota], store: store({ other: 'week', 'claude-default': 'five_hour' }) } });
  flushSync();
  expect(primary().dataset.windowId).toBe('five_hour');
  expect(primary().querySelector('.primary-left')!.textContent).toBe('86.5%');
  document.querySelector<HTMLButtonElement>('[data-testid="usage-limit-unpin"]')!.click();
  await vi.waitFor(() => expect(saveSettings).toHaveBeenLastCalledWith({ quotaPrimary: { other: 'week' } }));
});

test('a card whose windows are all hidden says so instead of looking empty', () => {
  const store = { owner: false, settings: { quotaHiddenWindows: ['hours', 'weekly'] } };
  component = mount(UsageLimits, { target: document.body, props: { rows: [quota], store: store as unknown as Store } });
  flushSync();
  expect(document.querySelector('[data-testid="usage-limit-all-hidden"]')).not.toBeNull();
  expect(document.querySelector('[data-testid="usage-limit-pin"]')).toBeNull();
});

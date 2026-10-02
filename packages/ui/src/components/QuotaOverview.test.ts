import { afterEach, expect, test } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { AccountQuota } from '@boite/contracts';
import QuotaOverview from './QuotaOverview.svelte';

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
  expect(rows.map(row => row.querySelector('.amount')!.textContent)).toEqual(['90% left', '10% left']);
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

test('a single default account shows the provider name and a custom label stays visible', async () => {
  for (const [label, name] of [['Default', 'Codex'], ['Personal', 'Personal']]) {
    component = mount(QuotaOverview, { target: document.body, props: { rows: [quota('only', label!, 10)], connect: () => {} } });
    flushSync();
    expect(document.querySelector('.name')!.textContent).toBe(name);
    await unmount(component); component = undefined;
  }
});

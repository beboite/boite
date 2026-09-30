import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { FakeClient } from '../lib/fake-client';
import { Store } from '../lib/store.svelte';
import { strings } from '../lib/strings';
import { bytes } from '../lib/format';
import ResourcesPage from './ResourcesPage.svelte';

let mounted: ReturnType<typeof mount> | undefined;
let client: FakeClient;
let store: Store;
const settle = async () => { for (let i = 0; i < 20; i++) { await Promise.resolve(); flushSync(); } };
afterEach(async () => {
  if (mounted) await unmount(mounted);
  mounted = undefined;
  store?.detach(); client?.close();
  document.body.innerHTML = ''; localStorage.clear();
});

async function setup() {
  client = new FakeClient({ delayMs: 0 });
  store = new Store(); store.attach(client);
  await store.connect();
  await store.refreshResources();
  mounted = mount(ResourcesPage, { target: document.body, props: { store } });
  await settle();
}

test('shows resolved automatic limits, live totals and largest conversations first', async () => {
  await setup();
  expect(document.querySelector('[data-testid=memory-budget-resolved]')?.textContent).toBe(strings.resources.resolved(19456));
  expect(document.querySelector('[data-testid=memory-cap-auto]')?.textContent).toBe(strings.resources.auto(9728));
  expect(document.querySelector('[data-testid=memory-reserve-auto]')?.textContent).toBe(strings.resources.auto(3276.8));
  const reading = document.querySelector('[data-testid=memory-status]')!.textContent;
  expect(reading).toContain(`${bytes(store.memory!.agentBytes)} / ${bytes(19456 * 1048576)}`);
  expect(reading).toContain(`${bytes(16384 * 1048576)} / ${bytes(3276.8 * 1048576)}`);
  expect(reading).toContain(strings.resources.states.ok);
  const rows = [...document.querySelectorAll<HTMLElement>('[data-testid=resource-row]')].map(row => row.dataset.threadId);
  expect(rows.length).toBeGreaterThan(0);
  expect(rows).toEqual([...store.resources].sort((a, b) => b.load.memoryBytes - a.load.memoryBytes).map(row => row.threadId));
  const entry = store.resources[0]!;
  store.resources = [
    { ...entry, threadId: 'small', load: { ...entry.load, memoryBytes: 100, cpuPercent: 90 } },
    { ...entry, threadId: 'large', load: { ...entry.load, memoryBytes: 900, cpuPercent: 10 } },
  ];
  flushSync();
  expect([...document.querySelectorAll<HTMLElement>('[data-testid=resource-row]')].map(row => row.dataset.threadId)).toEqual(['large', 'small']);
});

test('saves a percentage and can return the quota and reserve to auto', async () => {
  await setup();
  const field = document.querySelector<HTMLInputElement>('[data-testid=memory-budget]')!;
  expect([field.min, field.max, field.step, field.value]).toEqual(['10', '90', '1', '60']);
  const save = vi.spyOn(store, 'saveSettings');
  function input(name: string, value: number) {
    const field = document.querySelector<HTMLInputElement>(`[data-testid=memory-${name}]`)!;
    field.value = String(value); field.dispatchEvent(new Event('input', { bubbles: true }));
  }
  input('budget', 25); input('cap', 4096); input('reserve', 3072);
  document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  expect(save).toHaveBeenLastCalledWith({ agentCpuCapPercent: 75, agentMemoryBudgetPercent: 25, threadMemoryCapMb: 4096, memoryReserveMb: 3072 });
  expect(await client.call('settings.get', {})).toMatchObject({ agentMemoryBudgetPercent: 25, threadMemoryCapMb: 4096, memoryReserveMb: 3072 });
  expect(document.querySelector('[data-testid=memory-budget-resolved]')?.textContent).toBe(strings.resources.resolved(8192));
  input('budget', 60); input('cap', 0); input('reserve', 0);
  document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  expect(store.memory!.limits).toEqual({ budgetMb: 19456, threadMemoryCapMb: 9728, memoryReserveMb: 3276.8 });
  expect(document.querySelector('[data-testid=memory-cap-auto]')?.textContent).toBe(strings.resources.auto(9728));
});

test('memory protection toggles immediately, keeps configured values and explains auto sizing', async () => {
  await setup();
  const toggle = document.querySelector<HTMLInputElement>('[data-testid=setting-memory-protection]')!;
  expect(toggle.checked).toBe(true);
  expect(document.getElementById(toggle.getAttribute('aria-describedby')!)?.textContent).toBe(strings.settings.memoryProtectionHint);
  expect(document.body.textContent).toContain(strings.settings.memoryAutoHint);
  await store.saveSettings({ threadMemoryCapMb: 4096, memoryReserveMb: 512 });
  const budget = document.querySelector<HTMLInputElement>('[data-testid=memory-budget]')!;
  budget.value = '5'; budget.dispatchEvent(new Event('input', { bubbles: true }));
  toggle.click(); await settle();
  const cpu = document.querySelector<HTMLInputElement>('input[type=number]')!;
  cpu.value = '50'; cpu.dispatchEvent(new Event('input', { bubbles: true }));
  const save = vi.spyOn(store, 'saveSettings');
  document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  expect(save).toHaveBeenLastCalledWith({ agentCpuCapPercent: 50 });
  expect(await client.call('settings.get', {})).toMatchObject({ memoryProtection: false, agentCpuCapPercent: 50, agentMemoryBudgetPercent: 60, threadMemoryCapMb: 4096, memoryReserveMb: 512 });
  expect(store.memory!.limits).toEqual({ budgetMb: 0, threadMemoryCapMb: 0, memoryReserveMb: 0 });
  expect(document.querySelector<HTMLInputElement>('[data-testid=memory-cap]')!.disabled).toBe(true);
  expect(document.querySelector('[data-testid=memory-status]')!.textContent).toContain(strings.resources.protectionOff);
  toggle.click(); await settle();
  expect(await client.call('settings.get', {})).toMatchObject({ memoryProtection: true, threadMemoryCapMb: 4096, memoryReserveMb: 512 });
  expect(store.memory!.limits.threadMemoryCapMb).toBe(4096);
  expect(document.querySelector<HTMLInputElement>('[data-testid=memory-cap]')!.disabled).toBe(false);
});

test('a refused memory-protection save restores the switch in either direction', async () => {
  await setup();
  const toggle = document.querySelector<HTMLInputElement>('[data-testid=setting-memory-protection]')!;
  const save = vi.spyOn(store, 'saveSettings');
  save.mockResolvedValueOnce(false);
  toggle.click(); await settle();
  expect(store.settings!.memoryProtection).toBe(true);
  expect(toggle.checked).toBe(true);
  toggle.click(); await settle();
  expect(toggle.checked).toBe(false);
  save.mockResolvedValueOnce(false);
  toggle.click(); await settle();
  expect(store.settings!.memoryProtection).toBe(false);
  expect(toggle.checked).toBe(false);
});

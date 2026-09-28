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
  expect(document.querySelector('[data-testid=memory-budget-auto]')?.textContent).toBe(strings.resources.auto(19456));
  expect(document.querySelector('[data-testid=memory-cap-auto]')?.textContent).toBe(strings.resources.auto(9728));
  expect(document.querySelector('[data-testid=memory-reserve-auto]')?.textContent).toBe(strings.resources.auto(3276.8));
  const reading = document.querySelector('[data-testid=memory-status]')!.textContent;
  expect(reading).toContain(`${bytes(store.memory!.agentBytes)} / ${bytes(19456 * 1048576)}`);
  expect(reading).toContain(`${bytes(5120 * 1048576)} / ${bytes(3276.8 * 1048576)}`);
  expect(reading).toContain(strings.resources.states.tight);
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

test('saves all three memory settings and can return each one to auto', async () => {
  await setup();
  const save = vi.spyOn(store, 'saveSettings');
  function input(name: string, value: number) {
    const field = document.querySelector<HTMLInputElement>(`[data-testid=memory-${name}]`)!;
    field.value = String(value); field.dispatchEvent(new Event('input', { bubbles: true }));
  }
  input('budget', 8192); input('cap', 4096); input('reserve', 3072);
  document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  expect(save).toHaveBeenLastCalledWith({ agentCpuCapPercent: 75, agentMemoryBudgetMb: 8192, threadMemoryCapMb: 4096, memoryReserveMb: 3072 });
  expect(await client.call('settings.get', {})).toMatchObject({ agentMemoryBudgetMb: 8192, threadMemoryCapMb: 4096, memoryReserveMb: 3072 });
  expect(document.querySelector('[data-testid=memory-budget-auto]')).toBeNull();
  input('budget', 0); input('cap', 0); input('reserve', 0);
  document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  expect(store.memory!.limits).toEqual({ agentMemoryBudgetMb: 19456, threadMemoryCapMb: 9728, memoryReserveMb: 3276.8 });
  expect(document.querySelector('[data-testid=memory-cap-auto]')?.textContent).toBe(strings.resources.auto(9728));
});

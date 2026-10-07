import { afterEach, expect, test } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { FakeClient } from '../lib/fake-client';
import { readMainMachine } from '../lib/endpoint';
import { Store, store as primary } from '../lib/store.svelte';
import { strings } from '../lib/strings';
import { workspace, type Machine } from '../lib/workspace.svelte';
import MainMachine from './MainMachine.svelte';

let mounted: ReturnType<typeof mount> | undefined;
const stores: Store[] = [];
afterEach(async () => {
  if (mounted) await unmount(mounted);
  mounted = undefined;
  for (const store of stores.splice(0)) { store.client?.close(); store.detach(); }
  workspace.machines = [];
  workspace.active = primary;
  workspace.setMain(null);
  document.body.innerHTML = '';
  localStorage.clear();
});

const settle = async () => { for (let i = 0; i < 20; i++) { await Promise.resolve(); flushSync(); } };
const trigger = () => document.querySelector<HTMLButtonElement>('[data-testid="main-machine-pick"]');
const hint = () => document.querySelector('[data-testid="main-machine"] .hint')?.textContent;

async function pick(label: string) {
  trigger()!.click();
  await settle();
  const rows = [...document.querySelectorAll<HTMLElement>('[data-testid="main-machine-pick-menu"] [data-row]')];
  rows.find((row) => row.textContent!.trim() === label)!.click();
  await settle();
  return rows.map((row) => row.textContent!.trim());
}

test('a device picks the machine it opens on among the ones it reaches, and goes back to the last one used', async () => {
  const machines: Machine[] = [];
  for (const [id, label] of [['https://laptop.test', 'Laptop'], ['https://server.test', 'Server']] as const) {
    const store = new Store();
    store.attach(new FakeClient({ delayMs: 0 }));
    await store.connect();
    stores.push(store);
    machines.push({ id, label, store });
  }
  // One machine leaves nothing to choose.
  workspace.machines = [machines[0]!];
  mounted = mount(MainMachine, { target: document.body });
  await settle();
  expect(trigger()).toBeNull();

  workspace.machines = machines;
  await settle();
  expect(trigger()!.textContent).toContain(strings.machines.mainLast);
  expect(hint()).toBe(strings.machines.mainLastHint);

  expect(await pick('Server')).toEqual([strings.machines.mainLast, 'Laptop', 'Server']);
  expect(readMainMachine()).toEqual({ url: 'https://server.test' });
  expect(trigger()!.textContent).toContain('Server');
  expect(hint()).toBe(strings.machines.mainHint);

  await pick(strings.machines.mainLast);
  expect(readMainMachine()).toBeNull();
  expect(trigger()!.textContent).toContain(strings.machines.mainLast);
});

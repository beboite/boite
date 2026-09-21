import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { FakeClient } from '../lib/fake-client';
import { Store, store as primary } from '../lib/store.svelte';
import { workspace } from '../lib/workspace.svelte';
import RemoteCoordination from './RemoteCoordination.svelte';

let component: ReturnType<typeof mount> | undefined;
const opened: Store[] = [];
const settle = async () => { for (let index = 0; index < 30; index += 1) { await Promise.resolve(); flushSync(); } };

afterEach(async () => {
  if (component) await unmount(component);
  for (const target of opened) { target.client?.close(); target.detach(); }
  opened.length = 0;
  workspace.machines = [];
  workspace.active = primary;
  component = undefined;
  document.body.innerHTML = '';
});

async function machine(id: string, name: string): Promise<Store> {
  const target = new Store();
  target.machineId = id;
  target.attach(new FakeClient({ delayMs: 0, coreId: `core-${id}`, coreName: name, publicUrl: `https://${id}.test` }));
  await target.connect();
  opened.push(target);
  return target;
}

test('linking two connected machines establishes reciprocal public trust', async () => {
  const first = await machine('first', 'First');
  const second = await machine('second', 'Second');
  workspace.machines = [{ id: 'first', label: 'First', store: first }, { id: 'second', label: 'Second', store: second }];
  workspace.active = first;
  component = mount(RemoteCoordination, { target: document.body });
  await settle();

  const link = document.querySelector<HTMLButtonElement>('[data-testid="agent-link"]')!;
  expect(link.disabled, document.body.textContent ?? '').toBe(false);
  link.click();
  await vi.waitFor(() => { flushSync(); expect(document.querySelectorAll('[data-testid="agent-peer"]')).toHaveLength(2); });
  expect((await first.coordinationPeers()).map(peer => peer.coreId)).toEqual(['core-second']);
  expect((await second.coordinationPeers()).map(peer => peer.coreId)).toEqual(['core-first']);
  expect(document.querySelectorAll('[data-testid="agent-peer"]')).toHaveLength(2);

  document.querySelector<HTMLButtonElement>('[data-testid="agent-peer"] button')!.click();
  await settle();
  expect(await first.coordinationPeers()).toEqual([]);
  expect((await second.coordinationPeers()).map(peer => peer.coreId)).toEqual(['core-first']);
});

test('a machine that becomes ready after mount refreshes its existing links', async () => {
  const first = await machine('first', 'First');
  const second = await machine('second', 'Second');
  const [firstIdentity, secondIdentity] = await Promise.all([
    first.coordinationIdentity(),
    second.coordinationIdentity(),
  ]);
  await Promise.all([
    first.trustCoordinationPeer(secondIdentity),
    second.trustCoordinationPeer(firstIdentity),
  ]);
  second.connection = 'connecting';
  workspace.machines = [{ id: 'first', label: 'First', store: first }, { id: 'second', label: 'Second', store: second }];
  workspace.active = first;
  component = mount(RemoteCoordination, { target: document.body });
  await settle();
  expect(document.querySelector('[data-testid="agent-link-pair"]')).toBeNull();

  second.connection = 'ready';
  await vi.waitFor(() => {
    flushSync();
    const link = document.querySelector<HTMLButtonElement>('[data-testid="agent-link"]');
    expect(link, document.body.textContent ?? '').not.toBeNull();
    expect(link?.disabled, document.body.textContent ?? '').toBe(true);
    expect(document.querySelectorAll('[data-testid="agent-peer"]')).toHaveLength(2);
  });
});

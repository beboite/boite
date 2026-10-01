import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { FakeClient } from '../lib/fake-client';
import { Store, store as primary } from '../lib/store.svelte';
import { workspace } from '../lib/workspace.svelte';
import RemoteCoordination from './RemoteCoordination.svelte';
import MachinesPage from './MachinesPage.svelte';
import { agentAutoLink, linkMachines } from '../lib/agent-links.svelte';

let component: ReturnType<typeof mount> | undefined;
const opened: Store[] = [];
const settle = async () => { for (let index = 0; index < 30; index += 1) { await Promise.resolve(); flushSync(); } };

afterEach(async () => {
  vi.restoreAllMocks();
  if (component) await unmount(component);
  for (const target of opened) { target.client?.close(); target.detach(); }
  opened.length = 0;
  workspace.machines = [];
  workspace.active = primary;
  component = undefined;
  agentAutoLink.reset();
  localStorage.removeItem('boite.agent-links.unlinked');
  document.body.innerHTML = '';
});

async function machine(id: string, name: string, principal: 'owner' | 'session' = 'owner'): Promise<Store> {
  const target = new Store();
  target.machineId = id;
  target.attach(new FakeClient({ delayMs: 0, coreId: `core-${id}`, coreName: name, publicUrl: `https://${id}.test`, ...(principal === 'session' ? { principal } : {}) }));
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
  expect(document.querySelector('[data-testid="agent-link-pair"]')?.textContent).toContain('Configured on both machines');
  expect(document.querySelector('[data-testid="agent-link-pair"]')?.textContent).toContain('Signed connection verified');

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

test('a loopback contact uses the connected HTTPS origin when linking machines', async () => {
  const first = await machine('first', 'First');
  const second = await machine('second', 'Second');
  const identity = await second.coordinationIdentity();
  vi.spyOn(second, 'coordinationIdentity').mockResolvedValue({ ...identity, url: 'http://127.0.0.1:3773' });
  second.endpointUrl = 'https://second.test';
  first.endpointUrl = 'https://another-first-address.test';
  await linkMachines({ id: 'first', label: 'First', store: first }, { id: 'second', label: 'Second', store: second });
  expect((await first.coordinationPeers())[0]?.url).toBe('https://second.test');
  expect((await second.coordinationPeers())[0]?.url).toBe('https://first.test');
});

test('an unpublished local machine links through the owner app without requiring a public address', async () => {
  const first = await machine('first', 'First');
  const second = await machine('second', 'Second');
  const identity = await second.coordinationIdentity();
  vi.spyOn(second, 'coordinationIdentity').mockResolvedValue({ ...identity, url: 'http://127.0.0.1:3773' });
  second.endpointUrl = 'http://127.0.0.1:3773';
  const check = vi.spyOn(first, 'checkCoordinationPeer');
  const a = { id: 'first', label: 'First', store: first }, b = { id: 'second', label: 'Second', store: second };
  workspace.machines = [a, b];
  await agentAutoLink.sweep();
  expect(check).toHaveBeenCalled();
  expect((await first.coordinationPeers())[0]).toMatchObject({ coreId: 'core-second', viaClient: true });
  expect((await second.coordinationPeers())[0]?.coreId).toBe('core-first');
  expect(agentAutoLink.failureOf(a, b)).toBeUndefined();
  component = mount(MachinesPage, { target: document.body, props: { mobile: true } });
  await settle();
  expect(document.querySelectorAll('[data-testid="agent-peer-read"]')).toHaveLength(2);
});

test('conversation access is an owner-controlled checkbox in the receiving machine, independent of the reverse grant', async () => {
  const pc = await machine('pc', 'Client PC');
  const server = await machine('server', 'Server');
  const [cardPC, cardServer] = await Promise.all([pc.coordinationIdentity(), server.coordinationIdentity()]);
  await pc.trustCoordinationPeer(cardServer); await server.trustCoordinationPeer(cardPC);
  workspace.machines = [{ id: 'pc', label: 'Client PC', store: pc }, { id: 'server', label: 'Server', store: server }];
  workspace.active = pc;
  component = mount(RemoteCoordination, { target: document.body });
  await settle();
  const boxes = document.querySelectorAll<HTMLInputElement>('[data-testid="agent-peer-read"]');
  expect(boxes).toHaveLength(2);
  expect(boxes[0]?.checked).toBe(false); expect(boxes[1]?.checked).toBe(false);
  boxes[0]!.click(); await settle();
  expect((await pc.coordinationPeers())[0]?.readThreads).toBe(true);
  expect((await server.coordinationPeers())[0]?.readThreads).toBe(false);
  document.querySelector<HTMLInputElement>('[data-testid="agent-peer-read"]')!.click(); await settle();
  expect((await pc.coordinationPeers())[0]?.readThreads).toBe(false);
});

test('owner machines link by themselves, a paired device never does, and a removed link stays removed', async () => {
  const first = await machine('first', 'First');
  const second = await machine('second', 'Second');
  const phone = await machine('phone', 'Phone', 'session');
  expect(phone.owner).toBe(false);
  workspace.machines = [{ id: 'first', label: 'First', store: first }, { id: 'second', label: 'Second', store: second }, { id: 'phone', label: 'Phone', store: phone }];
  const stop = agentAutoLink.start();
  try {
    await vi.waitFor(async () => {
      expect((await first.coordinationPeers()).map(peer => peer.coreId)).toEqual(['core-second']);
      expect((await second.coordinationPeers()).map(peer => peer.coreId)).toEqual(['core-first']);
    });
    // The paired device holds no owner connection: nothing trusts it, and it trusts nothing.
    expect((await first.coordinationPeers()).some(peer => peer.coreId === 'core-phone')).toBe(false);

    workspace.active = first;
    component = mount(RemoteCoordination, { target: document.body });
    await vi.waitFor(() => { flushSync(); expect(document.querySelectorAll('[data-testid="agent-peer"]')).toHaveLength(2); });
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-testid="agent-peer"] button')) { button.click(); await settle(); }
    await vi.waitFor(async () => { expect(await first.coordinationPeers()).toEqual([]); expect(await second.coordinationPeers()).toEqual([]); });

    // Reconnecting both retries every pair, but not the one the user removed.
    first.connection = 'connecting'; second.connection = 'connecting';
    await settle();
    first.connection = 'ready'; second.connection = 'ready';
    await settle();
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(await first.coordinationPeers()).toEqual([]);
    expect(await second.coordinationPeers()).toEqual([]);

    // Linking by hand clears the removal.
    document.querySelector<HTMLButtonElement>('[data-testid="agent-link"]')!.click();
    await vi.waitFor(async () => { expect((await first.coordinationPeers()).map(peer => peer.coreId)).toEqual(['core-second']); });
    expect(localStorage.getItem('boite.agent-links.unlinked')).toBe('[]');
  } finally { stop(); }
});

test('a failed permission update restores the checkbox and reports the destination error', async () => {
  const pc = await machine('pc', 'Client PC'), server = await machine('server', 'Server');
  await pc.trustCoordinationPeer(await server.coordinationIdentity());
  workspace.machines = [{ id: 'pc', label: 'Client PC', store: pc }, { id: 'server', label: 'Server', store: server }];
  component = mount(RemoteCoordination, { target: document.body });
  await settle();
  vi.spyOn(pc, 'trustCoordinationPeer').mockRejectedValue(new Error('destination disconnected'));
  document.querySelector<HTMLInputElement>('[data-testid="agent-peer-read"]')!.click();
  await settle();
  expect(document.querySelector<HTMLInputElement>('[data-testid="agent-peer-read"]')!.checked).toBe(false);
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('destination disconnected');
  expect((await pc.coordinationPeers())[0]?.readThreads).toBe(false);
});

test('an older destination displays an unavailable permission without implying a grant', async () => {
  const pc = await machine('pc', 'Client PC'), server = await machine('server', 'Server');
  vi.spyOn(pc, 'coordinationPeers').mockResolvedValue([await server.coordinationIdentity()]);
  workspace.machines = [{ id: 'pc', label: 'Client PC', store: pc }, { id: 'server', label: 'Server', store: server }];
  component = mount(RemoteCoordination, { target: document.body });
  await settle();
  const box = document.querySelector<HTMLInputElement>('[data-testid="agent-peer-read"]')!;
  expect(box.disabled).toBe(true); expect(box.checked).toBe(false);
});

test('persisted mutual trust is checked again and an unreachable link remains repairable', async () => {
  const first = await machine('first', 'First'), second = await machine('second', 'Second');
  await first.trustCoordinationPeer({ ...await second.coordinationIdentity(), readThreads: true });
  await second.trustCoordinationPeer(await first.coordinationIdentity());
  const check = vi.spyOn(first, 'checkCoordinationPeer').mockRejectedValue(new Error('First cannot verify Second'));
  const reverse = vi.spyOn(second, 'checkCoordinationPeer');
  const a = { id: 'first', label: 'First', store: first }, b = { id: 'second', label: 'Second', store: second };
  workspace.machines = [a, b];
  await agentAutoLink.sweep();
  expect(check).toHaveBeenCalledWith('core-second');
  expect(reverse).toHaveBeenCalledWith('core-first');
  expect(agentAutoLink.failureOf(a, b)).toContain('First cannot verify Second');
  component = mount(RemoteCoordination, { target: document.body });
  await vi.waitFor(() => {
    flushSync();
    expect(document.querySelector('[data-testid="agent-link-pair"]')?.textContent).toContain('First cannot verify Second');
    expect(document.querySelector<HTMLButtonElement>('[data-testid="agent-link"]')?.disabled).toBe(false);
  });
  expect((await first.coordinationPeers())[0]?.coreId).toBe('core-second');
  check.mockRestore();
  document.querySelector<HTMLButtonElement>('[data-testid="agent-link"]')!.click();
  await vi.waitFor(() => {
    flushSync();
    expect(document.querySelector<HTMLButtonElement>('[data-testid="agent-link"]')?.disabled).toBe(true);
    expect(document.querySelector('[data-testid="agent-link-pair"]')?.textContent).not.toContain('First cannot verify Second');
  });
  expect((await first.coordinationPeers())[0]?.readThreads).toBe(true);
  expect((await second.coordinationPeers())[0]?.readThreads).toBe(false);
});

test('a failed link attempts both trust rollbacks even if the first rollback fails', async () => {
  const first = await machine('first', 'First'), second = await machine('second', 'Second');
  vi.spyOn(first, 'checkCoordinationPeer').mockRejectedValue(new Error('link failed'));
  vi.spyOn(first, 'untrustCoordinationPeer').mockRejectedValue(new Error('First rollback failed'));
  const rollback = vi.spyOn(second, 'untrustCoordinationPeer');
  await expect(linkMachines({ id: 'first', label: 'First', store: first }, { id: 'second', label: 'Second', store: second })).rejects.toThrow('First rollback failed');
  expect(rollback).toHaveBeenCalledWith('core-first');
  expect(await second.coordinationPeers()).toEqual([]);
});

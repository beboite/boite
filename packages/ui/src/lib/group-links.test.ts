import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Group, GroupCore } from '@boite/contracts';
import { ENVIRONMENTS_STORAGE_KEY, type Endpoint } from './endpoint';
import { GroupLinks, usableAddresses } from './group-links.svelte';
import type { Machine, Workspace } from './workspace.svelte';

const core = (coreId: string, addresses: string[]): GroupCore => ({ coreId, name: coreId.toUpperCase(), addresses });
const group = (self: string, cores: GroupCore[]): Group => ({ id: 'grp', name: 'Home', self, cores, devices: [] });

interface FakeStore {
  connection: 'ready' | 'closed' | 'connecting';
  client: { call: ReturnType<typeof vi.fn> } | null;
  group: Group | null;
  groupKnown: boolean;
  endpointUrl: string | null;
}

function machine(id: string, store: Partial<FakeStore>, coreId?: string): Machine {
  const full: FakeStore = { connection: 'ready', client: { call: vi.fn(async () => ({ ticket: `ticket-for-${id}` })) }, group: null, groupKnown: true, endpointUrl: id, ...store };
  return { id, label: id, store: full as unknown as Machine['store'], ...(coreId === undefined ? {} : { coreId }) };
}

/** A workspace reduced to what the links read and call. */
function workspace(machines: Machine[]) {
  const added: { endpoint: Endpoint; label: string | undefined; quiet: boolean }[] = [];
  const removed: string[] = [];
  const stub = {
    settled: true,
    machines,
    primary: machines[0]!.store,
    add: vi.fn(async (endpoint: Endpoint, label?: string, quiet = false) => {
      added.push({ endpoint, label, quiet });
      return true;
    }),
    remove: vi.fn(async (id: string) => {
      removed.push(id);
      stub.machines = stub.machines.filter((entry) => entry.id !== id);
    })
  };
  return { stub, added, removed, workspace: stub as unknown as Workspace };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const members = [core('a', ['http://a.tail:1']), core('b', ['https://b.example', 'http://b.tail:1', 'http://100.64.0.2:1'])];

beforeEach(() => localStorage.clear());

describe('group links', () => {
  it('connects a member this client holds no key for, on the address that answers, with a ticket from a member it reaches', async () => {
    const a = machine('http://a.tail:1', { group: group('a', members) });
    const { workspace: ws, added } = workspace([a]);
    const reach = vi.fn(async (addresses: string[]) => addresses[1] ?? null);
    const links = new GroupLinks(ws, { reach, secure: () => false });
    await links.reconcile();
    expect(links.states).toEqual({ b: 'connecting' });
    await settle();
    expect(reach).toHaveBeenCalledWith(['https://b.example', 'http://b.tail:1', 'http://100.64.0.2:1']);
    expect((a.store.client as unknown as FakeStore['client'])!.call).toHaveBeenCalledWith('group.ticket', { coreId: 'b' });
    expect(added).toEqual([{ endpoint: { url: 'http://b.tail:1', token: '', ticket: 'ticket-for-http://a.tail:1', coreId: 'b' }, label: 'B', quiet: true }]);
    expect(links.states).toEqual({});
  });

  it('asks for no ticket when no address answers, and waits a minute before trying again', async () => {
    const a = machine('http://a.tail:1', { group: group('a', members) });
    const { workspace: ws, added } = workspace([a]);
    let now = 1_000_000;
    const reach = vi.fn(async () => null);
    const links = new GroupLinks(ws, { reach, secure: () => false, now: () => now });
    await links.reconcile();
    await settle();
    expect(links.states).toEqual({ b: 'unreachable' });
    expect((a.store.client as unknown as FakeStore['client'])!.call).not.toHaveBeenCalled();
    await links.reconcile();
    await settle();
    expect(reach).toHaveBeenCalledTimes(1);
    now += 60_000;
    await links.reconcile();
    await settle();
    expect(reach).toHaveBeenCalledTimes(2);
    expect(added).toEqual([]);
  });

  it('opens only secure addresses from an HTTPS page, and says so when a member has none', async () => {
    expect(usableAddresses(members[1]!.addresses, true)).toEqual(['https://b.example']);
    expect(usableAddresses(members[1]!.addresses, false)).toHaveLength(3);
    const plain = [members[0]!, core('c', ['http://c.tail:1'])];
    const a = machine('https://a.example', { group: group('a', plain) });
    const { workspace: ws } = workspace([a]);
    const reach = vi.fn(async () => null);
    const links = new GroupLinks(ws, { reach, secure: () => true });
    await links.reconcile();
    await settle();
    expect(links.states).toEqual({ c: 'insecure' });
    expect(reach).not.toHaveBeenCalled();
  });

  it('leaves alone a member already connected, and one that is offline with a key it remembers', async () => {
    localStorage.setItem(ENVIRONMENTS_STORAGE_KEY, JSON.stringify([{ url: 'http://b.tail:1', label: 'B', token: 'key', paired: true, coreId: 'b' }]));
    const a = machine('http://a.tail:1', { group: group('a', [...members, core('c', ['http://c.tail:1'])]) });
    const b = machine('http://b.tail:1', { connection: 'closed', client: null }, 'b');
    const c = machine('http://c.tail:1', { group: group('c', members) });
    const { workspace: ws, added, removed } = workspace([a, b, c]);
    const reach = vi.fn(async (addresses: string[]) => addresses[0] ?? null);
    const links = new GroupLinks(ws, { reach, secure: () => false });
    await links.reconcile();
    await settle();
    expect(reach).not.toHaveBeenCalled();
    expect(added).toEqual([]);
    expect(removed).toEqual([]);
    // Its key was revoked there: the remembered entry is gone, so a ticket is asked for again.
    localStorage.clear();
    await links.reconcile();
    await settle();
    expect(added.map((entry) => entry.endpoint.coreId)).toEqual(['b']);
  });

  it('drops a machine the group brought once no member lists it, and never one paired by hand', async () => {
    const a = machine('http://a.tail:1', { group: group('a', [members[0]!]) });
    const gone = machine('http://b.tail:1', { connection: 'closed', client: null }, 'b');
    const byHand = machine('http://server:1', { group: null });
    const { workspace: ws, removed } = workspace([a, gone, byHand]);
    const links = new GroupLinks(ws, { reach: async () => null, secure: () => false });
    await links.reconcile();
    expect(removed).toEqual(['http://b.tail:1']);
  });

  it('waits for the remembered machines to be added before it looks for a missing member', async () => {
    const a = machine('http://a.tail:1', { group: group('a', members) });
    const { stub, workspace: ws, added } = workspace([a]);
    stub.settled = false;
    const links = new GroupLinks(ws, { reach: async (addresses) => addresses[0] ?? null, secure: () => false });
    await links.reconcile();
    await settle();
    expect(added).toEqual([]);
    stub.settled = true;
    await links.reconcile();
    await settle();
    expect(added.map((entry) => entry.endpoint.coreId)).toEqual(['b']);
  });

  it('decides nothing while a connected machine has not said which group it is in', async () => {
    const a = machine('http://a.tail:1', { group: null, groupKnown: false });
    const brought = machine('http://b.tail:1', { connection: 'closed', client: null }, 'b');
    const { workspace: ws, removed, added } = workspace([a, brought]);
    const links = new GroupLinks(ws, { reach: async () => 'http://b.tail:1', secure: () => false });
    await links.reconcile();
    await settle();
    expect(removed).toEqual([]);
    expect(added).toEqual([]);
  });
});

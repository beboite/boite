import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Group, GroupCore } from '@boite/contracts';
import { ENVIRONMENTS_STORAGE_KEY, readEnvironments, type Endpoint } from './endpoint';
import { GroupLinks, usableAddresses } from './group-links.svelte';
import type { Machine, Workspace } from './workspace.svelte';

const core = (coreId: string, addresses: string[]): GroupCore => ({ coreId, name: coreId.toUpperCase(), addresses });
const group = (self: string, cores: GroupCore[], id = 'grp'): Group => ({ id, name: 'Home', self, cores, devices: [] });

interface FakeStore {
  connection: 'ready' | 'closed' | 'connecting';
  client: { call: ReturnType<typeof vi.fn> } | null;
  group: Group | null;
  groupKnown: boolean;
  endpointUrl: string | null;
  loadGroup: ReturnType<typeof vi.fn>;
}

function machine(id: string, store: Partial<FakeStore>, brought?: { coreId: string; groupId?: string }): Machine {
  const full: FakeStore = {
    connection: 'ready', client: { call: vi.fn(async () => ({ ticket: `ticket-for-${id}` })) }, group: null, groupKnown: true, endpointUrl: id,
    loadGroup: vi.fn(async () => undefined), ...store
  };
  return { id, label: id, store: full as unknown as Machine['store'], ...(brought === undefined ? {} : { coreId: brought.coreId, groupId: brought.groupId ?? 'grp' }) };
}
const storeOf = (entry: Machine) => entry.store as unknown as FakeStore;

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
    }),
    dropPrimary: vi.fn(async (_id: string) => undefined)
  };
  return { stub, added, removed, workspace: stub as unknown as Workspace };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const members = [core('a', ['http://10.0.0.1:1']), core('b', ['http://b.tail:1', 'http://100.64.0.2:1', 'http://192.168.1.20:1'])];

beforeEach(() => localStorage.clear());

describe('group links', () => {
  it('connects a member this client holds no key for, on the address that answers, with a ticket from a member it reaches', async () => {
    const a = machine('http://10.0.0.1:1', { group: group('a', members) });
    const { workspace: ws, added } = workspace([a]);
    const reach = vi.fn(async (addresses: string[]) => addresses[1] ?? null);
    const links = new GroupLinks(ws, { reach, secure: () => false });
    await links.reconcile();
    expect(links.states).toEqual({ b: 'connecting' });
    await settle();
    // The name is not tried over plain HTTP: only the addresses written as numbers.
    expect(reach).toHaveBeenCalledWith(['http://100.64.0.2:1', 'http://192.168.1.20:1']);
    // The ticket is asked for the address that answered, and is good nowhere else.
    expect(storeOf(a).client!.call).toHaveBeenCalledWith('group.ticket', { coreId: 'b', url: 'http://192.168.1.20:1' });
    expect(added).toEqual([{ endpoint: { url: 'http://192.168.1.20:1', token: '', ticket: 'ticket-for-http://10.0.0.1:1', coreId: 'b', groupId: 'grp' }, label: 'B', quiet: true }]);
    expect(links.states).toEqual({});
  });

  it('asks for no ticket when no address answers, and waits a minute before trying again', async () => {
    const a = machine('http://10.0.0.1:1', { group: group('a', members) });
    const { workspace: ws, added } = workspace([a]);
    let now = 1_000_000;
    const reach = vi.fn(async () => null);
    const links = new GroupLinks(ws, { reach, secure: () => false, now: () => now });
    await links.reconcile();
    await settle();
    expect(links.states).toEqual({ b: 'unreachable' });
    expect(storeOf(a).client!.call).not.toHaveBeenCalled();
    await links.reconcile();
    await settle();
    expect(reach).toHaveBeenCalledTimes(1);
    now += 60_000;
    await links.reconcile();
    await settle();
    expect(reach).toHaveBeenCalledTimes(2);
    expect(added).toEqual([]);
  });

  it('sends a key only where the transport says who answers', async () => {
    const all = ['https://b.example', 'http://b.tail:1', 'http://100.64.0.2:1', 'http://[fd7a:115c:a1e0::2]:1'];
    // A machine with an HTTPS address is reached there and nowhere else, even from a page that could open HTTP.
    expect(usableAddresses(all, true)).toEqual(['https://b.example']);
    expect(usableAddresses(all, false)).toEqual(['https://b.example']);
    // Without one: numbers only, never a name a resolver could point elsewhere, and nothing from an HTTPS page.
    expect(usableAddresses(all.slice(1), false)).toEqual(['http://100.64.0.2:1', 'http://[fd7a:115c:a1e0::2]:1']);
    expect(usableAddresses(all.slice(1), true)).toEqual([]);
    expect(usableAddresses(['http://b.tail:1', 'http://100.64.0.2.evil.example:1', 'http://user@100.64.0.2:1'], false)).toEqual([]);

    const named = [members[0]!, core('c', ['http://c.tail:1'])];
    const a = machine('http://10.0.0.1:1', { group: group('a', named) });
    const { workspace: ws } = workspace([a]);
    const reach = vi.fn(async () => null);
    const links = new GroupLinks(ws, { reach, secure: () => false });
    await links.reconcile();
    await settle();
    expect(links.states).toEqual({ c: 'insecure' });
    expect(reach).not.toHaveBeenCalled();
    expect(storeOf(a).client!.call).not.toHaveBeenCalled();
  });

  it('leaves alone a member already connected, and one that is offline with a key it remembers', async () => {
    localStorage.setItem(ENVIRONMENTS_STORAGE_KEY, JSON.stringify([{ url: 'http://100.64.0.2:1', label: 'B', token: 'key', paired: true, coreId: 'b', groupId: 'grp' }]));
    const all = [...members, core('c', ['http://10.0.0.3:1'])];
    const a = machine('http://10.0.0.1:1', { group: group('a', all) });
    const b = machine('http://100.64.0.2:1', { connection: 'closed', client: null }, { coreId: 'b' });
    const c = machine('http://10.0.0.3:1', { group: group('c', all) });
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

  it('never claims a machine paired by hand that sits at a member\'s address', async () => {
    const a = machine('http://10.0.0.1:1', { group: group('a', members) });
    const byHand = machine('http://100.64.0.2:1', { connection: 'connecting', group: null });
    const { workspace: ws, added, removed } = workspace([a, byHand]);
    const links = new GroupLinks(ws, { reach: async () => 'http://100.64.0.2:1', secure: () => false });
    await links.reconcile();
    await settle();
    expect(added).toEqual([]);
    expect(removed).toEqual([]);
    expect(byHand.coreId).toBeUndefined();
    expect(storeOf(a).client!.call).not.toHaveBeenCalled();
  });

  it('drops a machine the group brought once a hand-paired member no longer lists it, whatever it and its friends say', async () => {
    const a = machine('http://10.0.0.1:1', { group: group('a', [members[0]!]) });
    // Removed, still connected, still listing itself: its own word does not keep it.
    const defiant = machine('http://100.64.0.2:1', { group: group('b', [...members, core('y', ['http://100.64.0.9:1'])]) }, { coreId: 'b' });
    // A second removed machine that vouches for the first, and is vouched for by it: neither counts.
    const accomplice = machine('http://100.64.0.9:1', { group: group('y', [...members, core('y', ['http://100.64.0.9:1'])]) }, { coreId: 'y' });
    // Paired by hand: never the group's to drop. From another group: this group has no say on it.
    const byHand = machine('http://server:1', { group: null });
    const elsewhere = machine('http://10.9.9.9:1', { connection: 'closed', client: null }, { coreId: 'z', groupId: 'other' });
    localStorage.setItem(ENVIRONMENTS_STORAGE_KEY, JSON.stringify([{ url: 'http://10.9.9.9:1', label: 'Z', token: 'key', paired: true, coreId: 'z', groupId: 'other' }]));
    const { workspace: ws, removed, added } = workspace([a, defiant, accomplice, byHand, elsewhere]);
    const links = new GroupLinks(ws, { reach: async () => 'http://100.64.0.9:1', secure: () => false });
    await links.reconcile();
    await settle();
    expect(removed).toEqual(['http://100.64.0.2:1', 'http://100.64.0.9:1']);
    // And what the removed machine's roster lists is not connected to on its word.
    expect(added).toEqual([]);
  });

  it('forgets the key of the machine this window opens on when the group that brought it dropped it', async () => {
    const opened = machine('http://100.64.0.2:1', { group: group('b', members) }, { coreId: 'b' });
    const a = machine('http://10.0.0.1:1', { group: group('a', [members[0]!]) });
    const { stub, workspace: ws, removed } = workspace([opened, a]);
    const links = new GroupLinks(ws, { reach: async () => null, secure: () => false });
    await links.reconcile();
    expect(stub.dropPrimary).toHaveBeenCalledWith('http://100.64.0.2:1');
    expect(removed).toEqual([]);
  });

  it('drops a machine whose key was revoked when nobody of its group is left to vouch for it', async () => {
    const a = machine('http://10.0.0.1:1', { group: null });
    const orphan = machine('http://100.64.0.2:1', { connection: 'closed', client: null }, { coreId: 'b' });
    const { workspace: ws, removed } = workspace([a, orphan]);
    const links = new GroupLinks(ws, { reach: async () => null, secure: () => false });
    await links.reconcile();
    expect(removed).toEqual(['http://100.64.0.2:1']);
  });

  it('waits for the remembered machines to be added before it looks for a missing member', async () => {
    const a = machine('http://10.0.0.1:1', { group: group('a', members) });
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

  it('lets a machine that has not answered about its group neither vouch nor block the others', async () => {
    const silent = machine('http://10.0.0.9:1', { group: null, groupKnown: false });
    const a = machine('http://10.0.0.1:1', { group: group('a', [members[0]!]) });
    const gone = machine('http://100.64.0.2:1', { connection: 'closed', client: null }, { coreId: 'b' });
    const { workspace: ws, removed } = workspace([silent, a, gone]);
    const links = new GroupLinks(ws, { reach: async () => null, secure: () => false });
    await links.reconcile();
    expect(removed).toEqual(['http://100.64.0.2:1']);
    // Alone, it decides nothing.
    const { workspace: quiet, removed: untouched, added } = workspace([silent, machine('http://100.64.0.2:1', { connection: 'closed', client: null }, { coreId: 'b' })]);
    await new GroupLinks(quiet, { reach: async () => 'http://100.64.0.2:1', secure: () => false }).reconcile();
    await settle();
    expect(untouched).toEqual([]);
    expect(added).toEqual([]);
  });

  it('reaches a machine anew when it starts giving HTTPS, instead of sending the old key over HTTP again', async () => {
    localStorage.setItem(ENVIRONMENTS_STORAGE_KEY, JSON.stringify([{ url: 'http://100.64.0.2:1', label: 'B', token: 'key', paired: true, coreId: 'b', groupId: 'grp' }]));
    const upgraded = [members[0]!, core('b', ['https://b.example', 'http://100.64.0.2:1'])];
    const a = machine('http://10.0.0.1:1', { group: group('a', upgraded) });
    const b = machine('http://100.64.0.2:1', { group: group('b', upgraded) }, { coreId: 'b' });
    const { workspace: ws, removed, added } = workspace([a, b]);
    const links = new GroupLinks(ws, { reach: async (addresses) => addresses[0] ?? null, secure: () => false });
    await links.reconcile();
    await settle();
    expect(removed).toEqual(['http://100.64.0.2:1']);
    expect(added.map((entry) => entry.endpoint.url)).toEqual(['https://b.example']);
  });

  it('stops sending the old key over HTTP when the machine this window opened on starts giving HTTPS', async () => {
    const upgraded = [members[0]!, core('b', ['https://b.example', 'http://100.64.0.2:1'])];
    const opened = machine('http://100.64.0.2:1', { group: group('b', upgraded) }, { coreId: 'b' });
    const a = machine('http://10.0.0.1:1', { group: group('a', upgraded) });
    const { stub, workspace: ws, removed, added } = workspace([opened, a]);
    const links = new GroupLinks(ws, { reach: async (addresses) => addresses[0] ?? null, secure: () => false });
    await links.reconcile();
    await settle();
    expect(stub.dropPrimary).toHaveBeenCalledWith('http://100.64.0.2:1');
    expect(removed).toEqual([]);
    expect(added.map((entry) => entry.endpoint.url)).toEqual(['https://b.example']);
  });

  it('sends a key the group brought over plain HTTP, at start, only where a hand-paired machine says it still stands', async () => {
    const entry = (url: string, coreId: string, groupId = 'grp') => ({ url, label: coreId, token: 'key', paired: true, coreId, groupId });
    const held = [entry('http://100.64.0.2:1', 'b'), entry('http://10.0.0.3:1', 'c'), entry('http://10.0.0.4:1', 'd'), entry('http://10.9.9.9:1', 'z', 'other')];
    localStorage.setItem(ENVIRONMENTS_STORAGE_KEY, JSON.stringify(held));
    const { workspace: ws } = workspace([machine('http://10.0.0.1:1', {})]);
    const roster = group('a', [...members, core('c', ['https://c.example', 'http://10.0.0.3:1'])]);
    // One machine paired by hand answers, another is off, a third is in no group.
    const ask = vi.fn(async (endpoint: Endpoint) => (endpoint.url === 'http://10.0.0.1:1' ? roster : endpoint.url === 'https://alone.example' ? null : undefined));
    const anchors = [{ url: 'http://10.0.0.1:1', token: 'hand' }, { url: 'http://10.0.0.5:1', token: 'hand' }, { url: 'https://alone.example', token: 'hand' }];
    const cleared = await new GroupLinks(ws, { secure: () => false, ask }).vet(held, anchors);
    expect(ask).toHaveBeenCalledTimes(3);
    // b still gives that address. c gives HTTPS now and d left the group: their keys are forgotten unsent.
    // Nobody here speaks for the other group, so its key is used as it was left.
    expect(cleared.map((env) => env.coreId)).toEqual(['b', 'z']);
    expect(readEnvironments().map((env) => env.coreId)).toEqual(['b', 'z']);
    // The machine that vouched is off: the key is used as it was left.
    expect(await new GroupLinks(ws, { secure: () => false, ask: async () => undefined }).vet([held[0]!], anchors)).toEqual([held[0]]);
    // Paired by hand in another window while the question was out: that pairing is not the one refused, and it stays.
    const repaired = { url: 'http://10.0.0.4:1', label: 'd', token: 'by-hand', paired: true };
    const late = vi.fn(async () => {
      localStorage.setItem(ENVIRONMENTS_STORAGE_KEY, JSON.stringify([repaired]));
      return roster;
    });
    expect(await new GroupLinks(ws, { secure: () => false, ask: late }).vet([held[2]!], [anchors[0]!])).toEqual([]);
    expect(readEnvironments()).toEqual([repaired]);
  });

  it('sends no ticket to an address one hand-paired machine still lists and another no longer does', async () => {
    // One roster is older: it still gives b the address b left, where somebody else may listen.
    const stale = machine('http://10.0.0.1:1', { group: group('a', members) });
    const current = machine('http://10.0.0.7:1', { group: group('c', [members[0]!, core('b', ['https://b.example']), core('c', ['http://10.0.0.7:1'])]) });
    const { workspace: ws, added } = workspace([stale, current]);
    const reach = vi.fn(async (addresses: string[]) => addresses[0] ?? null);
    const links = new GroupLinks(ws, { reach, secure: () => false });
    await links.reconcile();
    await settle();
    expect(reach).not.toHaveBeenCalled();
    expect(added).toEqual([]);
    expect(links.states['b']).toBe('insecure');
    // Once the two agree, the address they both give is used.
    storeOf(stale).group = group('a', [members[0]!, core('b', ['https://b.example']), core('c', ['http://10.0.0.7:1'])]);
    await new GroupLinks(ws, { reach, secure: () => false }).reconcile();
    await settle();
    expect(added.map((entry) => entry.endpoint.url)).toEqual(['https://b.example']);
  });

  it('sends no ticket where an attempt was heading once the rosters changed under it', async () => {
    const moved = [members[0]!, core('b', ['http://10.0.0.6:1'])];
    // While the old address is being tried, the roster says b gave it up.
    const a = machine('http://10.0.0.1:1', { group: group('a', members) });
    const { workspace: ws, added } = workspace([a]);
    let tried = 0;
    const reach = vi.fn(async (addresses: string[]) => {
      tried += 1;
      if (tried === 1) storeOf(a).group = group('a', moved);
      return addresses[0] ?? null;
    });
    await new GroupLinks(ws, { reach, secure: () => false }).reconcile();
    await settle();
    await settle();
    // No ticket went to the address it left: the member was reached anew where the roster now puts it.
    expect(reach.mock.calls.map(([addresses]) => addresses)).toEqual([['http://100.64.0.2:1', 'http://192.168.1.20:1'], ['http://10.0.0.6:1']]);
    expect(added.map((entry) => entry.endpoint.url)).toEqual(['http://10.0.0.6:1']);

    // The same while the ticket is being asked for: it is not sent.
    const late = machine('http://10.0.0.1:1', { group: group('a', members) });
    storeOf(late).client!.call = vi.fn(async () => {
      storeOf(late).group = group('a', [members[0]!]);
      return { ticket: 'ticket-too-late' };
    });
    const { workspace: other, added: none } = workspace([late]);
    await new GroupLinks(other, { reach: async (addresses) => addresses[0] ?? null, secure: () => false }).reconcile();
    await settle();
    await settle();
    expect(storeOf(late).client!.call).toHaveBeenCalledTimes(1);
    expect(none).toEqual([]);
  });

  it('retries at once a member whose addresses moved under an attempt, and only once a minute', async () => {
    let now = 1_000_000;
    const a = machine('http://10.0.0.1:1', { group: group('a', members) });
    const { workspace: ws, added } = workspace([a]);
    // Every attempt finds the roster changed under it: the address it was heading to is no longer the newest.
    let rev = 1;
    const reach = vi.fn(async (addresses: string[]) => {
      rev += 1;
      storeOf(a).group = group('a', [members[0]!, core('b', [`http://10.0.${rev}.6:1`])]);
      return addresses[0] ?? null;
    });
    const links = new GroupLinks(ws, { reach, secure: () => false, now: () => now });
    await links.reconcile();
    await settle();
    await settle();
    // The first attempt and one immediate retry: then the minute's wait applies again.
    expect(reach).toHaveBeenCalledTimes(2);
    expect(added).toEqual([]);
    now += 61_000;
    await links.reconcile();
    await settle();
    await settle();
    expect(reach).toHaveBeenCalledTimes(4);
  });

  it('takes the word of the hand-paired machine that no longer lists a member over the one that still does', async () => {
    const stale = machine('http://10.0.0.1:1', { group: group('a', members) });
    const current = machine('http://10.0.0.7:1', { group: group('c', [members[0]!, core('c', ['http://10.0.0.7:1'])]) });
    const { workspace: ws, added } = workspace([stale, current]);
    const links = new GroupLinks(ws, { reach: async (addresses) => addresses[0] ?? null, secure: () => false });
    await links.reconcile();
    await settle();
    // b is listed by one and dropped by the other: no ticket is asked for it.
    expect(added.map((entry) => entry.endpoint.coreId)).toEqual([]);
  });
});


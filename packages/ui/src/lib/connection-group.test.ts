import { afterEach, expect, test, vi } from 'vitest';
import { ConnectionGroup } from './connection-group.svelte';
import { FakeClient } from './fake-client';
import { readEnvironments, upsertEnvironment } from './endpoint';
import { Store } from './store.svelte';
import { Workspace, type Machine } from './workspace.svelte';

const opened: Store[] = [];
afterEach(() => {
  for (const store of opened.splice(0)) { store.client?.close(); store.detach(); }
  localStorage.clear();
});

async function setup(principal: 'owner' | 'session' = 'owner') {
  const workspace = new Workspace();
  for (const label of ['source', 'target']) {
    const store = new Store();
    store.attach(new FakeClient({ delayMs: 0, principal: label === 'source' ? 'owner' : principal, coreId: label, coreName: label, publicUrl: `https://${label}.test` }));
    await store.connect();
    await store.loadGroup();
    opened.push(store);
    const machine: Machine = { id: `https://${label}.test`, label, store };
    workspace.machines = [...workspace.machines, machine];
    upsertEnvironment({ url: machine.id, label, token: 'fixture-key', paired: true });
  }
  const [source, target] = workspace.machines as [Machine, Machine];
  workspace.active = source.store;
  return { workspace, source, target, migration: new ConnectionGroup(workspace) };
}

test('existing owner connections join one shared group and their saved keys, labels and addresses stay usable', async () => {
  const { workspace, source, target, migration } = await setup();
  await migration.merge();
  expect(migration.errors).toEqual([]);
  expect(source.store.group?.cores.map(core => core.coreId).sort()).toEqual(['source', 'target']);
  expect(target.store.group?.id).toBe(source.store.group?.id);
  expect(target).toMatchObject({ coreId: 'target', groupId: source.store.group?.id, epoch: 1 });
  expect(readEnvironments().find(entry => entry.url === target.id)).toMatchObject({ token: 'fixture-key', label: 'target', coreId: 'target', groupId: source.store.group?.id });
  expect(workspace.active).toBe(source.store);
  await source.store.leaveGroup();
  await target.store.loadGroup();
  await target.store.leaveGroup();
  await new ConnectionGroup(workspace).merge();
  expect(source.store.group).toBeNull();
  expect(target.store.group).toBeNull();
});

test('an existing group receives an offline connection when it returns, while device roles are never joined', async () => {
  const { source, target, migration } = await setup();
  await source.store.createGroup('Studio');
  target.store.connection = 'closed';
  await migration.merge();
  expect(source.store.group?.cores).toHaveLength(1);
  target.store.connection = 'ready';
  await migration.merge();
  expect(target.store.group?.name).toBe('Studio');
  const paired = await setup('session');
  const join = vi.spyOn(paired.target.store.client!, 'call');
  await paired.migration.merge();
  expect(paired.source.store.group).toBeNull();
  expect(join).not.toHaveBeenCalledWith('group.join', expect.anything());
});

test('another group is reported without leaving it, and a stopped migration never joins a pending target', async () => {
  const { source, target, migration } = await setup();
  await source.store.createGroup('Home');
  await target.store.createGroup('Office');
  await migration.merge();
  expect(migration.errors[0]).toContain('Office');
  expect(source.store.group?.cores).toHaveLength(1);
  expect(target.store.group?.name).toBe('Office');
  await target.store.leaveGroup();
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  const client = source.store.client!;
  const call = client.call.bind(client);
  vi.spyOn(client, 'call').mockImplementation(async (method, params) => {
    if (method === 'group.invite') await ready;
    return call(method, params);
  });
  const merge = migration.merge();
  await vi.waitFor(() => expect(migration.busy).toBe(true));
  migration.stop();
  release();
  await merge;
  expect(target.store.group).toBeNull();
});

test('an offline existing group is reused instead of creating a second group among ready owners', async () => {
  const { workspace, source, target, migration } = await setup();
  await source.store.createGroup('Studio');
  source.store.connection = 'closed';
  const third = new Store();
  third.attach(new FakeClient({ delayMs: 0, coreId: 'third', publicUrl: 'https://third.test' }));
  opened.push(third);
  await third.connect();
  await third.loadGroup();
  workspace.machines = [...workspace.machines, { id: 'https://third.test', label: 'third', store: third }];
  await migration.merge();
  expect(target.store.group).toBeNull();
  expect(third.group).toBeNull();
  source.store.connection = 'ready';
  await migration.merge();
  expect(target.store.group?.id).toBe(source.store.group?.id);
  expect(third.group?.id).toBe(source.store.group?.id);
});

test('a failed join can retry after the target confirms it still belongs to no group', async () => {
  const { source, target, migration } = await setup();
  const client = target.store.client!;
  const call = client.call.bind(client);
  let fail = true;
  vi.spyOn(client, 'call').mockImplementation(async (method, params) => {
    if (method === 'group.join' && fail) { fail = false; throw new Error('temporary failure'); }
    return call(method, params);
  });
  await migration.merge();
  expect(target.store.group).toBeNull();
  await migration.merge();
  expect(target.store.group?.id).toBe(source.store.group?.id);
  expect(migration.errors).toEqual([]);
});

test('a successful join with a lost reply is remembered without joining twice', async () => {
  const lost = await setup();
  const remote = lost.target.store.client!;
  const realCall = remote.call.bind(remote);
  const spy = vi.spyOn(remote, 'call').mockImplementation(async (method, params) => {
    const result = await realCall(method, params);
    if (method === 'group.join') throw new Error('reply lost');
    return result;
  });
  await lost.migration.merge();
  expect(lost.target.groupId).toBe(lost.source.store.group?.id);
  await lost.migration.merge();
  expect(spy.mock.calls.filter(([method]) => method === 'group.join')).toHaveLength(1);
});

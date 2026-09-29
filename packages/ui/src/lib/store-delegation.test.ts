import { describe, expect, test, vi } from 'vitest';
import type { RpcEventName, RpcEvents } from '@boite/contracts';
import { FakeClient } from './fake-client';
import { Store } from './store.svelte';

async function team() {
  const client = new FakeClient({ delayMs: 0, delegationDemo: true });
  const handlers = new Map<string, (payload: unknown) => void>();
  const on = client.on.bind(client);
  vi.spyOn(client, 'on').mockImplementation(((event: RpcEventName, handler: (payload: unknown) => void) => {
    handlers.set(event, handler);
    return on(event, handler);
  }) as typeof client.on);
  const store = new Store();
  store.attach(client);
  await store.connect();
  await store.open('t-team-running');
  await store.loadDelegation();
  await store.loadCoordination(undefined, false);
  const emit = <E extends RpcEventName>(event: E, payload: RpcEvents[E]) => handlers.get(event)!(payload);
  return { store, client, emit, close() { store.detach(); client.close(); } };
}

function hold(client: FakeClient, method: 'delegation.get' | 'collaboration.get') {
  const real = client.call.bind(client);
  const releases: (() => Promise<void>)[] = [];
  const snapshots: Promise<unknown>[] = [];
  const spy = vi.spyOn(client, 'call').mockImplementation(((name: string, params: never) => {
    if (name !== method) return real(name as never, params);
    const snapshot = real(name as never, params);
    snapshots.push(snapshot);
    return new Promise(resolve => releases.push(async () => { resolve(await snapshot); }));
  }) as typeof client.call);
  const count = () => spy.mock.calls.filter(([name]) => name === method).length;
  return { releases, snapshots, spy, count };
}

describe.each(['delegation.get', 'collaboration.get'] as const)('%s refreshes', method => {
  test('an eight-agent event burst uses one active read and one trailing read', async () => {
    const fixture = await team();
    const { store, client, emit } = fixture;
    const gate = hold(client, method);
    const event = method === 'delegation.get' ? 'delegation.changed' : 'collaboration.changed';
    const refresh = () => method === 'delegation.get' ? store.loadDelegation() : store.loadCoordination(undefined, false);
    try {
      emit(event, { threadId: 't-team-running' });
      for (let i = 0; i < 8; i++) {
        emit(event, { threadId: 't-team-running' });
        if (method === 'delegation.get') emit(event, { threadId: 't-trace' });
      }
      const completed = refresh();
      expect(gate.count()).toBe(1);
      await gate.releases.shift()!();
      await vi.waitFor(() => expect(gate.count()).toBe(2));
      await gate.releases.shift()!();
      await completed;
      expect(gate.count()).toBe(2);
    } finally { gate.spy.mockRestore(); fixture.close(); }
  });

  test('an explicit caller finishes its own read while newer events continue', async () => {
    const fixture = await team();
    const { store, client, emit } = fixture;
    const gate = hold(client, method);
    const event = method === 'delegation.get' ? 'delegation.changed' : 'collaboration.changed';
    const refresh = () => method === 'delegation.get' ? store.loadDelegation() : store.loadCoordination(undefined, false);
    try {
      const first = refresh();
      emit(event, { threadId: 't-team-running' });
      const explicit = refresh();
      await gate.releases.shift()!();
      await first;
      await vi.waitFor(() => expect(gate.count()).toBe(2));
      emit(event, { threadId: 't-team-running' });
      await gate.releases.shift()!();
      await explicit;
      expect(gate.count()).toBe(3);
      await gate.releases.shift()!();
    } finally { gate.spy.mockRestore(); fixture.close(); }
  });

  test('an overtaken conversation read cannot replace the new view or its loading state', async () => {
    const fixture = await team();
    const { store, client } = fixture;
    const gate = hold(client, method);
    const refresh = () => method === 'delegation.get' ? store.loadDelegation() : store.loadCoordination(undefined, false);
    try {
      const old = refresh();
      await store.open('t-trace');
      const fresh = refresh();
      expect(gate.count()).toBe(2);
      await gate.releases.shift()!();
      await old;
      expect(method === 'delegation.get' ? store.delegationLoading : store.coordinationLoading).toBe(true);
      await gate.releases.shift()!();
      await fresh;
      expect(method === 'delegation.get' ? store.delegation?.rootThreadId : store.coordination?.self.threadId).toBe('t-trace');
    } finally { gate.spy.mockRestore(); fixture.close(); }
  });

  test('an old client cannot replace a same-id view from the new client', async () => {
    const fixture = await team();
    const { store, client } = fixture;
    const gate = hold(client, method);
    const freshClient = new FakeClient({ delayMs: 0, delegationDemo: true });
    try {
      const old = method === 'delegation.get' ? store.loadDelegation() : store.loadCoordination(undefined, false);
      store.attach(freshClient);
      await store.connect();
      await store.open('t-trace');
      if (method === 'delegation.get') await store.loadDelegation();
      else await store.loadCoordination(undefined, false);
      const view = method === 'delegation.get' ? store.delegation : store.coordination;
      await gate.releases.shift()!();
      await old;
      expect(method === 'delegation.get' ? store.delegation : store.coordination).toBe(view);
    } finally { gate.spy.mockRestore(); fixture.close(); freshClient.close(); }
  });

  test('returning to the same conversation starts a new read instead of joining its old visit', async () => {
    const fixture = await team();
    const { store, client } = fixture;
    const gate = hold(client, method);
    const refresh = () => method === 'delegation.get' ? store.loadDelegation() : store.loadCoordination(undefined, false);
    try {
      const old = refresh();
      await store.open('t-trace');
      await store.open('t-team-running');
      const fresh = refresh();
      expect(gate.count()).toBe(2);
      await gate.releases.shift()!();
      await old;
      expect(method === 'delegation.get' ? store.delegationLoading : store.coordinationLoading).toBe(true);
      await gate.releases.shift()!();
      await fresh;
      expect(method === 'delegation.get' ? store.delegationLoading : store.coordinationLoading).toBe(false);
    } finally { gate.spy.mockRestore(); fixture.close(); }
  });
});

test('a directory request joining an event read waits for the directory too', async () => {
  const fixture = await team();
  const { store, client } = fixture;
  const gate = hold(client, 'collaboration.get');
  try {
    const event = store.loadCoordination(undefined, false);
    const directory = store.loadCoordination(undefined, true);
    await gate.releases.shift()!();
    await event;
    await vi.waitFor(() => expect(gate.count()).toBe(2));
    expect(store.coordinationDirectory).toBeNull();
    await gate.releases.shift()!();
    await directory;
    expect(store.coordinationDirectory).not.toBeNull();
    expect(gate.spy.mock.calls.filter(([method]) => method === 'collaboration.directory')).toHaveLength(1);
  } finally { gate.spy.mockRestore(); fixture.close(); }
});

test('saved coordination unlocks controls before refresh and rejects the previous save refresh', async () => {
  const fixture = await team();
  const { store, client } = fixture;
  const gate = hold(client, 'collaboration.get');
  try {
    await store.configureCoordination({ ...store.coordination!.config, mode: 'brief', resources: 'First assignment' });
    expect(store.coordinationSaving).toBe(false);
    expect(store.coordination!.config.resources).toBe('First assignment');
    await store.configureCoordination({ ...store.coordination!.config, resources: 'Second assignment' });
    expect(store.coordinationSaving).toBe(false);
    expect(store.coordination!.config.resources).toBe('Second assignment');
    await gate.releases.shift()!();
    expect(store.coordination!.config.resources).toBe('Second assignment');
    gate.spy.mockRestore();
    for (const release of gate.releases.splice(0)) await release();
    await vi.waitFor(() => expect(store.coordinationLoading).toBe(false));
    expect(store.coordination!.config.resources).toBe('Second assignment');
  } finally { gate.spy.mockRestore(); fixture.close(); }
});

test('a child load updates the current team without a get and survives an in-flight get', async () => {
  const fixture = await team();
  const { store, client } = fixture;
  const gate = hold(client, 'delegation.get');
  try {
    const agent = store.delegation!.agents.find(agent => agent.thread.id === 't-team-running')!;
    client.sampleLoad(agent.thread.id, 3);
    expect(agent.thread.load?.processes).toBe(3);
    expect(gate.count()).toBe(0);
    const loading = store.loadDelegation();
    // Capture the first response before delivering a newer pushed summary.
    await gate.snapshots[0];
    client.sampleLoad(agent.thread.id, 7);
    await gate.releases.shift()!();
    await loading;
    expect(store.delegation!.agents.find(agent => agent.thread.id === 't-team-running')!.thread.load?.processes).toBe(7);
  } finally { gate.spy.mockRestore(); fixture.close(); }
});

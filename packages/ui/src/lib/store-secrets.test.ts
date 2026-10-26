import { expect, vi } from 'vitest';
import { test } from '../test/fake-client';
import { Store } from './store.svelte';
import { RpcErrorCode } from '@boite/contracts';
import { RpcFailure } from './client';

test('an older core keeps opening and reconnecting with secret cards from its loaded history', async ({ createStore }) => {
  const { store, client } = createStore({ delayMs: 0, missing: ['secrets.pending'] });
  await client.connect();
  const asked = client.call('secrets.ask', { threadId: 't-trace', name: 'API_KEY', reason: 'fixture', requestId: 'secret-legacy' });
  asked.catch(() => undefined);
  await vi.waitFor(async () => expect((await client.call('threads.get', { threadId: 't-trace' })).messages.some(message => message.parts.some(part => part.type === 'secret_request'))).toBe(true));
  store.attach(client);
  await store.connect();
  expect(store.error).toBeNull();
  await store.open('t-trace');
  expect(store.error).toBeNull();
  expect(store.pendingSecrets.map(row => row.id)).toEqual(['secret-legacy']);
  client.drop();
  await client.restore();
  await store.reload();
  expect(store.error).toBeNull();
  expect(store.pendingSecrets.map(row => row.id)).toEqual(['secret-legacy']);
  await client.call('secrets.answer', { threadId: 't-trace', requestId: 'secret-legacy', declined: true });
  expect(store.pendingSecrets).toEqual([]);
});

test('a pending-secrets refusal remains visible instead of being treated as an older core', async ({ ready }) => {
  const { store, client } = await ready({ delayMs: 0 });
  const call = client.call.bind(client);
  const spy = vi.spyOn(client, 'call').mockImplementation(async (method, params) => {
    if (method === 'secrets.pending') throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'metadata refused for this fixture' });
    return call(method, params);
  });
  try {
    await store.open('t-trace');
    expect(store.error).toContain('metadata refused for this fixture');
  } finally { spy.mockRestore(); }
});

test('an older core removes a resolved card from its reopened page after a missed resolution event', async ({ createStore }) => {
  const { store, client } = createStore({ delayMs: 0, missing: ['secrets.pending'] });
  let missResolution = false;
  const on = client.on.bind(client);
  const spy = vi.spyOn(client, 'on').mockImplementation((event, handler) => on(event, payload => {
    if (event !== 'secret.resolved' || !missResolution) handler(payload);
  }));
  store.attach(client);
  await store.connect();
  await store.open('t-trace');
  const asked = client.call('secrets.ask', { threadId: 't-trace', name: 'API_KEY', reason: 'fixture', requestId: 'legacy-missed' });
  asked.catch(() => undefined);
  await vi.waitFor(() => expect(store.pendingSecrets).toHaveLength(1));
  missResolution = true;
  await client.call('secrets.answer', { threadId: 't-trace', requestId: 'legacy-missed', declined: true });
  await asked;
  expect(store.pendingSecrets).toHaveLength(1);
  client.drop();
  await client.restore();
  await store.reload();
  expect(store.pendingSecrets).toEqual([]);
  expect(store.error).toBeNull();
  spy.mockRestore();
});

test('pending secrets survive an unseen history page and reconnect, with thread and machine ownership', async ({ ready, createClient, resources }) => {
  const { store, client } = await ready({ delayMs: 0 });
  const asked = client.call('secrets.ask', { threadId: 't-trace', name: 'API_KEY', reason: 'fixture', requestId: 'secret-old' });
  asked.catch(() => undefined);
  await vi.waitFor(() => expect(store.pendingSecrets).toHaveLength(1));
  const card = store.pendingSecrets[0]!;
  expect(card).toMatchObject({ id: 'secret-old', threadId: 't-trace', status: 'pending', ref: null });
  expect(await client.call('secrets.pending', { threadId: 't-bench' })).toEqual([]);
  expect(await client.call('secrets.pending', { threadId: 't-trace' })).toEqual([card]);
  store.detach();
  const reloaded = new Store();
  resources.push(() => reloaded.detach());
  reloaded.attach(client);
  await reloaded.connect();
  expect(reloaded.openThread).toBeNull();
  expect(reloaded.pendingSecrets).toEqual([card]);
  // The card need not be in the history page returned on opening.
  const call = client.call.bind(client);
  const spy = vi.spyOn(client, 'call').mockImplementation(async (method, params) => {
    const result = await call(method, params);
    if (method === 'threads.get') (result as { messages: unknown[] }).messages = [];
    return result;
  });
  await reloaded.open('t-trace');
  expect(reloaded.openThread!.messages).toEqual([]);
  expect(reloaded.pendingSecrets).toEqual([card]);
  spy.mockRestore();
  await client.call('secrets.answer', { threadId: 't-trace', requestId: card.id, declined: true });
  await asked;
  expect(reloaded.pendingSecrets).toEqual([]);
  const other = await createClient({ delayMs: 0 });
  reloaded.attach(other);
  expect(reloaded.pendingSecrets).toEqual([]);
  await reloaded.connect();
  expect(reloaded.pendingSecrets).toEqual([]);
});

test('events and a newer scoped read win over an older pending-secrets snapshot', async ({ ready }) => {
  const { store, client } = await ready({ delayMs: 0 });
  const asked = client.call('secrets.ask', { threadId: 't-trace', name: 'API_KEY', reason: 'fixture', requestId: 'secret-race' });
  asked.catch(() => undefined);
  await vi.waitFor(() => expect(store.pendingSecrets).toHaveLength(1));
  const call = client.call.bind(client);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let captured = false;
  const spy = vi.spyOn(client, 'call').mockImplementation(async (method, params) => {
    const result = await call(method, params);
    if (method === 'secrets.pending' && !('threadId' in params)) { captured = true; await gate; }
    return result;
  });
  const reload = store.reload();
  try {
    await vi.waitFor(() => expect(captured).toBe(true));
    await client.call('secrets.answer', { threadId: 't-trace', requestId: 'secret-race', declined: true });
    await asked;
    await store.open('t-trace');
    const fresh = client.call('secrets.ask', { threadId: 't-bench', name: 'OTHER_KEY', reason: 'fixture', requestId: 'secret-fresh' });
    await vi.waitFor(() => expect(store.pendingSecrets.map(row => row.id)).toEqual(['secret-fresh']));
    release(); await reload;
    expect(store.pendingSecrets.map(row => row.id)).toEqual(['secret-fresh']);
    await client.call('secrets.answer', { threadId: 't-bench', requestId: 'secret-fresh', declined: true });
    await fresh;
  } finally { release(); await reload; spy.mockRestore(); }
});

test('archive and turn cancellation remove secret cards and their metadata', async ({ ready }) => {
  const { store, client } = await ready({ delayMs: 0 });
  for (const action of ['archive', 'stop'] as const) {
    if (action === 'stop') {
      await client.call('turns.start', { threadId: 't-trace', prompt: '[permission]' });
      await vi.waitFor(async () => expect(await client.call('permissions.list', { threadId: 't-trace' })).toHaveLength(1));
    }
    const asked = client.call('secrets.ask', { threadId: 't-trace', name: 'API_KEY', reason: 'fixture', requestId: `secret-${action}` });
    asked.catch(() => undefined);
    await vi.waitFor(() => expect(store.pendingSecrets).toHaveLength(1));
    if (action === 'archive') await client.call('threads.archive', { threadId: 't-trace', archived: true });
    else await client.call('turns.stop', { threadId: 't-trace' });
    expect(await asked).toMatchObject({ outcome: 'cancelled' });
    expect(store.pendingSecrets).toEqual([]);
    expect(await client.call('secrets.pending', {})).toEqual([]);
    await client.call('threads.archive', { threadId: 't-trace', archived: false });
  }
});

test('expired cards leave the dock even while disconnected', async ({ ready }) => {
  const { store, client } = await ready({ delayMs: 0 });
  const asked = client.call('secrets.ask', { threadId: 't-trace', name: 'API_KEY', reason: 'fixture', requestId: 'secret-expiry' });
  asked.catch(() => undefined);
  await vi.waitFor(() => expect(store.pendingSecrets).toHaveLength(1));
  const call = client.call.bind(client);
  const spy = vi.spyOn(client, 'call').mockImplementation(async (method, params) => {
    const result = await call(method, params);
    if (method === 'secrets.pending') for (const row of result as import('@boite/contracts').SecretRequest[]) row.expiresAt = Date.now() + 100;
    return result;
  });
  await store.reload();
  spy.mockRestore();
  client.drop();
  await vi.waitFor(() => expect(store.pendingSecrets).toEqual([]));
  await client.restore();
  await client.call('secrets.answer', { threadId: 't-trace', requestId: 'secret-expiry', declined: true });
});

test('opening a parent reads pending secrets of its direct children only', async ({ ready }) => {
  const { store, client } = await ready({ delayMs: 0, subagentsDemo: true });
  const spy = vi.spyOn(client, 'call');
  await store.open('t-subagents-ask');
  const reads = () => spy.mock.calls.filter(([method]) => method === 'secrets.pending').map(([, params]) => (params as { threadId?: string }).threadId);
  await vi.waitFor(() => expect(reads()).toEqual(expect.arrayContaining(['t-subagents-ask', 't-subagents-ask-1', 't-subagents-ask-2'])));
  expect(reads()).not.toContain('t-subagents-work-1');
  spy.mockRestore();
});

for (const closure of ['answer', 'archive', 'remove'] as const) {
  test(`a ${closure} event closes a card still hidden inside an older snapshot`, async ({ createStore }) => {
    const { store, client } = createStore({ delayMs: 0 });
    await client.connect();
    const asked = client.call('secrets.ask', { threadId: 't-trace', name: 'API_KEY', reason: 'fixture', requestId: 'secret-unseen' });
    asked.catch(() => undefined);
    await vi.waitFor(async () => expect(await client.call('secrets.pending', {})).toHaveLength(1));
    const call = client.call.bind(client);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let captured = false;
    const spy = vi.spyOn(client, 'call').mockImplementation(async (method, params) => {
      const result = await call(method, params);
      if (method === 'secrets.pending') { captured = true; await gate; }
      return result;
    });
    store.attach(client);
    const loading = store.connect();
    try {
      await vi.waitFor(() => expect(captured).toBe(true));
      expect(store.pendingSecrets).toEqual([]);
      if (closure === 'answer') await call('secrets.answer', { threadId: 't-trace', requestId: 'secret-unseen', declined: true });
      else if (closure === 'archive') await call('threads.archive', { threadId: 't-trace', archived: true });
      else await call('threads.remove', { threadId: 't-trace' });
      await asked;
      release(); await loading;
      expect(store.pendingSecrets).toEqual([]);
    } finally { release(); await loading; spy.mockRestore(); }
  });
}

test('a stale pending snapshot cannot cross a Store client replacement', async ({ ready, createClient }) => {
  const { store, client } = await ready({ delayMs: 0 });
  const asked = client.call('secrets.ask', { threadId: 't-trace', name: 'API_KEY', reason: 'fixture', requestId: 'secret-old-machine' });
  asked.catch(() => undefined);
  await vi.waitFor(() => expect(store.pendingSecrets).toHaveLength(1));
  const other = await createClient({ delayMs: 0 });
  const call = client.call.bind(client);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let captured = false;
  const spy = vi.spyOn(client, 'call').mockImplementation(async (method, params) => {
    const result = await call(method, params);
    if (method === 'secrets.pending') { captured = true; await gate; }
    return result;
  });
  const loading = store.reload();
  try {
    await vi.waitFor(() => expect(captured).toBe(true));
    store.attach(other);
    await store.connect();
    expect(store.pendingSecrets).toEqual([]);
    release(); await loading;
    expect(store.pendingSecrets).toEqual([]);
    await call('secrets.answer', { threadId: 't-trace', requestId: 'secret-old-machine', declined: true });
    await asked;
    expect(store.pendingSecrets).toEqual([]);
  } finally { release(); await loading; spy.mockRestore(); }
});

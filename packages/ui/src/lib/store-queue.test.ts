import { expect, test, vi } from 'vitest';
import { flushSync } from 'svelte';
import { FakeClient } from './fake-client';
import { Store } from './store.svelte';
import { RpcErrorCode, type RpcResult } from '@boite/contracts';
import { RpcFailure } from './client';

async function ready() {
  const store = new Store();
  const client = new FakeClient({ delayMs: 0 });
  store.attach(client);
  await store.connect();
  return { store, client };
}

const queued = (text: string, paused = false) => ({
  text: '', attachments: [], queued: [{ text, attachments: [] }], sending: false, paused
});

test('queues belong to their Store even when another machine has the same thread id', async () => {
  const first = await ready();
  const second = await ready();
  const firstCalls = vi.spyOn(first.client, 'call');
  const secondCalls = vi.spyOn(second.client, 'call');
  try {
    first.store.composerStates['t-trace'] = queued('First machine');
    second.store.composerStates['t-trace'] = queued('Second machine');
    await vi.waitFor(() => {
      expect(first.store.composerStates['t-trace']?.queued).toHaveLength(0);
      expect(second.store.composerStates['t-trace']?.queued).toHaveLength(0);
      expect(first.store.composerStates['t-trace']?.sending).toBe(false);
      expect(second.store.composerStates['t-trace']?.sending).toBe(false);
    });
    expect(firstCalls.mock.calls.filter(([method]) => method === 'turns.start')).toEqual([
      ['turns.start', expect.objectContaining({ threadId: 't-trace', prompt: 'First machine' })]
    ]);
    expect(secondCalls.mock.calls.filter(([method]) => method === 'turns.start')).toEqual([
      ['turns.start', expect.objectContaining({ threadId: 't-trace', prompt: 'Second machine' })]
    ]);
    expect(first.store.openThread).toBeNull();
    expect(second.store.openThread).toBeNull();
  } finally {
    first.store.detach(); first.client.close();
    second.store.detach(); second.client.close();
  }
});

test('paused, archived and detached queues never send automatically', async () => {
  const { store, client } = await ready();
  const calls = vi.spyOn(client, 'call');
  try {
    store.composerStates['t-trace'] = queued('Restored queue', true);
    store.threads.find(row => row.id === 't-descriptors')!.archived = true;
    store.composerStates['t-descriptors'] = queued('Archived queue');
    flushSync();
    expect(calls.mock.calls.filter(([method]) => method === 'turns.start')).toHaveLength(0);
    store.detach();
    store.composerStates['t-trace']!.paused = false;
    store.threads.find(row => row.id === 't-descriptors')!.archived = false;
    flushSync();
    expect(store.composerStates['t-trace']!.queued).toHaveLength(1);
    expect(store.composerStates['t-descriptors']!.queued).toHaveLength(1);
    expect(calls.mock.calls.filter(([method]) => method === 'turns.start')).toHaveLength(0);
  } finally { store.detach(); client.close(); }
});

test('a late refusal from the former client cannot populate the replacement session', async () => {
  const { store, client } = await ready();
  const replacement = new FakeClient({ delayMs: 0 });
  let rejectSend!: (error: unknown) => void;
  const pending = new Promise<never>((_resolve, reject) => { rejectSend = reject; });
  const call = client.call.bind(client);
  const calls = vi.spyOn(client, 'call').mockImplementation((method, params) =>
    method === 'turns.start' ? pending : call(method, params));
  const replacementCalls = vi.spyOn(replacement, 'call');
  try {
    const formerThread = { ...store.threads.find(row => row.id === 't-trace')!, status: 'running', title: 'Former session' };
    store.composerStates['t-trace'] = queued('Former session prompt');
    const formerState = store.composerStates['t-trace']!;
    await vi.waitFor(() => expect(calls.mock.calls.filter(([method]) => method === 'turns.start')).toHaveLength(1));
    store.composerStates = {};
    store.attach(replacement);
    await store.connect();
    rejectSend(new RpcFailure({ code: RpcErrorCode.Refused, message: 'Turn in flight',
      data: { reason: 'turn-in-flight', thread: formerThread } }));
    await vi.waitFor(() => expect(formerState.sending).toBe(false));
    expect(store.composerStates).toEqual({});
    expect(store.threads.find(row => row.id === 't-trace')?.title).not.toBe('Former session');
    expect(replacementCalls.mock.calls.filter(([method]) => method === 'turns.start')).toHaveLength(0);
  } finally { store.detach(); client.close(); replacement.close(); }
});

test('a late accepted batch stays sent after replacing the client', async () => {
  const { store, client } = await ready();
  const replacement = new FakeClient({ delayMs: 0 });
  let acceptSend!: (result: RpcResult<'turns.start'>) => void;
  const pending = new Promise<RpcResult<'turns.start'>>(resolve => { acceptSend = resolve; });
  // Only the turn is delayed; connection metadata continues to use the fixture.
  const call = client.call.bind(client);
  const calls = vi.spyOn(client, 'call').mockImplementation((method, params) =>
    method === 'turns.start' ? pending as ReturnType<typeof call> : call(method, params));
  try {
    store.composerStates['t-trace'] = queued('Accepted first prompt');
    store.composerStates['t-trace']!.queued.push({ text: 'Accepted second prompt', attachments: [] });
    const state = store.composerStates['t-trace']!;
    await vi.waitFor(() => expect(calls.mock.calls.filter(([method]) => method === 'turns.start')).toHaveLength(1));
    store.attach(replacement);
    await store.connect();
    acceptSend({ id: 'accepted-former-turn', threadId: 't-trace', status: 'queued',
      queuedAt: Date.now(), startedAt: null, finishedAt: null, usage: null, error: null });
    await vi.waitFor(() => expect(state.sending).toBe(false));
    expect(state.queued).toHaveLength(0);
    expect(state.paused).toBe(false);
  } finally { store.detach(); client.close(); replacement.close(); }
});

test('a late accepted activity command cannot update the replacement thread', async () => {
  const { store, client } = await ready();
  const replacement = new FakeClient({ delayMs: 0 });
  let acceptCommand!: (result: RpcResult<'threads.activity.set'>) => void;
  const pending = new Promise<RpcResult<'threads.activity.set'>>(resolve => { acceptCommand = resolve; });
  const call = client.call.bind(client);
  const calls = vi.spyOn(client, 'call').mockImplementation((method, params) =>
    method === 'threads.activity.set' ? pending as ReturnType<typeof call> : call(method, params));
  try {
    await store.open('t-trace');
    store.composerStates['t-trace'] = queued('/goal Former session goal');
    const state = store.composerStates['t-trace']!;
    await vi.waitFor(() => expect(calls.mock.calls.filter(([method]) => method === 'threads.activity.set')).toHaveLength(1));
    store.composerStates = {};
    store.attach(replacement);
    await store.connect();
    await store.open('t-trace');
    const initialActivity = JSON.stringify(store.openThread!.activity);
    acceptCommand({ goal: { objective: 'Former session goal', status: 'paused', iterations: 0, error: null }, loop: null, tasks: [] });
    await vi.waitFor(() => expect(state.sending).toBe(false));
    expect(JSON.stringify(store.openThread!.activity)).toBe(initialActivity);
    expect(state.queued).toHaveLength(0);
    expect(state.paused).toBe(false);
  } finally { store.detach(); client.close(); replacement.close(); }
});

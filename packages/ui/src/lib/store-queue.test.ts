import { expect, vi } from 'vitest';
import { test } from '../test/fake-client';
import { flushSync } from 'svelte';
import { FakeClient } from './fake-client';
import { RpcErrorCode, type RpcResult } from '@boite/contracts';
import { RpcFailure } from './client';
import { strings } from './strings';

const queued = (text: string, paused = false) => ({
  text: '', attachments: [], queued: [{ text, attachments: [] }], sending: false, paused
});

test('queues belong to their Store even when another machine has the same thread id', async ({ ready }) => {
  const first = await ready();
  const second = await ready();
  const firstCalls = vi.spyOn(first.client, 'call');
  const secondCalls = vi.spyOn(second.client, 'call');
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
});

test('paused, archived and detached queues never send automatically', async ({ ready }) => {
  const { store, client } = await ready();
  const calls = vi.spyOn(client, 'call');
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
});

test.for([['replacement', 'busy'], ['restored', 'busy'], ['replacement', 'error'], ['restored', 'error']] as const)('a late refusal from the former client cannot populate the %s session: %s', async ([owner, refusal], { ready, resources }) => {
  const { store, client } = await ready();
  const replacement = new FakeClient({ delayMs: 0 });
  resources.push(() => replacement.close());
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
    if (owner === 'restored') { store.attach(client); await store.connect(); }
    store.composerStates['t-trace'] = queued('New queued prompt', true);
    const currentState = store.composerStates['t-trace']!;
    currentState.text = 'New unsent input';
    const focus = store.promptFocus;
    rejectSend(refusal === 'busy' ? new RpcFailure({ code: RpcErrorCode.Refused, message: 'Turn in flight',
      data: { reason: 'turn-in-flight', thread: formerThread } }) : new Error('Former client failure'));
    await vi.waitFor(() => expect(formerState.sending).toBe(false));
    expect(store.composerStates['t-trace']).toBe(currentState);
    expect(currentState).toMatchObject({ text: 'New unsent input', queued: [{ text: 'New queued prompt' }] });
    expect(store.error).toBeNull();
    expect(store.promptFocus).toBe(focus);
    expect(formerState).toMatchObject({ text: 'Former session prompt', paused: true });
    expect(store.threads.find(row => row.id === 't-trace')?.title).not.toBe('Former session');
    expect(replacementCalls.mock.calls.filter(([method]) => method === 'turns.start')).toHaveLength(0);
  } finally { store.detach(); }
});

test.for(['replacement', 'restored'] as const)('a late accepted batch stays sent after switching to the %s client lease', async (owner, { ready, resources }) => {
  const { store, client } = await ready();
  const replacement = new FakeClient({ delayMs: 0 });
  resources.push(() => replacement.close());
  let acceptSend!: (result: RpcResult<'turns.start'>) => void;
  const pending = new Promise<RpcResult<'turns.start'>>(resolve => { acceptSend = resolve; });
  // Only the turn is delayed; connection metadata continues to use the fixture.
  const call = client.call.bind(client);
  let holdFirst = true;
  const calls = vi.spyOn(client, 'call').mockImplementation(async (method, params) => {
    const value = await call(method, params);
    if (method === 'turns.start' && holdFirst) { holdFirst = false; await pending; }
    return value;
  });
  try {
    store.composerStates['t-trace'] = queued('Accepted first prompt');
    store.composerStates['t-trace']!.queued.push({ text: 'Accepted second prompt', attachments: [] });
    const state = store.composerStates['t-trace']!;
    await vi.waitFor(() => expect(calls.mock.calls.filter(([method]) => method === 'turns.start')).toHaveLength(1));
    store.attach(replacement);
    await store.connect();
    await client.settled();
    if (owner === 'restored') {
      store.attach(client);
      await store.connect();
      expect(await store.send('Accepted first prompt\n\nAccepted second prompt', 't-trace')).toBe(true);
      const repeated = calls.mock.calls.filter(([method, params]) => method === 'turns.start' && (params as { prompt: string }).prompt === 'Accepted first prompt\n\nAccepted second prompt');
      expect((repeated[1]![1] as { clientRequestId: string }).clientRequestId).not.toBe((repeated[0]![1] as { clientRequestId: string }).clientRequestId);
      await client.settled();
    }
    expect(await store.send('Current session prompt', 't-trace')).toBe(true);
    const focus = store.promptFocus;
    store.editComposerText('t-trace', 'Current unsent input');
    acceptSend({ id: 'accepted-former-turn', threadId: 't-trace', status: 'queued',
      queuedAt: Date.now(), startedAt: null, finishedAt: null, usage: null, error: null });
    await vi.waitFor(() => expect(state.sending).toBe(false));
    expect(state.queued).toHaveLength(0);
    expect(state.paused).toBe(false);
    expect(state.text).toBe('Current unsent input');
    expect(store.promptFocus).toBe(focus);
    expect(calls.mock.calls.filter(([method, params]) => method === 'turns.start' && (params as { prompt: string }).prompt === 'Accepted first prompt\n\nAccepted second prompt')).toHaveLength(owner === 'restored' ? 2 : 1);
  } finally { store.detach(); }
});

test.for(['replacement', 'restored'] as const)('a late accepted activity command cannot update the %s thread lease', async (owner, { ready, resources }) => {
  const { store, client } = await ready();
  const replacement = new FakeClient({ delayMs: 0 });
  resources.push(() => replacement.close());
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
    if (owner === 'restored') { store.attach(client); await store.connect(); }
    await store.open('t-trace');
    const initialActivity = JSON.stringify(store.openThread!.activity);
    store.editComposerText('t-trace', 'Current command input');
    const currentState = store.composerStates['t-trace'];
    const focus = store.promptFocus;
    acceptCommand({ goal: { objective: 'Former session goal', status: 'paused', iterations: 0, error: null }, loop: null, tasks: [] });
    await vi.waitFor(() => expect(state.sending).toBe(false));
    expect(JSON.stringify(store.openThread!.activity)).toBe(initialActivity);
    expect(state.queued).toHaveLength(0);
    expect(state.paused).toBe(false);
    expect(store.composerStates['t-trace']).toBe(currentState);
    expect(currentState?.text).toBe('Current command input');
    expect(store.promptFocus).toBe(focus);
    expect(calls.mock.calls.filter(([method]) => method === 'threads.activity.set')).toHaveLength(1);
  } finally { store.detach(); }
});


test.for(['prepare', 'update'] as const)('a stale selection %s continuation cannot start a turn after A-B-A attachment', async (phase, { ready, resources }) => {
  const { store, client } = await ready();
  const replacement = new FakeClient({ delayMs: 0 });
  resources.push(() => replacement.close());
  const gate = deferred(), started = deferred();
  const call = vi.spyOn(client, 'call');
  const update = store.update.bind(store);
  const row = store.threads.find(row => row.id === 't-trace')!;
  const choice = { providerId: row.providerId, accountId: row.accountId, model: null, effort: row.effort, permissionMode: row.permissionMode, speed: row.speed ?? null };
  const selection = vi.spyOn(store, 'composerChoice').mockReturnValue(choice);
  const prepare = vi.spyOn(store, 'prepareDraftChoice').mockImplementation(async () => {
    if (phase === 'prepare') { started.resolve(); await gate.promise; }
    return choice;
  });
  const apply = vi.spyOn(store, 'update').mockImplementation(async (...args) => {
    const accepted = await update(...args);
    if (phase === 'update') { started.resolve(); await gate.promise; }
    return accepted;
  });
  const sending = store.send('Original selected input', 't-trace');
  try {
    await started.promise;
    store.attach(replacement); await store.connect();
    store.attach(client); await store.connect();
    store.editComposerText('t-trace', 'Newer input');
    const currentState = store.composerStates['t-trace'];
    gate.resolve();
    expect(await sending).toBe(false);
    expect(call.mock.calls.filter(([method]) => method === 'turns.start')).toHaveLength(0);
    expect(call.mock.calls.filter(([method]) => method === 'threads.update')).toHaveLength(phase === 'update' ? 1 : 0);
    expect(store.composerStates['t-trace']).toBe(currentState); expect(currentState?.text).toBe('Newer input');
    expect(store.promptFocus).toBeNull(); expect(store.error).toBeNull();
  } finally { gate.resolve(); await sending; selection.mockRestore(); prepare.mockRestore(); apply.mockRestore(); store.detach(); }
});

test.for(['accepted', 'unsupported', 'refused'] as const)('a late steer %s response cannot publish into a restored client lease', async (result, { ready, resources }) => {
  const { store, client } = await ready();
  const replacement = new FakeClient({ delayMs: 0 });
  resources.push(() => replacement.close());
  let resolve!: (value: { accepted: boolean }) => void, reject!: (error: Error) => void;
  const pending = new Promise<{ accepted: boolean }>((yes, no) => { resolve = yes; reject = no; });
  const call = client.call.bind(client);
  let first = true;
  const spy = vi.spyOn(client, 'call').mockImplementation((method, params) => {
    if (method !== 'turns.steer') return call(method, params);
    if (first) { first = false; return pending as ReturnType<typeof call>; }
    return Promise.resolve({ accepted: true }) as ReturnType<typeof call>;
  });
  const steering = store.steer('Original steering input', 't-trace', 'former-turn', [], []);
  try {
    await vi.waitFor(() => expect(spy.mock.calls.filter(([method]) => method === 'turns.steer')).toHaveLength(1));
    store.attach(replacement); await store.connect();
    store.attach(client); await store.connect();
    // A new lease can intentionally submit identical content; its key must be fresh.
    expect(await store.steer('Original steering input', 't-trace', 'former-turn', [], [])).toBe(true);
    const repeated = spy.mock.calls.filter(([method, params]) => method === 'turns.steer' && (params as { prompt: string }).prompt === 'Original steering input');
    expect((repeated[1]![1] as { clientRequestId: string }).clientRequestId).not.toBe((repeated[0]![1] as { clientRequestId: string }).clientRequestId);
    expect(await store.steer('Current steering input', 't-trace', 'current-turn', [], [])).toBe(true);
    const focus = store.promptFocus;
    store.editComposerText('t-trace', 'Current unsent steering input');
    const state = store.composerStates['t-trace'];
    if (result !== 'refused') resolve({ accepted: result === 'accepted' }); else reject(new Error('Former steering failure'));
    expect(await steering).toBe(result === 'accepted' ? true : null);
    expect(store.promptFocus).toBe(focus); expect(focus?.turnId).toBe('current-turn');
    expect(store.composerStates['t-trace']).toBe(state); expect(state?.text).toBe('Current unsent steering input');
    expect(store.error).toBeNull();
    expect(spy.mock.calls.filter(([method, params]) => method === 'turns.steer' && (params as { prompt: string }).prompt === 'Original steering input')).toHaveLength(2);
  } finally { resolve({ accepted: false }); await steering; spy.mockRestore(); store.detach(); }
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test('a completed tool sends queued input into the running turn even off screen', async ({ ready }) => {
  const { store, client } = await ready({ delayMs: 40 });
  const calls = vi.spyOn(client, 'call');
  await store.send('[tools] Keep working', 't-trace');
  store.composerStates['t-trace'] = queued('Use the new instructions');
  await store.open('t-parser');
  await vi.waitFor(() => expect(calls.mock.calls.some(([method]) => method === 'turns.steer')).toBe(true));
  await vi.waitFor(() => expect(store.composerStates['t-trace']?.queued).toHaveLength(0));
  expect(store.threads.find(thread => thread.id === 't-trace')?.status).toBe('running');
  expect(calls.mock.calls.filter(([method]) => method === 'turns.stop')).toHaveLength(0);
  expect(calls.mock.calls.filter(([method]) => method === 'turns.start')).toHaveLength(1);
  const steered = calls.mock.calls.find(([method]) => method === 'turns.steer')![1];
  expect(steered).toMatchObject({ threadId: 't-trace', prompt: 'Use the new instructions' });
  const original = await client.call('threads.get', { threadId: 't-trace' });
  expect(original.messages.filter(message => message.role === 'user').at(-1)).toMatchObject({ turnId: original.turns.at(-1)!.id });
  expect(store.openThread!.id).toBe('t-parser');
});

test('unsupported steering holds the queue until the running turn finishes', async ({ ready }) => {
  const { store, client } = await ready({ delayMs: 20 });
  const call = client.call.bind(client);
  const calls = vi.spyOn(client, 'call').mockImplementation((method, params) =>
    method === 'turns.steer' ? Promise.resolve({ accepted: false }) as ReturnType<typeof call> : call(method, params));
  await store.send('[tools]', 't-trace');
  store.composerStates['t-trace'] = queued('After unsupported turn');
  await vi.waitFor(() => expect(calls.mock.calls.some(([method]) => method === 'turns.steer')).toBe(true));
  expect(store.composerStates['t-trace']?.queued).toHaveLength(1);
  expect(store.composerStates['t-trace']?.paused).toBe(false);
  await vi.waitFor(() => expect(calls.mock.calls.filter(([method]) => method === 'turns.start')).toHaveLength(2));
  expect(calls.mock.calls.filter(([method]) => method === 'turns.stop')).toHaveLength(0);
});

test('Send now explains an unsupported turn while retaining the queued input', async ({ ready }) => {
  const { store, client } = await ready({ delayMs: 40 });
  await store.open('t-trace');
  const call = client.call.bind(client);
  vi.spyOn(client, 'call').mockImplementation((method, params) =>
    method === 'turns.steer' ? Promise.reject(new RpcFailure({ code: RpcErrorCode.MethodNotFound, message: 'no turns.steer method' })) : call(method, params));
  await store.send('[tools] Keep working', 't-trace');
  store.composerStates['t-trace'] = queued('Keep this input', true);
  await store.sendQueuedNow('t-trace');
  expect(store.error).toBe(strings.composer.queueNotAccepted);
  expect(store.composerStates['t-trace']?.queued.map(entry => entry.text)).toEqual(['Keep this input']);
  expect(store.composerStates['t-trace']?.sending).toBe(false);
  expect(store.composerStates['t-trace']?.paused).toBe(false);
});

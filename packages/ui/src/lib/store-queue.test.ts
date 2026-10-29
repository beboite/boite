import { beforeEach, expect, vi } from 'vitest';
import { test } from '../test/fake-client';
import { flushSync } from 'svelte';
import { FakeClient } from './fake-client';
import { RpcErrorCode } from '@boite/contracts';
import { RpcFailure } from './client';
import { TestComposerCore } from '../test/composer-core';

// Direct-send lease tests also cover a core without composer persistence.
beforeEach(() => localStorage.clear());

const OLD_CORE = { delayMs: 0, missing: ['composer.list'] };

const queued = (text: string, paused = false) => ({
  text: '', attachments: [], queued: [{ text, attachments: [] }], sending: false, paused
});

test('queues belong to their Store even when another machine has the same thread id', async ({ ready }) => {
  const firstCore = new TestComposerCore(), secondCore = new TestComposerCore();
  const first = await ready({ delayMs: 0, composerState: firstCore });
  const second = await ready({ delayMs: 0, composerState: secondCore });
  const firstCalls = vi.spyOn(first.client, 'call'), secondCalls = vi.spyOn(second.client, 'call');
  first.store.queuePrompt('t-trace', { text: 'First machine', attachments: [] });
  second.store.queuePrompt('t-trace', { text: 'Second machine', attachments: [] });
  await vi.waitFor(() => {
    expect(firstCore.start).toHaveBeenCalledWith(expect.objectContaining({ threadId: 't-trace', prompt: 'First machine' }));
    expect(secondCore.start).toHaveBeenCalledWith(expect.objectContaining({ threadId: 't-trace', prompt: 'Second machine' }));
    expect(first.store.composerStates['t-trace']?.queued).toHaveLength(0);
    expect(second.store.composerStates['t-trace']?.queued).toHaveLength(0);
  });
  for (const calls of [firstCalls, secondCalls]) expect(calls.mock.calls.filter(([method]) => method === 'turns.start')).toEqual([]);
  const texts = async (client: FakeClient) => (await client.call('threads.get', { threadId: 't-trace' })).messages.filter(message => message.role === 'user').flatMap(message => message.parts.flatMap(part => part.type === 'text' ? [part.text] : []));
  expect((await texts(first.client)).filter(text => /^(First|Second) machine$/.test(text))).toEqual(['First machine']);
  expect((await texts(second.client)).filter(text => /^(First|Second) machine$/.test(text))).toEqual(['Second machine']);
  expect(first.store.openThread).toBeNull(); expect(second.store.openThread).toBeNull();
});

test('paused, archived and detached queues never send automatically', async ({ ready }) => {
  const core = new TestComposerCore();
  const { store, client } = await ready({ delayMs: 0, composerState: core });
  store.composerStates['t-trace'] = queued('Restored queue', true);
  await client.call('threads.archive', { threadId: 't-descriptors', archived: true });
  store.queuePrompt('t-descriptors', { text: 'Archived queue', attachments: [] });
  await vi.waitFor(async () => expect((await client.call('composer.list', {})).find(row => row.id === 't-descriptors')?.value?.input.queued).toHaveLength(1));
  expect(core.start).not.toHaveBeenCalled();
  store.detach();
  store.composerStates['t-trace']!.paused = false;
  flushSync();
  expect(store.composerStates['t-trace']!.queued).toHaveLength(1);
  expect(store.composerStates['t-descriptors']!.queued).toHaveLength(1);
  expect(core.start).not.toHaveBeenCalled();
});

test.for([['replacement', 'busy'], ['restored', 'busy'], ['replacement', 'error'], ['restored', 'error']] as const)('a late composer.put refusal cannot populate the %s session: %s', async ([owner, refusal], { ready, resources }) => {
  const { store, client } = await ready({ delayMs: 0 });
  const replacement = new FakeClient({ delayMs: 0 });
  resources.push(() => replacement.close());
  let rejectPut!: (error: unknown) => void;
  const pending = new Promise<never>((_resolve, reject) => { rejectPut = reject; });
  const answered = deferred();
  const call = client.call.bind(client);
  let first = true;
  const calls = vi.spyOn(client, 'call').mockImplementation(async (method, params) => {
    if (method === 'composer.put' && (params as { id?: string }).id === 't-trace' && first) {
      first = false;
      try { return await pending; } finally { answered.resolve(); }
    }
    return call(method, params);
  });
  const formerThread = { ...store.threads.find(row => row.id === 't-trace')!, status: 'running', title: 'Former session' };
  try {
    store.queuePrompt('t-trace', { text: 'Former session prompt', attachments: [] });
    await vi.waitFor(() => expect(calls.mock.calls.filter(([method, params]) => method === 'composer.put' && (params as { id?: string }).id === 't-trace')).toHaveLength(1));
    store.composerStates = {};
    store.attach(replacement); await store.connect();
    if (owner === 'restored') { store.attach(client); await store.connect(); }
    store.composerStates['t-trace'] = queued('New queued prompt', true);
    const currentState = store.composerStates['t-trace']!;
    currentState.text = 'New unsent input';
    const focus = store.promptFocus;
    rejectPut(refusal === 'busy' ? new RpcFailure({ code: RpcErrorCode.Refused, message: 'Turn in flight', data: { reason: 'turn-in-flight', thread: formerThread } }) : new Error('Former client failure'));
    await answered.promise;
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(store.composerStates['t-trace']).toBe(currentState);
    expect(currentState).toMatchObject({ text: 'New unsent input', queued: [{ text: 'New queued prompt' }] });
    expect(store.error).toBeNull(); expect(store.promptFocus).toBe(focus);
    expect(store.threads.find(row => row.id === 't-trace')?.title).not.toBe('Former session');
    expect((await replacement.call('threads.get', { threadId: 't-trace' })).messages.some(message => message.role === 'user' && message.parts.some(part => part.type === 'text' && part.text === 'Former session prompt'))).toBe(false);
  } finally { rejectPut(new Error('Test finished')); store.detach(); }
});

// A queue's late acceptance now arrives through composer.put. Its delivery runs
// on the old core even after this Store switches clients; its answer must not
// overwrite the new lease, including A-B-A attachment.
test.for([['replacement', 'prompt'], ['restored', 'prompt'], ['replacement', 'activity'], ['restored', 'activity']] as const)('a late accepted composer answer preserves the %s lease for %s', async ([owner, kind], { ready, resources }) => {
  const core = new TestComposerCore();
  const { store, client } = await ready({ delayMs: 0, composerState: core });
  const replacement = new FakeClient({ delayMs: 0 });
  resources.push(() => replacement.close());
  const gate = deferred();
  const original = client.call.bind(client);
  let held = false;
  const calls = vi.spyOn(client, 'call').mockImplementation(async (method, params) => {
    const answer = await original(method, params);
    if (method === 'composer.put' && (params as { id?: string }).id === 't-trace' && !held) { held = true; await gate.promise; }
    return answer;
  });
  const prompt = kind === 'activity' ? '/goal Former session goal' : 'Accepted first prompt';
  try {
    store.queuePrompt('t-trace', { text: prompt, attachments: [] });
    if (kind === 'prompt') store.queuePrompt('t-trace', { text: 'Accepted second prompt', attachments: [] });
    await vi.waitFor(() => expect(held).toBe(true));
    await vi.waitFor(() => expect(kind === 'activity' ? core.activity : core.start).toHaveBeenCalledTimes(1));
    store.composerStates = {};
    store.attach(replacement); await store.connect();
    await client.settled();
    if (owner === 'restored') { store.attach(client); await store.connect(); }
    await store.open('t-trace');
    const activity = JSON.stringify(store.openThread!.activity);
    store.editComposerText('t-trace', 'Current unsent input');
    const state = store.composerStates['t-trace'];
    const focus = store.promptFocus;
    gate.resolve();
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(store.composerStates['t-trace']).toBe(state);
    expect(state?.text).toBe('Current unsent input');
    expect(store.promptFocus).toBe(focus);
    expect(JSON.stringify(store.openThread!.activity)).toBe(activity);
    expect(kind === 'activity' ? core.activity : core.start).toHaveBeenCalledTimes(1);
    const delivered = await original('threads.get', { threadId: 't-trace' });
    if (kind === 'prompt') {
      const texts = delivered.messages.filter(message => message.role === 'user').flatMap(message => message.parts.flatMap(part => part.type === 'text' ? [part.text] : []));
      expect(texts.filter(text => text.includes('Accepted first prompt') || text.includes('Accepted second prompt'))).toEqual(['Accepted first prompt\n\nAccepted second prompt']);
    } else expect(delivered.activity?.goal?.objective).toBe('Former session goal');
    expect(calls.mock.calls.filter(([method]) => method === 'turns.start' || method === 'threads.activity.set')).toHaveLength(0);
  } finally { gate.resolve(); store.detach(); }
});

test.for(['prepare', 'update'] as const)('a stale selection %s continuation cannot start a turn after A-B-A attachment', async (phase, { ready, resources }) => {
  const { store, client } = await ready(OLD_CORE);
  const replacement = new FakeClient(OLD_CORE);
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
  const { store, client } = await ready(OLD_CORE);
  const replacement = new FakeClient(OLD_CORE);
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
  const core = new TestComposerCore();
  const { store, client } = await ready({ delayMs: 40, composerState: core });
  const calls = vi.spyOn(client, 'call');
  await store.send('[tools] Keep working', 't-trace');
  store.queuePrompt('t-trace', { text: 'Use the new instructions', attachments: [] });
  await store.open('t-parser');
  await vi.waitFor(() => expect(core.steer).toHaveBeenCalled());
  await vi.waitFor(() => expect(store.composerStates['t-trace']?.queued).toHaveLength(0));
  expect(store.threads.find(thread => thread.id === 't-trace')?.status).toBe('running');
  expect(calls.mock.calls.filter(([method]) => method === 'turns.stop')).toHaveLength(0);
  expect(calls.mock.calls.filter(([method]) => method === 'turns.start')).toHaveLength(1);
  expect(core.steer).toHaveBeenCalledWith(expect.objectContaining({ threadId: 't-trace', prompt: 'Use the new instructions' }));
  const original = await client.call('threads.get', { threadId: 't-trace' });
  expect(original.messages.filter(message => message.role === 'user').at(-1)).toMatchObject({ turnId: original.turns.at(-1)!.id });
  expect(store.openThread!.id).toBe('t-parser');
});

test('unsupported steering holds the queue until the running turn finishes', async ({ ready }) => {
  const core = new TestComposerCore();
  const { store, client } = await ready({ delayMs: 40, composerState: core });
  core.steer.mockResolvedValue({ accepted: false });
  const calls = vi.spyOn(client, 'call');
  await store.send('[tools]', 't-trace');
  store.queuePrompt('t-trace', { text: 'After unsupported turn', attachments: [] });
  await vi.waitFor(() => expect(core.steer).toHaveBeenCalled());
  expect(store.composerStates['t-trace']?.queued).toHaveLength(1);
  expect(store.composerStates['t-trace']?.paused).toBe(false);
  await vi.waitFor(() => expect(core.start).toHaveBeenCalledTimes(1));
  await vi.waitFor(() => expect(store.composerStates['t-trace']?.queued).toHaveLength(0));
  expect(core.start).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'After unsupported turn' }));
  expect(calls.mock.calls.filter(([method]) => method === 'turns.stop')).toHaveLength(0);
});

test('Send now retains queued input when steering is unsupported, then the core delivers it after the turn', async ({ ready }) => {
  const core = new TestComposerCore();
  const { store, client } = await ready({ delayMs: 40, composerState: core });
  await store.open('t-trace');
  core.steer.mockResolvedValue({ accepted: false });
  await store.send('[tools] Keep working', 't-trace');
  store.composerStates['t-trace'] = queued('Keep this input', true);
  await store.sendQueuedNow('t-trace');
  await vi.waitFor(() => expect(core.steer).toHaveBeenCalled());
  expect(store.composerStates['t-trace']?.queued.map(entry => entry.text)).toEqual(['Keep this input']);
  expect(store.composerStates['t-trace']?.paused).toBe(false);
  expect(store.error).toBeNull();
  await vi.waitFor(() => expect(store.composerStates['t-trace']?.queued).toHaveLength(0));
  expect(core.start).toHaveBeenCalledTimes(1);
  expect((await client.call('threads.get', { threadId: 't-trace' })).messages.filter(message => message.role === 'user').at(-1)?.parts).toEqual([{ type: 'text', text: 'Keep this input' }]);
});

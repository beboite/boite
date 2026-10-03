import { afterEach, expect, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { test } from '../test/fake-client';
import ThreadRecovery from './ThreadRecovery.svelte';

let view: ReturnType<typeof mount> | undefined;
afterEach(() => {
  if (view) unmount(view, { outro: false });
  view = undefined;
  document.body.replaceChildren();
});

test('a held prompt resumes once on its owning store, retaining input and execution', async ({ ready }) => {
  const { store, client } = await ready();
  const held = client.holdAfterRestart('t-trace', 'keep this exact prompt');
  await store.open('t-trace');
  await expect(client.call('threads.archive', { threadId: held.threadId, onlyIfIdle: true })).rejects.toThrow('pending');
  const before = store.openThread!.messages.filter(message => message.turnId === held.id && message.role === 'user');
  const spy = vi.spyOn(client, 'call');
  view = mount(ThreadRecovery, { target: document.body, props: { store } });
  flushSync();
  expect(document.body.textContent).toContain('Prompt saved before restart');
  const resume = document.querySelector<HTMLButtonElement>('button')!;
  resume.click();
  resume.click();
  await vi.waitFor(() => expect(spy.mock.calls.filter(([method]) => method === 'turns.recover')).toHaveLength(1));
  await client.settled();
  const after = await client.call('threads.get', { threadId: held.threadId });
  expect(after.turns.find(turn => turn.id === held.id)).toMatchObject({ status: 'done', execution: held.execution });
  expect(after.messages.filter(message => message.turnId === held.id && message.role === 'user')).toEqual(before);
  flushSync();
  expect(document.querySelector('[data-testid="thread-recovery"]')).toBeNull();
});

test('a paired client can discard exactly the held prompt without starting a turn', async ({ ready }) => {
  const { store, client } = await ready({ delayMs: 0, principal: 'session' });
  const held = client.holdAfterRestart('t-trace', 'discard this');
  await store.open('t-trace');
  view = mount(ThreadRecovery, { target: document.body, props: { store } });
  flushSync();
  document.querySelectorAll<HTMLButtonElement>('button')[1]!.click();
  await vi.waitFor(() => expect(store.openThread?.turns.find(turn => turn.id === held.id)?.status).toBe('stopped'));
  expect((await client.call('scheduler.get', {})).running.filter(run => run.threadId === held.threadId)).toEqual([]);
  const repeated = await client.call('turns.recover', { threadId: held.threadId, turnId: held.id, action: 'resume' });
  expect(repeated.status).toBe('stopped');
  expect(repeated.queueHold).toBeNull();
});

test('offline controls stay disabled and a response from a detached machine cannot replace the current thread', async ({ ready }) => {
  const { store, client } = await ready();
  const held = client.holdAfterRestart('t-trace', 'later');
  await store.open('t-trace');
  view = mount(ThreadRecovery, { target: document.body, props: { store } });
  store.connection = 'closed';
  flushSync();
  expect([...document.querySelectorAll<HTMLButtonElement>('button')].every(button => button.disabled)).toBe(true);
  store.connection = 'ready';
  let reject: (error: Error) => void = () => undefined;
  const call = client.call.bind(client);
  vi.spyOn(client, 'call').mockImplementation((method, params) => method === 'turns.recover'
    ? new Promise((_, failure) => { reject = failure; }) : call(method, params));
  const pending = store.recoverTurn(held.threadId, held.id, 'resume');
  await store.open('t-descriptors');
  reject(new Error('old machine failed'));
  await pending;
  expect(store.openThread?.id).toBe('t-descriptors');
  expect(store.error).not.toBe('old machine failed');
});

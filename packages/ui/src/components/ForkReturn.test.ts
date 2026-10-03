import { afterEach, expect, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { test } from '../test/fake-client';
import ForkReturn from './ForkReturn.svelte';

let view: ReturnType<typeof mount> | undefined;
afterEach(() => {
  if (view) unmount(view, { outro: false });
  view = undefined;
  document.body.replaceChildren();
});

test('a fork retains origin and response-loss retries return exactly one letter', async ({ ready }) => {
  const { store, client } = await ready();
  await store.open('t-trace');
  const original = store.openThread!;
  const message = original.messages.find(entry => entry.state === 'complete')!;
  const fork = (await store.fork(message.id))!;
  expect(fork.forkOrigin).toEqual({ threadId: original.id, messageId: message.id, turnId: message.turnId, mode: 'seeded' });
  expect((await client.call('threads.list', {})).find(thread => thread.id === fork.id)?.forkOrigin).toEqual(fork.forkOrigin);
  const calls: string[] = [];
  const call = client.call.bind(client);
  vi.spyOn(client, 'call').mockImplementation(async (method, params) => {
    const result = await call(method, params);
    if (method === 'threads.mergeBack') {
      calls.push((params as { requestId: string }).requestId);
      if (calls.length === 1) throw new Error('response lost');
    }
    return result;
  });
  view = mount(ForkReturn, { target: document.body, props: { store, thread: store.openThread! } });
  flushSync();
  const text = document.querySelector<HTMLTextAreaElement>('textarea')!;
  text.value = 'The parser needs an explicit end marker.';
  text.dispatchEvent(new Event('input', { bubbles: true })); flushSync();
  const submit = () => document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  submit(); submit();
  await vi.waitFor(() => expect(store.error).toBe('response lost'));
  flushSync(); submit();
  await vi.waitFor(() => expect(document.querySelector('[role="status"]')?.textContent).toContain('Conclusions sent'));
  expect(calls).toHaveLength(2);
  expect(calls[1]).toBe(calls[0]);
  const delivered = await call('collaboration.get', { threadId: original.id });
  expect(delivered.messages.filter(letter => letter.from.threadId === fork.id)).toHaveLength(1);
  expect(delivered.messages.find(letter => letter.from.threadId === fork.id)?.text).toBe('The parser needs an explicit end marker.');
});

test('the fake rejects foreign origins, changed replay bodies and disabled coordination', async ({ ready }) => {
  const { client } = await ready();
  const original = await client.call('threads.get', { threadId: 't-trace' });
  const message = original.messages.find(entry => entry.state === 'complete')!;
  const fork = await client.call('threads.fork', { threadId: original.id, messageId: message.id });
  await expect(client.call('threads.mergeBack', { threadId: original.id, summary: 'invalid', requestId: 'bad-origin' })).rejects.toThrow('recorded source');
  const request = { threadId: fork.id, summary: 'Exact summary', requestId: 'same-request' };
  const first = await client.call('threads.mergeBack', request);
  const config = (await client.call('collaboration.get', { threadId: fork.id })).config;
  await client.call('collaboration.configure', { threadId: fork.id, config: { ...config, paused: true } });
  expect(await client.call('threads.mergeBack', request)).toEqual(first);
  await expect(client.call('threads.mergeBack', { ...request, summary: 'changed' })).rejects.toThrow('different content');
  await expect(client.call('threads.mergeBack', { ...request, requestId: 'new-request' })).rejects.toThrow('paused');
  await client.call('threads.archive', { threadId: original.id });
  await expect(client.call('threads.mergeBack', request)).rejects.toThrow('unavailable');
});

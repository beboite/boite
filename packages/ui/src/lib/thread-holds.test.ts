import { expect, test, vi } from 'vitest';
import { holdThread } from './thread-holds';

function fakeClient(refuse = 0) {
  const calls: string[] = [];
  let refusals = refuse;
  const client = {
    call: vi.fn(async (method: string, params: { threadId: string }) => {
      calls.push(`${method} ${params.threadId}`);
      if (method === 'threads.subscribe' && refusals > 0) { refusals -= 1; throw new Error('refused'); }
      return null;
    })
  };
  return { client: client as never, calls };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('holders of one thread share one subscription, and the last to leave lets it go', async () => {
  const { client, calls } = fakeClient();
  const first = holdThread(client, 't-1', () => false);
  const second = holdThread(client, 't-1', () => false);
  await Promise.all([first.ready, second.ready]);
  first.release();
  first.release();
  await settle();
  expect(calls).toEqual(['threads.subscribe t-1']);
  second.release();
  await settle();
  expect(calls).toEqual(['threads.subscribe t-1', 'threads.unsubscribe t-1']);
});

test('a thread open in the chat keeps its subscription when the last holder leaves', async () => {
  const { client, calls } = fakeClient();
  const hold = holdThread(client, 't-1', () => true);
  await hold.ready;
  hold.release();
  await settle();
  expect(calls).toEqual(['threads.subscribe t-1']);
});

test('a holder that comes back before the release lands keeps the thread subscribed', async () => {
  const { client, calls } = fakeClient();
  const first = holdThread(client, 't-1', () => false);
  first.release();
  const second = holdThread(client, 't-1', () => false);
  await second.ready;
  await settle();
  expect(calls.filter((call) => call.startsWith('threads.unsubscribe'))).toEqual([]);
});

test('a refused subscription is not shared: the next holder asks again', async () => {
  const { client, calls } = fakeClient(1);
  const first = holdThread(client, 't-1', () => false);
  await expect(first.ready).rejects.toThrow('refused');
  first.release();
  const second = holdThread(client, 't-1', () => false);
  await second.ready;
  await settle();
  expect(calls).toEqual(['threads.subscribe t-1', 'threads.subscribe t-1']);
});

import { expect, test } from 'vitest';
import { FakeClient } from './fake-client';
import { FakeContext } from './fake-client/context';
import { seed } from './fake-client/seed';
import { capabilityMethods } from './fake-client/capabilities';
import { steerUser } from './fake-client/user-steering';

test('fake Muse steering availability agrees with accepting a live user message', async () => {
  const ctx = new FakeContext({ delayMs: 0 });
  seed(ctx);
  const thread = ctx.thread('t-trace');
  ctx.providers.find(provider => provider.id === thread.providerId)!.protocol = 'muse';
  const turn = { id: 'turn-live-muse', threadId: thread.id, status: 'running' as const, queuedAt: 1, startedAt: 1, finishedAt: null, usage: null, error: null };
  thread.status = 'running';
  thread.turns.push(turn);
  ctx.inFlight.set(thread.id, { cancelled: false, done: Promise.resolve() });
  const capabilities = await capabilityMethods(ctx)['threads.capabilities']({ threadId: thread.id });
  expect(capabilities.steering).toEqual({ supported: true, available: true, reason: null });
  expect(await steerUser(ctx, { threadId: thread.id, turnId: turn.id, prompt: 'Check the tests too', clientRequestId: 'muse_steering_once' })).toEqual({ accepted: true });
  expect(thread.messages.at(-1)?.parts).toEqual([{ type: 'text', text: 'Check the tests too' }]);
});

test('capability reads agree for owner and paired device and refuse an unscoped fake agent', async () => {
  const client = new FakeClient({ delayMs: 0 });
  await client.connect();
  try {
    const threads = await client.call('threads.list', {});
    const threadId = threads[0]!.id;
    const owner = await client.call('threads.capabilities', { threadId });
    client.becomes('session');
    expect(await client.call('threads.capabilities', { threadId })).toEqual(owner);
    client.becomes('agent');
    await expect(client.call('threads.capabilities', { threadId })).rejects.toThrow('thread-bound agent identity');
  } finally { client.close(); }
});

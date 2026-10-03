import { expect, test } from 'vitest';
import { FakeClient } from './fake-client';

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

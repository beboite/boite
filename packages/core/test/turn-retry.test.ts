import { expect, test } from 'bun:test';
import { echoThread, startTestCore, waitFor } from './harness.ts';

test('resending an accepted request returns its turn even after completion and refuses changed content', async () => {
  const h = await startTestCore();
  try {
    const client = await h.connect();
    const { threadId } = await echoThread(h, client);
    const params = { threadId, prompt: 'once', clientRequestId: 'retry-test-1' };
    const [first, concurrent] = await Promise.all([client.call('turns.start', params), client.call('turns.start', params)]);
    expect(concurrent.id).toBe(first.id);
    await waitFor(() => h.core.journal.getTurn(first.id)?.status === 'done');
    const retry = await client.call('turns.start', params);
    expect(retry.id).toBe(first.id);
    expect(h.core.journal.listTurns(threadId)).toHaveLength(1);
    await expect(client.call('turns.start', { ...params, prompt: 'changed' })).rejects.toThrow('clientRequestId');
  } finally { await h.stop(); }
});

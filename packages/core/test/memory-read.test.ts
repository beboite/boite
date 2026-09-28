import { expect, test } from 'bun:test';
import { echoThread, startTestCore } from './harness.ts';

test('memory RPC reads applied limits and threads.get recovers bounded memory notices', async () => {
  const harness = await startTestCore({ settings: { agentMemoryBudgetMb: 8192, threadMemoryCapMb: 0, memoryReserveMb: 3072 } });
  try {
    const client = await harness.connect();
    const status = await client.call('resources.memoryStatus', {});
    expect(status.limits).toEqual({ agentMemoryBudgetMb: 8192, threadMemoryCapMb: 4096, memoryReserveMb: 3072 });
    expect(status.agentBytes).toBe(0);
    expect(status.availableBytes).toBeGreaterThan(0);
    const { threadId } = await echoThread(harness, client);
    for (let at = 0; at < 103; at++) {
      harness.core.bus.emit('resources.memory', { threadId, kind: 'thread-cap', state: 'ok', at });
    }
    const thread = await client.call('threads.get', { threadId });
    expect(thread.memoryEvents).toHaveLength(100);
    expect(thread.memoryEvents?.[0]?.at).toBe(3);
    expect(thread.memoryEvents?.at(-1)?.at).toBe(102);
    expect(thread.messages).toHaveLength(0);
  } finally { await harness.stop(); }
});

import { expect, test } from 'bun:test';
import { resolveMemoryLimits } from '../src/memory-limits.ts';
import { processPlatform } from '../src/platform/index.ts';
import { echoThread, startTestCore } from './harness.ts';

test('memory RPC reads applied limits and threads.get recovers bounded memory notices', async () => {
  const harness = await startTestCore({ settings: { agentMemoryBudgetPercent: 25, threadMemoryCapMb: 0, memoryReserveMb: 3072 } });
  try {
    const client = await harness.connect();
    const status = await client.call('resources.memoryStatus', {});
    expect(status.limits).toEqual(resolveMemoryLimits(harness.core.settings.get(), processPlatform.machineMemory()!.totalBytes));
    expect(status.agentBytes).toBe(0);
    if (process.platform === 'darwin') expect(status.availableBytes).toBeNull();
    else expect(status.availableBytes).toBeGreaterThan(0);
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


test('a legacy stored MB budget is ignored', async () => {
  const harness = await startTestCore();
  try {
    harness.core.journal.setSetting('settings', { agentMemoryBudgetMb: 512 });
    const settings = harness.core.settings.get();
    expect(settings.agentMemoryBudgetPercent).toBe(60);
    expect(resolveMemoryLimits(settings, 32 * 1024 ** 3).budgetMb).toBe(19456);
  } finally { await harness.stop(); }
});

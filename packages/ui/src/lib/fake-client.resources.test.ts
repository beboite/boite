import { expect } from 'vitest';
import { RpcErrorCode } from '@boite/contracts';
import { test } from '../test/fake-client';

test('paired resource snapshots expose only sanitized readings and retain owner-only controls', async ({ createClient }) => {
  const client = await createClient({ delayMs: 0, principal: 'session' });
  const snapshot = await client.call('resources.usage', { watch: true });
  expect(snapshot.agents.length).toBeGreaterThan(0);
  const row = snapshot.agents[0]!;
  expect(Object.keys(row).sort()).toEqual(['disk', 'load', 'loadAvailable', 'model', 'network', 'parentThreadId', 'projectId', 'providerId', 'status', 'threadId', 'title']);
  expect(row.disk).toMatchObject({ readBytes: null, writeBytes: null, coverage: 'unavailable', source: 'unavailable' });
  expect(row.network).toMatchObject({ readBytesPerSecond: null, writeBytesPerSecond: null, coverage: 'unavailable' });
  for (const params of [null, [], 'all', { watch: null }, { watch: 1 }, { watch: 'true' }]) {
    await expect(client.call('resources.usage', params as never)).rejects.toMatchObject({ code: RpcErrorCode.InvalidParams });
  }
  await expect(client.call('resources.list', {})).rejects.toMatchObject({ code: RpcErrorCode.Refused });
  await expect(client.call('resources.killTree', { threadId: row.threadId })).rejects.toMatchObject({ code: RpcErrorCode.Refused });
  await client.call('resources.usage', { watch: false });
  client.becomes('agent');
  await expect(client.call('resources.usage', { watch: true })).rejects.toMatchObject({ code: RpcErrorCode.Refused });
});

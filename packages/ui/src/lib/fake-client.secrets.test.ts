import { expect, vi } from 'vitest';
import { RpcErrorCode, SECRET_TRANSIT_TTL_MS } from '@boite/contracts';
import { test } from '../test/fake-client';
import type { FakeClient } from './fake-client';

const request = { threadId: 't-trace', name: 'API_KEY', reason: 'Synthetic fixture.' };
const use = { action: 'write' as const, path: '.env', key: 'API_KEY' };

async function answer(client: FakeClient, requestId: string) {
  const asked = client.call('secrets.ask', { ...request, requestId, replace: false });
  asked.catch(() => undefined);
  await vi.waitFor(async () => expect(await client.call('secrets.pending', { threadId: request.threadId })).toHaveLength(1));
  await client.call('secrets.answer', { threadId: request.threadId, requestId, value: 'synthetic-secret-0123456789' });
  return (await asked).ref!;
}

test('legacy replacement is refused before opening a card, including an idempotent retry', async ({ createClient }) => {
  const client = await createClient({ delayMs: 0 });
  for (const requestId of ['legacy-new', 'legacy-retry']) {
    if (requestId === 'legacy-retry') await answer(client, requestId);
    let error: unknown;
    void client.call('secrets.ask', { ...request, requestId, replace: true } as never).catch(failure => { error = failure; });
    await vi.waitFor(() => expect(error).toMatchObject({ code: RpcErrorCode.Refused, data: { field: 'replace', expected: false } }));
    expect(await client.call('secrets.pending', {})).toEqual([]);
  }
});

test('legacy keep is refused without answering the card or keeping a project key', async ({ createClient }) => {
  const client = await createClient({ delayMs: 0 });
  const requestId = 'legacy-keep';
  const asked = client.call('secrets.ask', { ...request, requestId, replace: false });
  asked.catch(() => undefined);
  await vi.waitFor(async () => expect(await client.call('secrets.pending', {})).toHaveLength(1));
  await expect(client.call('secrets.answer', { threadId: request.threadId, requestId, value: 'synthetic-value', keep: true } as never)).rejects.toMatchObject({ code: RpcErrorCode.Refused, data: { field: 'keep', expected: false } });
  expect(await client.call('secrets.pending', {})).toHaveLength(1);
  expect(await client.call('secrets.list', { projectId: 'p-boite' })).toEqual({ secrets: [], storage: 'memory', encrypted: true });
  await client.call('secrets.answer', { threadId: request.threadId, requestId, value: 'synthetic-value', keep: false });
  expect(await asked).toMatchObject({ outcome: 'saved', storage: 'memory' });
  expect((await client.call('secrets.list', { projectId: 'p-boite' })).secrets).toEqual([]);
  await expect(client.call('secrets.delete', { projectId: 'p-boite', name: 'API_KEY' })).rejects.toMatchObject({ code: RpcErrorCode.NotFound });
});

test('an unencrypted session refuses values even when bypassing the field', async ({ createClient }) => {
  const client = await createClient({ delayMs: 0, plainLink: true, principal: 'session' });
  // Only the owner opens the synthetic agent request.
  client.becomes('owner');
  const asked = client.call('secrets.ask', { ...request, requestId: 'plain-answer' });
  asked.catch(() => undefined);
  await vi.waitFor(async () => expect(await client.call('secrets.pending', {})).toHaveLength(1));
  client.becomes('session');
  await expect(client.call('secrets.answer', { threadId: request.threadId, requestId: 'plain-answer', value: 'synthetic-value' })).rejects.toMatchObject({ code: RpcErrorCode.Refused, data: { field: 'connection' } });
  expect(await client.call('secrets.list', { threadId: request.threadId })).toEqual({ secrets: [], storage: 'memory', encrypted: false });
  await client.call('secrets.answer', { threadId: request.threadId, requestId: 'plain-answer', declined: true });
  expect((await asked).outcome).toBe('declined');
});

test('temporary refs belong to their thread and are consumed on the first attempt, even when the fake refuses execution', async ({ createClient }) => {
  const client = await createClient({ delayMs: 0 });
  const ref = await answer(client, 'single-use');
  await expect(client.call('secrets.use', { threadId: 't-bench', ref, use })).rejects.toMatchObject({ code: RpcErrorCode.NotFound });
  await expect(client.call('secrets.use', { threadId: request.threadId, ref, use })).rejects.toMatchObject({ code: RpcErrorCode.Refused });
  await expect(client.call('secrets.use', { threadId: request.threadId, ref, use })).rejects.toMatchObject({ code: RpcErrorCode.NotFound });
  await expect(client.call('secrets.use', { threadId: request.threadId, ref: 'secret:project/API_KEY', use })).rejects.toMatchObject({ code: RpcErrorCode.NotFound });
});

test.for(['expiry', 'turn', 'close'] as const)('temporary refs are unavailable after %s', async (closure, { createClient }) => {
  const client = await createClient({ delayMs: 0 });
  const ref = await answer(client, 'lifecycle');
  let clock: ReturnType<typeof vi.spyOn> | undefined;
  try {
    if (closure === 'expiry') {
      const later = Date.now() + SECRET_TRANSIT_TTL_MS + 1;
      clock = vi.spyOn(Date, 'now').mockReturnValue(later);
    } else if (closure === 'turn') {
      await client.call('turns.start', { threadId: request.threadId, prompt: 'Synthetic next turn.' });
      await client.settled();
    } else {
      client.close();
      await client.connect();
    }
    await expect(client.call('secrets.use', { threadId: request.threadId, ref, use })).rejects.toMatchObject({ code: RpcErrorCode.NotFound });
  } finally { clock?.mockRestore(); }
});

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { RpcErrorCode, type RpcParams } from '@boite/contracts';
import type { CoreClient } from '../src/client.ts';
import { startTestCore, type TestCore } from './harness.ts';
import { rejection } from './settle.ts';

let h: TestCore;
let choice: RpcParams<'threads.create'>;
beforeEach(async () => {
  h = await startTestCore({ settings: { warmProcessMinutes: 0 } });
  const client = await h.connect();
  const project = await client.call('projects.drafts', {});
  const account = (await client.call('accounts.list', {})).find(account => account.providerId === 'echo')!;
  choice = { projectId: project.id, providerId: 'echo', accountId: account.id, title: 'Queued while away' };
  client.close();
});
afterEach(async () => { await h.stop(); });

const titled = async (client: CoreClient, title: string) => (await client.call('threads.list', {})).filter(thread => thread.title === title);

test('a creation asked again under its request id, on a new connection, answers with the conversation it made', async () => {
  const first = await h.connect();
  const made = await first.call('threads.create', { ...choice, clientRequestId: 'req_queued_1' });
  // The answer was lost with the link: the device reconnects and asks again.
  first.close();
  const second = await h.connect();
  const again = await second.call('threads.create', { ...choice, clientRequestId: 'req_queued_1' });
  expect(again.id).toBe(made.id);
  expect(await titled(second, 'Queued while away')).toHaveLength(1);
  // No mode is the default mode, as the core stores it.
  const explicit = await second.call('threads.create', { ...choice, permissionMode: 'default', clientRequestId: 'req_queued_1' });
  expect(explicit.id).toBe(made.id);

  // Asked twice at once, it is still one conversation.
  const [a, b] = await Promise.all([
    second.call('threads.create', { ...choice, title: 'Twice at once', clientRequestId: 'req_queued_2' }),
    second.call('threads.create', { ...choice, title: 'Twice at once', clientRequestId: 'req_queued_2' })
  ]);
  expect(a.id).toBe(b.id);
  expect(await titled(second, 'Twice at once')).toHaveLength(1);

  // Without an id, or under a new one, every call makes its own.
  await second.call('threads.create', { ...choice, title: 'Plain' });
  await second.call('threads.create', { ...choice, title: 'Plain' });
  expect(await titled(second, 'Plain')).toHaveLength(2);
  second.close();
});

test('a request id names one conversation: reused for another it is refused, and a refused creation may try again', async () => {
  const client = await h.connect();
  await client.call('threads.create', { ...choice, clientRequestId: 'req_once' });
  const reused = await rejection(client.call('threads.create', { ...choice, title: 'Something else', clientRequestId: 'req_once' }));
  expect((reused.reason as { rpc: unknown }).rpc).toMatchObject({ code: RpcErrorCode.Refused, data: { field: 'clientRequestId' } });
  // Every parameter names the conversation, the mode and the effort included.
  const otherMode = await rejection(client.call('threads.create', { ...choice, permissionMode: 'bypassPermissions', clientRequestId: 'req_once' }));
  expect((otherMode.reason as { rpc: unknown }).rpc).toMatchObject({ code: RpcErrorCode.Refused, data: { field: 'clientRequestId' } });
  const otherEffort = await rejection(client.call('threads.create', { ...choice, effort: 'low', clientRequestId: 'req_once' }));
  expect((otherEffort.reason as { rpc: unknown }).rpc).toMatchObject({ code: RpcErrorCode.Refused, data: { field: 'clientRequestId' } });

  const missing = await rejection(client.call('threads.create', { ...choice, accountId: 'acc_missing', clientRequestId: 'req_retry' }));
  expect(missing.reason).toBeDefined();
  // Nothing was made under that id: the corrected call takes it.
  const retried = await client.call('threads.create', { ...choice, title: 'After a refusal', clientRequestId: 'req_retry' });
  expect(retried.title).toBe('After a refusal');

  const bad = await rejection(client.call('threads.create', { ...choice, clientRequestId: 'x'.repeat(129) }));
  expect((bad.reason as { rpc: unknown }).rpc).toMatchObject({ code: RpcErrorCode.InvalidParams, data: { field: 'clientRequestId' } });
  client.close();
});

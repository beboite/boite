import { afterEach, beforeEach, expect, test } from 'bun:test';
import { CONVERSATION_PROFILE_ID, RpcErrorCode } from '@boite/contracts';
import { echoThread, startTestCore, waitFor, type TestCore } from './harness.ts';

let harness: TestCore;
beforeEach(async () => { harness = await startTestCore(); });
afterEach(async () => { await harness.stop(); });

test('Done refuses an idle parent while a descendant is waiting and preserves the ordinary Archive action', async () => {
  const client = await harness.connect();
  const { threadId } = await echoThread(harness, client);
  const child = await client.call('delegation.spawn', { threadId, profileId: CONVERSATION_PROFILE_ID, task: '[permission]', requestId: 'done-child' });
  await waitFor(() => harness.core.threads.require(child.thread.id).status === 'waiting');
  expect(harness.core.threads.require(threadId).status).toBe('idle');
  const refusal = await client.call('threads.archive', { threadId, onlyIfIdle: true }).catch(error => error);
  expect(refusal).toMatchObject({ rpc: { code: RpcErrorCode.Refused, data: { threadId, activeThreadId: child.thread.id } } });
  expect(harness.core.threads.require(threadId).archived).toBe(false);
  expect(harness.core.threads.require(child.thread.id).status).toBe('waiting');
  expect((await client.call('threads.archive', { threadId })).archived).toBe(true);
  await waitFor(() => harness.core.threads.require(child.thread.id).status === 'idle');
});

test('a client that cannot name its drafts never blocks Done, while input it names on the thread does and says so', async () => {
  const client = await harness.connect();
  const { threadId } = await echoThread(harness, client);
  const other = await harness.connect();
  // The screenshot's case: one device reports drafts it cannot read, which used to protect every thread on the core.
  await other.call('threads.focus', { threadId: null, protectAllThreads: true });
  expect(harness.core.threads.focus.hasProtectedInput(threadId)).toBe(true);
  expect((await client.call('threads.archive', { threadId, onlyIfIdle: true })).archived).toBe(true);
  expect((await client.call('threads.archive', { threadId, archived: false })).archived).toBe(false);
  await other.call('threads.focus', { threadId: null, protectedThreadIds: [threadId], protectAllThreads: false });
  const refusal = await client.call('threads.archive', { threadId, onlyIfIdle: true }).catch(error => error);
  expect(refusal).toMatchObject({ rpc: { code: RpcErrorCode.Refused, message: 'threadId: unsent input is still open on a device; expected an idle conversation family', data: { activeThreadId: threadId } } });
  expect(harness.core.threads.require(threadId).archived).toBe(false);
});

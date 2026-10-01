import { afterEach, expect, test } from 'bun:test';
import { echoDriver } from '../src/drivers/echo.ts';
import { setDriver } from '../src/drivers/index.ts';
import { echoThread, startTestCore, waitFor, type TestCore } from './harness.ts';

let harness: TestCore | undefined;
let restore: (() => void) | undefined;
afterEach(async () => { await harness?.stop(); restore?.(); harness = undefined; restore = undefined; });

test('a side answer sees streamed context while the main turn waits, and never enters its transcript', async () => {
  harness = await startTestCore();
  const client = await harness.connect();
  const { threadId } = await echoThread(harness, client);
  let snapshot = '';
  restore = setDriver('echo', { ...echoDriver, sideQuestion: async ctx => { snapshot = ctx.prompt; return 'The file is config.ts.'; } });
  await client.call('turns.start', { threadId, prompt: 'Read config.ts [tool] [permission]' });
  await waitFor(() => harness!.core.threads.require(threadId).status === 'waiting');
  const before = await client.call('threads.get', { threadId });
  const answered = client.next('thread.btw', event => event.requestId === 'side_0001');
  expect(await client.call('threads.btw', { threadId, question: 'Which file?', requestId: 'side_0001' })).toEqual({ requestId: 'side_0001' });
  expect((await answered).answer).toBe('The file is config.ts.');
  expect(snapshot).toContain('Read config.ts');
  expect(snapshot).toContain('[fake_tool]');
  const after = await client.call('threads.get', { threadId });
  expect(after.messages).toEqual(before.messages);
  expect(after.turns).toEqual(before.turns);
  expect(after.status).toBe('waiting');
  expect(after.sessionId).toBe(before.sessionId);
  expect(await client.call('questions.list', { threadId })).toEqual([]);
});

test('duplicate side requests are refused and archive cancels only the side request', async () => {
  harness = await startTestCore();
  const client = await harness.connect();
  const { threadId } = await echoThread(harness, client);
  let signal: AbortSignal | undefined;
  restore = setDriver('echo', { ...echoDriver, sideQuestion: ctx => new Promise((_resolve, reject) => {
    signal = ctx.signal;
    signal.addEventListener('abort', () => reject(new Error('side request cancelled')), { once: true });
  }) });
  const pending = client.next('thread.btw', event => event.requestId === 'side_0001');
  await client.call('threads.subscribe', { threadId });
  await client.call('threads.btw', { threadId, question: 'A question', requestId: 'side_0001' });
  await waitFor(() => signal !== undefined);
  await expect(client.call('threads.btw', { threadId, question: 'Another question', requestId: 'side_0002' })).rejects.toThrow('already being answered');
  await client.call('threads.btw.cancel', { threadId, requestId: 'side_wrong' });
  expect(signal!.aborted).toBe(false);
  await expect(client.call('threads.btw.cancel', { threadId, requestId: '' })).rejects.toThrow('requestId');
  await client.call('threads.archive', { threadId });
  expect(signal!.aborted).toBe(true);
  expect((await pending).error).toBe('side request cancelled');
  await expect(client.call('threads.btw', { threadId, question: ' ', requestId: 'side_0003' })).rejects.toThrow('question');
  await expect(client.call('threads.btw', { threadId, question: 'Question', requestId: 'side_0004' })).rejects.toThrow('not archived');
});

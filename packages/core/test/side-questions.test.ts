import { afterEach, expect, test } from 'bun:test';
import { sideQuestionSnapshot, type Message } from '@boite/contracts';
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
  await client.call('turns.start', { threadId, prompt: 'Read config.ts [think] [image] [tool] [permission]' });
  await waitFor(() => harness!.core.threads.require(threadId).status === 'waiting');
  const before = await client.call('threads.get', { threadId });
  const answered = client.next('thread.btw', event => event.requestId === 'side_0001');
  expect(await client.call('threads.btw', { threadId, question: 'Which file?', requestId: 'side_0001' })).toEqual({ requestId: 'side_0001' });
  expect((await answered).answer).toBe('The file is config.ts.');
  expect(snapshot).toContain('Read config.ts');
  expect(snapshot).toContain('[fake_tool]');
  expect(snapshot).not.toContain('thinking about:');
  expect(snapshot).not.toContain('iVBOR');
  const after = await client.call('threads.get', { threadId });
  expect(after.messages).toEqual(before.messages);
  expect(after.turns).toEqual(before.turns);
  expect(after.status).toBe('waiting');
  expect(after.sessionId).toBe(before.sessionId);
  expect(await client.call('questions.list', { threadId })).toEqual([]);
  const fork = await client.call('threads.btw.fork', { threadId, requestId: 'side_0001' });
  const copied = await client.call('threads.get', { threadId: fork.id });
  expect(copied.messages.slice(-2).map(message => message.parts)).toEqual([
    [{ type: 'text', text: 'Which file?' }], [{ type: 'text', text: 'The file is config.ts.' }],
  ]);
  expect(copied.messages.every(message => message.state === 'complete')).toBe(true);
  expect(copied.messages.every(message => message.parts.every(part => part.type === 'text'))).toBe(true);
  expect(copied.turns.map(turn => turn.status)).toEqual(['stopped', 'done']);
  expect(copied.turns.every(turn => turn.usage === null && !turn.checkpoint)).toBe(true);
  expect(copied.sessionId).toBeNull();
  expect(copied.sessionGeneration).toBe(1);
  expect(copied.permissionMode).toBe(before.permissionMode);
  expect((await client.call('threads.get', { threadId })).messages).toEqual(before.messages);
  expect(harness.core.threads.require(threadId).status).toBe('waiting');
  await expect(client.call('threads.btw.fork', { threadId, requestId: 'side_0001' })).rejects.toThrow('available completed');

});

test('a retained side context bounds both large payloads and many tiny messages without mutating the journal', () => {
  const original: Message = { id: 'msg_long', threadId: 'thr_long', turnId: 'trn_long', role: 'user', state: 'complete', createdAt: 1, parts: [{ type: 'text', text: 'old'.repeat(100_000) + 'recent context' }] };
  const snapshot = sideQuestionSnapshot([original]);
  expect(JSON.stringify(snapshot)).not.toContain('old'.repeat(50_000));
  expect(JSON.stringify(snapshot)).toContain('recent context');
  expect(JSON.stringify(snapshot)).toContain('Earlier context was omitted');
  expect(original.parts).toEqual([{ type: 'text', text: 'old'.repeat(100_000) + 'recent context' }]);
  const many = sideQuestionSnapshot(Array.from({ length: 2_000 }, (_, i) => ({ ...original, id: `msg_${i}`, parts: [{ type: 'text' as const, text: `${i}` }] })));
  expect(many).toHaveLength(512);
  expect(many.at(-1)?.id).toBe('msg_1999');
});

test('a fork uses the request snapshot even when the source continues before its answer arrives', async () => {
  harness = await startTestCore();
  const client = await harness.connect();
  const { threadId } = await echoThread(harness, client);
  let finish!: (answer: string) => void;
  let continuation = '';
  restore = setDriver('echo', { ...echoDriver, sideQuestion: () => new Promise(resolve => { finish = resolve; }), startTurn(ctx) {
    continuation = ctx.prompt;
    return echoDriver.startTurn(ctx);
  } });
  const initial = await client.call('turns.start', { threadId, prompt: 'The file is config.ts' });
  await waitFor(() => harness!.core.journal.getTurn(initial.id)?.status === 'done');
  const answered = client.next('thread.btw', event => event.requestId === 'side_frozen');
  await client.call('threads.btw', { threadId, question: 'Which file?', requestId: 'side_frozen' });
  const later = await client.call('turns.start', { threadId, prompt: 'Later parent output' });
  await waitFor(() => harness!.core.journal.getTurn(later.id)?.status === 'done');
  finish('config.ts');
  await answered;
  const fork = await client.call('threads.btw.fork', { threadId, requestId: 'side_frozen' });
  const continued = await client.call('turns.start', { threadId: fork.id, prompt: 'Continue from this answer [tool]' });
  await waitFor(() => harness!.core.journal.getTurn(continued.id)?.status === 'done');
  expect(continuation).toContain('The file is config.ts');
  expect(continuation).toContain('Which file?');
  expect(continuation).toContain('config.ts');
  expect(continuation).not.toContain('Later parent output');
  expect((await client.call('threads.get', { threadId: fork.id })).messages.some(message => message.parts.some(part => part.type === 'tool'))).toBe(true);
  const second = client.next('thread.btw', event => event.requestId === 'side_dismiss');
  await client.call('threads.btw', { threadId, question: 'Discard this', requestId: 'side_dismiss' });
  finish('Discarded'); await second;
  await client.call('threads.btw.cancel', { threadId, requestId: 'side_dismiss' });
  await expect(client.call('threads.btw.fork', { threadId, requestId: 'side_dismiss' })).rejects.toThrow('available completed');
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

import { expect, test } from 'bun:test';
import { calls, claudeThread, harness, queries, scripted, success, useClaudeHarness } from './fixtures/claude-query.ts';

useClaudeHarness();

test('Claude side questions disable tools, settings and persistence and preserve the selected model', async () => {
  const client = await harness.connect();
  const threadId = await claudeThread(client);
  const before = await client.call('threads.get', { threadId });
  scripted(fake => { fake.emit(success('side-session')); fake.end(); });
  const answered = client.next('thread.btw', event => event.requestId === 'side_0001');
  expect(await client.call('threads.btw', { threadId, question: 'Which file?', requestId: 'side_0001' })).toEqual({ requestId: 'side_0001' });
  expect((await answered).answer).toBe('pong');
  const call = calls[0]!;
  expect(call.prompts[0]).toContain('<side-question>\nWhich file?');
  expect(call.options).toMatchObject({ tools: [], allowedTools: [], mcpServers: {}, settingSources: [], persistSession: false, maxTurns: 1 });
  expect(call.options.model ?? null).toBe(before.model);
  expect(call.options.resume).toBeUndefined();
  expect(queries[0]!.closes).toBe(1);
  expect(await client.call('threads.get', { threadId })).toEqual(before);
});

test('a side query runs beside a live Claude query without closing or interrupting it', async () => {
  const client = await harness.connect();
  const threadId = await claudeThread(client);
  scripted((fake, options) => {
    if (options.persistSession === false) { fake.emit(success('side-session')); fake.end(); }
  });
  await client.call('turns.start', { threadId, prompt: 'Keep working' });
  const { waitFor } = await import('./harness.ts');
  await waitFor(() => queries.length === 1 && calls[0]!.prompts.length === 1);
  const main = queries[0]!;
  const answered = client.next('thread.btw', event => event.requestId === 'side_live');
  await client.call('threads.btw', { threadId, question: 'A question beside the work', requestId: 'side_live' });
  expect((await answered).answer).toBe('pong');
  expect(queries).toHaveLength(2);
  expect(main.interrupts).toBe(0);
  expect(main.closes).toBe(0);
  expect(harness.core.threads.require(threadId).status).toBe('running');
  const finished = client.next('turn.finished', turn => turn.threadId === threadId);
  main.emit(success('main-session'));
  expect((await finished).status).toBe('done');
});

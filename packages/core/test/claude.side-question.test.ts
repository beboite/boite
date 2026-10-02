import { expect, test } from 'bun:test';
import { assistant, calls, claudeThread, harness, init, queries, scripted, streamEvent, success, toolResult, useClaudeHarness } from './fixtures/claude-query.ts';

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
  main.emit(init('main-session'));
  main.emit(assistant('main-session', [{ type: 'tool_use', id: 'tool_read', name: 'Read', input: { file_path: 'config-latest.ts' } }]));
  main.emit(toolResult('main-session', 'tool_read', 'The latest configuration has featureEnabled=true.'));
  main.emit(streamEvent('main-session', { type: 'message_start', message: { id: 'msg_recent' } }));
  main.emit(streamEvent('main-session', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tool_latest', name: 'Bash', input: {} } }));
  main.emit(streamEvent('main-session', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":"inspect latest-tool-marker' } }));
  main.emit(streamEvent('main-session', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }));
  main.emit(streamEvent('main-session', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'fresh assistant context marker' } }));
  await waitFor(() => [...harness.core.journal.walkMessages(threadId)].some(message => message.parts.some(part => part.type === 'tool' && part.inputText?.includes('latest-tool-marker'))));
  const answered = client.next('thread.btw', event => event.requestId === 'side_live');
  await client.call('threads.btw', { threadId, question: 'A question beside the work', requestId: 'side_live' });
  expect((await answered).answer).toBe('pong');
  await waitFor(() => calls[1]!.prompts.length === 1);
  const firstSnapshot = calls[1]!.prompts[0]!;
  expect(firstSnapshot).toContain('config-latest.ts');
  expect(firstSnapshot).toContain('The latest configuration has featureEnabled=true.');
  expect(firstSnapshot).toContain('{"command":"inspect latest-tool-marker');
  expect(firstSnapshot).toContain('fresh assistant context marker');
  expect(queries).toHaveLength(2);
  expect(main.interrupts).toBe(0);
  expect(main.closes).toBe(0);
  expect(harness.core.threads.require(threadId).status).toBe('running');
  main.emit(assistant('main-session', [{ type: 'tool_use', id: 'tool_latest', name: 'Bash', input: { command: 'inspect latest-tool-marker' } }]));
  main.emit(toolResult('main-session', 'tool_latest', 'latest tool result: verification passed'));
  await waitFor(() => [...harness.core.journal.walkMessages(threadId)].some(message => message.parts.some(part => part.type === 'tool' && part.output === 'latest tool result: verification passed')));
  const latestAnswer = client.next('thread.btw', event => event.requestId === 'side_latest');
  await client.call('threads.btw', { threadId, question: 'What did the last tool find?', requestId: 'side_latest' });
  await latestAnswer;
  await waitFor(() => calls[2]!.prompts.length === 1);
  expect(calls[2]!.prompts[0]).toContain('"command":"inspect latest-tool-marker"');
  expect(calls[2]!.prompts[0]).toContain('latest tool result: verification passed');
  expect(firstSnapshot).not.toContain('latest tool result: verification passed');
  expect(main.interrupts).toBe(0);
  expect(main.closes).toBe(0);
  const finished = client.next('turn.finished', turn => turn.threadId === threadId);
  main.emit(success('main-session'));
  expect((await finished).status).toBe('done');
});

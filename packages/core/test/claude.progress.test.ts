import { expect, test } from 'bun:test';
import { waitFor } from './harness.ts';
import { claudeThread, harness, init, queries, scripted, sdk, success, useClaudeHarness } from './fixtures/claude-query.ts';

useClaudeHarness();

test('a silent Claude compaction is observable before the turn answers', async () => {
  const client = await harness.connect();
  const threadId = await claudeThread(client);
  scripted(fake => {
    fake.emit(init('sess-progress'));
    fake.emit(sdk({ type: 'system', subtype: 'status', status: 'compacting', session_id: 'sess-progress' }));
  });
  const finished = client.next('turn.finished', turn => turn.threadId === threadId);
  const turn = await client.call('turns.start', { threadId, prompt: 'inspect' });
  await waitFor(() => queries.length > 0);
  await Bun.sleep(20);
  const thread = await client.call('threads.get', { threadId });
  expect(thread.progress).toMatchObject({ turnId: turn.id, phase: 'compacting', detail: null });
  expect(thread.messages.filter(message => message.role === 'assistant')).toHaveLength(0);
  queries[0]!.emit(success('sess-progress'));
  await finished;
  expect((await client.call('threads.get', { threadId })).progress).toBeNull();
});

test('provider retries and child task summaries survive reconnect without leaking child text or stale turns', async () => {
  const client = await harness.connect();
  const threadId = await claudeThread(client);
  scripted(fake => fake.emit(init('sess-live')));
  let finished = client.next('turn.finished', turn => turn.threadId === threadId);
  const first = await client.call('turns.start', { threadId, prompt: 'work' });
  await waitFor(() => queries.length > 0);
  const fake = queries[0]!;
  const stages = [
    { message: { type: 'system', subtype: 'status', status: 'requesting' }, phase: 'working', detail: null },
    { message: { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 8, estimated_tokens_delta: 8 }, phase: 'thinking', detail: null },
    { message: { type: 'system', subtype: 'api_retry', attempt: 2, max_retries: 5, retry_delay_ms: 1000, error_status: 529, error: 'server_error' }, phase: 'retrying', detail: '2/5' },
    { message: { type: 'tool_progress', tool_use_id: 'copy', tool_name: 'Bash', parent_tool_use_id: null, elapsed_time_seconds: 5 }, phase: 'tool', detail: 'Bash' },
    { message: { type: 'system', subtype: 'task_progress', task_id: 'child', description: 'Private child', summary: 'Copying archive', last_tool_name: 'Bash', usage: { total_tokens: 1, tool_uses: 1, duration_ms: 1000 } }, phase: 'tool', detail: 'Copying archive' },
  ] as const;
  for (const stage of stages) {
    const update = client.next('thread.updated', thread => thread.id === threadId && thread.progress?.phase === stage.phase && thread.progress.detail === stage.detail);
    fake.emit(sdk({ ...stage.message, uuid: 'progress', session_id: 'sess-live' }));
    expect((await update).progress).toMatchObject({ turnId: first.id, phase: stage.phase, detail: stage.detail, at: expect.any(Number) });
  }
  const reopened = await harness.connect();
  const snapshot = await reopened.call('threads.get', { threadId });
  expect(snapshot.progress).toMatchObject({ turnId: first.id, detail: 'Copying archive' });
  expect(snapshot.messages.filter(message => message.role === 'assistant')).toHaveLength(0);
  const at = snapshot.progress!.at;
  await Bun.sleep(1100);
  expect((await reopened.call('threads.get', { threadId })).progress?.at).toBe(at);
  fake.emit(success('sess-live'));
  await finished;
  expect((await reopened.call('threads.get', { threadId })).progress).toBeNull();

  finished = client.next('turn.finished', turn => turn.threadId === threadId);
  const second = await client.call('turns.start', { threadId, prompt: 'next' });
  await waitFor(() => harness.core.threads.progress.get(threadId)?.turnId === second.id);
  harness.core.threads.progress.report(threadId, first.id, 'retrying', 'late old callback');
  expect((await reopened.call('threads.get', { threadId })).progress).toMatchObject({ turnId: second.id, phase: 'starting', detail: null });
  await waitFor(() => queries.length > 1);
  queries.at(-1)!.emit(success('sess-live'));
  await finished;
});

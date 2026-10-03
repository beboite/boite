import { expect, spyOn, test } from 'bun:test';
import { Core } from '../src/core.ts';
import { getDriver } from '../src/drivers/index.ts';
import { answerEach, claudeThread, harness, init, queries, runTurn, scripted, sdk, useClaudeHarness } from './fixtures/claude-query.ts';

useClaudeHarness();

function launch(sessionId: string) {
  scripted(fake => {
    fake.emit(init(sessionId));
    fake.emit(sdk({ type: 'system', subtype: 'task_started', session_id: sessionId, task_id: 'native-1', tool_use_id: 'tool-bg', description: 'background task', task_type: 'local_bash', is_backgrounded: true }));
    fake.emit(sdk({ type: 'system', subtype: 'background_tasks_changed', session_id: sessionId, tasks: [{ task_id: 'native-1', task_type: 'local_bash', description: 'background task' }] }));
  }, answerEach(sessionId));
}

test.each([['completed', 'completed'], ['failed', 'error'], ['stopped', 'cancelled']] as const)('SDK task %s persists its original owner as %s after root and later turn finish', async (status, state) => {
  const client = await harness.connect();
  const threadId = await claudeThread(client);
  const sessionId = `sess-task-${status}`;
  launch(sessionId);
  expect(await runTurn(client, threadId, 'start background work')).toBe('done');
  const origin = harness.core.journal.listTurns(threadId)[0]!;
  let history = (await client.call('threads.get', { threadId })).backgroundHistory!;
  expect(history).toMatchObject([{ id: 'native-1', state: 'running', parentTurnId: origin.id }]);
  expect(await runTurn(client, threadId, 'another root')).toBe('done');
  const terminal = client.next('thread.background', event => event.threadId === threadId && event.history?.some(task => task.state === state) === true);
  queries[0]!.emit(sdk({ type: 'system', subtype: 'background_tasks_changed', session_id: sessionId, tasks: [] }));
  queries[0]!.emit(sdk({ type: 'system', subtype: 'task_notification', session_id: sessionId, task_id: 'native-1', tool_use_id: 'tool-bg', status, output_file: '', summary: 'terminal outcome' }));
  await terminal;
  history = (await client.call('threads.get', { threadId })).backgroundHistory!;
  expect(history).toMatchObject([{ id: 'native-1', state, parentTurnId: origin.id, reason: 'provider-reported' }]);
  const restarted = new Core({ dataDir: harness.dataDir, token: harness.token });
  try { expect(restarted.threads.get(threadId).backgroundHistory).toEqual(history); }
  finally { await restarted.close(); }
});

test('intentional release cancels native work and captured stale callbacks cannot revive it', async () => {
  const client = await harness.connect();
  const threadId = await claudeThread(client);
  launch('sess-stale-background');
  const driver = spyOn(getDriver('claude-sdk'), 'startTurn');
  try {
    expect(await runTurn(client, threadId, 'start background')).toBe('done');
    const context = driver.mock.calls[0]![0];
    const accounts = await client.call('accounts.list', {});
    await client.call('threads.update', { threadId, accountId: accounts.find(account => account.providerId === 'echo')!.id });
    context.background?.([{ id: 'ghost', kind: 'shell', description: 'late task', toolId: null, startedAt: Date.now() }]);
    context.backgroundFinished?.('native-1', 'completed');
    const snapshot = await client.call('threads.get', { threadId });
    expect(snapshot.background).toEqual([]);
    expect(snapshot.backgroundHistory).toMatchObject([{ id: 'native-1', state: 'cancelled', reason: 'session-ended' }]);
  } finally { driver.mockRestore(); }
});

test('core recovery cancels live observations without native replay', async () => {
  const client = await harness.connect();
  const threadId = await claudeThread(client);
  launch('sess-restart-background');
  expect(await runTurn(client, threadId, 'start background')).toBe('done');
  const restarted = new Core({ dataDir: harness.dataDir, token: harness.token });
  try {
    expect(restarted.threads.get(threadId).backgroundHistory).toMatchObject([{ id: 'native-1', state: 'cancelled', reason: 'core-restarted' }]);
    expect(restarted.scheduler.state().running).toEqual([]);
  } finally { await restarted.close(); }
});


test('normal core shutdown records cancellation rather than unknown disappearance', async () => {
  const client = await harness.connect();
  const threadId = await claudeThread(client);
  launch('sess-shutdown-background');
  expect(await runTurn(client, threadId, 'start background')).toBe('done');
  await harness.core.close();
  const restarted = new Core({ dataDir: harness.dataDir, token: harness.token });
  try {
    expect(restarted.threads.get(threadId).backgroundHistory).toMatchObject([{ id: 'native-1', state: 'cancelled', reason: 'session-ended' }]);
  } finally { await restarted.close(); }
});

test('a late notification for a reused native id finishes its original turn without removing newer live work', async () => {
  const client = await harness.connect();
  const threadId = await claudeThread(client);
  await client.call('settings.set', { warmProcessMinutes: 5 });
  const sessionId = 'sess-reused-native';
  launch(sessionId);
  expect(await runTurn(client, threadId, 'original task')).toBe('done');
  const original = harness.core.journal.listTurns(threadId)[0]!;
  queries[0]!.emit(sdk({ type: 'system', subtype: 'background_tasks_changed', session_id: sessionId, tasks: [] }));
  expect(await runTurn(client, threadId, 'new task')).toBe('done');
  const newer = harness.core.journal.listTurns(threadId).find(turn => turn.id !== original.id)!;
  queries[0]!.emit(sdk({ type: 'system', subtype: 'task_started', session_id: sessionId, task_id: 'native-1', tool_use_id: 'tool-new', description: 'new task', task_type: 'local_bash', is_backgrounded: true }));
  queries[0]!.emit(sdk({ type: 'system', subtype: 'background_tasks_changed', session_id: sessionId, tasks: [{ task_id: 'native-1', task_type: 'local_bash', description: 'new task' }] }));
  const terminal = client.next('thread.background', event => event.history?.some(task => task.parentTurnId === original.id && task.state === 'completed') === true);
  queries[0]!.emit(sdk({ type: 'system', subtype: 'task_notification', session_id: sessionId, task_id: 'native-1', tool_use_id: 'tool-bg', status: 'completed', output_file: '', summary: 'old task finished' }));
  await terminal;
  const snapshot = await client.call('threads.get', { threadId });
  expect(snapshot.background).toHaveLength(1);
  expect(snapshot.backgroundHistory?.find(task => task.parentTurnId === newer.id)).toMatchObject({ state: 'running' });
});

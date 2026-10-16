import { afterEach, expect, test } from 'bun:test';
import { CAPACITY_RETRY } from '../src/threads/turn-attempts.ts';
import { waitFor } from './harness.ts';
import { assistant, claudeThread, harness, init, runTurn, scripted, sdk, success, useClaudeHarness } from './fixtures/claude-query.ts';

useClaudeHarness();

const delays = CAPACITY_RETRY.delaysMs;
afterEach(() => { CAPACITY_RETRY.delaysMs = delays; });

/** What the CLI writes when an API error ends the turn: the coded assistant message, then an error result. */
function apiError(sessionId: string, error: string, text: string) {
  return [
    sdk({ type: 'assistant', session_id: sessionId, parent_tool_use_id: null, error, message: { id: 'msg_err', role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text }] } }),
    sdk({ ...(success(sessionId) as object), is_error: true, result: text }),
  ];
}

test('an overloaded_error ends the try and the same turn answers on the next one', async () => {
  CAPACITY_RETRY.delaysMs = [20, 20, 20];
  const client = await harness.connect();
  const threadId = await claudeThread(client);
  let prompts = 0;
  scripted(() => {}, (fake) => {
    prompts += 1;
    fake.emit(init('sess-529'));
    if (prompts === 1) for (const message of apiError('sess-529', 'overloaded', 'API Error: 529 Overloaded')) fake.emit(message);
    else {
      fake.emit(assistant('sess-529', [{ type: 'text', text: 'answered' }]));
      fake.emit(success('sess-529'));
    }
  });
  expect(await runTurn(client, threadId, 'hello')).toBe('done');
  expect(prompts).toBe(2);
  const thread = await client.call('threads.get', { threadId });
  expect(thread.turns).toHaveLength(1);
  expect(JSON.stringify(thread.messages)).toContain('answered');
});

test('a rejected window before a rate_limit error plans the resume at that window reset', async () => {
  harness.core.settings.set({ autoResumeLimitedThreads: true });
  const client = await harness.connect();
  const threadId = await claudeThread(client);
  const resetsAt = Math.floor(Date.now() / 1000) + 3 * 3600;
  scripted(() => {}, (fake) => {
    fake.emit(init('sess-limit'));
    fake.emit(sdk({ type: 'rate_limit_event', session_id: 'sess-limit', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt } }));
    for (const message of apiError('sess-limit', 'rate_limit', "You've hit your limit")) fake.emit(message);
  });
  expect(await runTurn(client, threadId, 'hello')).toBe('error');
  await waitFor(() => harness.core.threads.list({}).find(thread => thread.id === threadId)?.retry?.resetsAt === resetsAt * 1000);
  expect(await client.call('turns.cancelRetry', { threadId })).toEqual({ cancelled: true });
});

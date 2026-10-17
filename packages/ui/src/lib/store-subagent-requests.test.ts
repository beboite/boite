import { expect, vi } from 'vitest';
import { test } from '../test/fake-client';
import { threadState } from './thread-state';

test('opening a parent keeps and reads what its sub-agents ask, and reads a child as it turns to the user', async ({ ready }) => {
  const { store, client } = await ready({ delayMs: 0, subagentsDemo: true });
  const row = (id: string) => store.threads.find(thread => thread.id === id)!;
  // One parent's children only work, the other's ask: that one reads Needs you while its own turn runs.
  expect(store.subagents('t-subagents-work')).toMatchObject({ count: 2, asking: 0 });
  expect(store.subagents('t-subagents-ask')).toMatchObject({ count: 2, asking: 2 });
  expect(threadState(row('t-subagents-ask'), store.subagents('t-subagents-ask'))).toBe('waiting');
  expect(threadState(row('t-subagents-work'), store.subagents('t-subagents-work'))).toBe('working');

  const calls = vi.spyOn(client, 'call');
  const read = (method: string, threadId: string) => calls.mock.calls.some(([name, params]) => name === method && (params as { threadId?: string }).threadId === threadId);
  await store.open('t-subagents-ask');
  await vi.waitFor(() => expect(read('questions.list', 't-subagents-ask-1') && read('permissions.list', 't-subagents-ask-2')).toBe(true));
  // The records the cards read hold the children's beside the parent's.
  await vi.waitFor(() => expect(Object.values(store.questionRequests).map(question => question.threadId)).toContain('t-subagents-ask-1'));
  expect(Object.values(store.permissionRequests).map(request => request.threadId)).toContain('t-subagents-ask-2');

  await store.open('t-subagents-work');
  calls.mockClear();
  // A working child asks without stopping: its row turns to the user, and that child alone is read.
  await client.call('questions.ask', { threadId: 't-subagents-work-1', text: 'Keep the old part as a shim?', options: ['Yes', 'No'] });
  await vi.waitFor(() => expect(read('questions.list', 't-subagents-work-1')).toBe(true));
  expect(read('questions.list', 't-subagents-work-2')).toBe(false);
  expect(store.subagents('t-subagents-work')).toMatchObject({ count: 2, asking: 1 });
  expect(store.pendingQuestions.some(question => question.threadId === 't-subagents-work-1')).toBe(true);
});

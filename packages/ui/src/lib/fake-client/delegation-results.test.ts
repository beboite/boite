import { expect, vi } from 'vitest';
import { test } from '../../test/fake-client';
import { CONVERSATION_PROFILE_ID, DEFAULT_DELEGATION_CONFIG, RpcErrorCode } from '@boite/contracts';
import { FakeContext } from './context';
import { seed } from './seed';
import { delegationMethods } from './delegation';

test('fake individual and team waits settle after a child fails before its first turn', async () => {
  const ctx = new FakeContext({ delayMs: 0 });
  seed(ctx);
  const methods = delegationMethods(ctx);
  const threadId = 't-trace';
  const start = vi.spyOn(ctx, 'startTurn').mockImplementation(() => { throw new Error('fixture startup refused'); });
  try {
    await expect(methods['delegation.spawn']({ threadId, profileId: CONVERSATION_PROFILE_ID, task: 'Inspect source', requestId: 'failed-start' })).rejects.toThrow('fixture startup refused');
    const view = await methods['delegation.get']({ threadId });
    expect(view.settlement).toBe('settled');
    expect(view.agents).toHaveLength(1);
    const child = view.agents[0]!;
    expect(child.lastTurn).toBeNull();
    for (const agentId of [child.thread.id, undefined]) {
      expect(await methods['delegation.wait']({ threadId, agentId, timeoutMs: 0 })).toMatchObject({ state: 'settled', timedOut: false, agents: [child] });
    }
  } finally { start.mockRestore(); }
});

test('fake waits and bounded result pages preserve one automatic result and paired read scope', async ({ createClient }) => {
  const client = await createClient({ delayMs: 0 });
  await client.call('delegation.configure', { threadId: 't-trace', config: { ...DEFAULT_DELEGATION_CONFIG, enabled: true, profiles: [{ id: 'echo', name: 'Echo', providerId: 'echo', accountId: 'a-echo', model: 'echo-1', effort: null }] } });
  const task = 'x'.repeat(9000);
  const child = await client.call('delegation.spawn', { threadId: 't-trace', profileId: 'echo', task, requestId: 'result-child' });
  const params = { threadId: 't-trace', agentId: child.thread.id, timeoutMs: 5000 };
  const [first, second] = await Promise.all([client.call('delegation.wait', params), client.call('delegation.wait', params)]);
  expect(first.state).toBe('result_available');
  expect(second.agents[0]!.resultRef).toEqual(first.agents[0]!.resultRef);
  const ref = first.agents[0]!.resultRef!;
  client.becomes('session');
  let full = '', offset = 0;
  for (;;) {
    const page = await client.call('delegation.result', { threadId: 't-trace', ...ref, offset, limit: 2000 });
    expect(page.text.length).toBeLessThanOrEqual(2000);
    full += page.text;
    if (page.nextOffset === null) break;
    offset = page.nextOffset;
  }
  expect(full).toContain(task);
  const view = await client.call('delegation.get', { threadId: 't-trace' });
  expect(view.messages.filter(letter => letter.origin === 'result')).toHaveLength(1);
  expect((await client.call('delegation.wait', params)).agents[0]!.resultRef).toEqual(ref);
  await expect(client.call('delegation.result', { threadId: 't-scheduler', ...ref })).rejects.toMatchObject({ code: RpcErrorCode.Refused });
});

test('fake wait timeout leaves accepted child work active', async ({ createClient }) => {
  const client = await createClient({ delayMs: 2 });
  await client.call('delegation.configure', { threadId: 't-trace', config: { ...DEFAULT_DELEGATION_CONFIG, enabled: true, profiles: [{ id: 'echo', name: 'Echo', providerId: 'echo', accountId: 'a-echo', model: 'echo-1', effort: null }] } });
  const child = await client.call('delegation.spawn', { threadId: 't-trace', profileId: 'echo', task: '[permission] Review access', requestId: 'wait-child' });
  const result = await client.call('delegation.wait', { threadId: 't-trace', agentId: child.thread.id, timeoutMs: 0 });
  expect(result).toMatchObject({ state: 'waiting_for_children', timedOut: true });
  const snapshot = await client.call('threads.get', { threadId: child.thread.id });
  expect(snapshot.turns.at(-1)!.status).toBe('running');
});

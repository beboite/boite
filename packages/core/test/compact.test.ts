import { afterEach, beforeEach, expect, test } from 'bun:test';
import { echoThread, startTestCore, type TestCore } from './harness.ts';
let h: TestCore;
beforeEach(async () => { h = await startTestCore(); });
afterEach(async () => { await h.stop(); });
test('compaction rejects missing sessions and stale selections, and preserves history on success', async () => {
  const client = await h.connect();
  const { threadId } = await echoThread(h, client);
  const refusal = async () => { try { await client.call('threads.compact', { threadId, expectedSelectionVersion: 0 }); return ''; } catch (e) { return String(e); } };
  expect(await refusal()).toContain('no native session');
  let done = client.next('turn.finished', (t) => t.threadId === threadId);
  await client.call('turns.start', { threadId, prompt: 'remember this' }); await done;
  const before = await client.call('threads.get', { threadId });
  done = client.next('turn.finished', (t) => t.threadId === threadId);
  await client.call('threads.compact', { threadId });
  expect((await done).status).toBe('done');
  const after = await client.call('threads.get', { threadId });
  expect(after.messages[0]).toEqual(before.messages[0]);
  expect(after.sessionId).toBe(before.sessionId);
  expect(after.messages.flatMap(m => m.parts).some(p => p.type === 'compaction')).toBe(true);
  await client.call('threads.update', { threadId, effort: 'low' });
  expect(await refusal()).toContain('selection changed');
  done = client.next('turn.finished', (t) => t.threadId === threadId);
  await client.call('turns.start', { threadId, prompt: '[sleep:200]' });
  try { await client.call('threads.compact', { threadId }); throw new Error('accepted a busy session'); }
  catch (e) { expect(String(e)).toContain('in-flight'); }
  await done; client.close();
});

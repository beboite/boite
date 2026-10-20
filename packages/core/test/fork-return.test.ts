import { inspectJournal } from '../src/journal/integrity.ts';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Core } from '../src/core.ts';
import { connect, type CoreClient } from '../src/client.ts';
import { echoThread, startTestCore, type TestCore } from './harness.ts';
import { thrown } from './settle.ts';
let h: TestCore;
let client: CoreClient;
beforeEach(async () => { h = await startTestCore(); client = await h.connect(); });
afterEach(async () => { await h.stop(); });
async function fork() {
  const { threadId } = await echoThread(h, client, 'Source');
  const done = client.next('turn.finished', turn => turn.threadId === threadId);
  await client.call('turns.start', { threadId, prompt: 'Investigate' }); await done;
  const message = h.core.threads.get(threadId).messages.at(-1)!;
  const child = await client.call('threads.fork', { threadId, messageId: message.id });
  h.core.coordination.configure(threadId, { mode: 'brief', resources: '', remote: false, paused: true });
  expect(inspectJournal(h.core.journal, { limit: 500 }).issues).toEqual([]);
  return { source: threadId, child, message };
}
test('seeded provenance and idempotent returned conclusions survive a core restart', async () => {
  const { source, child, message } = await fork();
  expect(child.forkOrigin).toEqual({ threadId: source, messageId: message.id, turnId: message.turnId, mode: 'seeded' });
  const params = { threadId: child.id, summary: 'Parser checked. Keep the current strategy.', requestId: 'return-1' };
  const letter = await client.call('threads.mergeBack', params);
  expect(letter.to.threadId).toBe(source); expect(letter.from.threadId).toBe(child.id);
  expect((await client.call('threads.mergeBack', params)).id).toBe(letter.id);
  expect(await thrown(client.call('threads.mergeBack', { ...params, summary: 'Different conclusion' }))).toThrow('different content');
  expect(h.core.coordination.get(source).messages.filter(item => item.id === letter.id)).toHaveLength(1);
  await h.server.stop(); await h.core.close();
  const reopened = new Core({ dataDir: h.dataDir, token: h.token });
  try {
    expect(reopened.threads.require(child.id).forkOrigin).toEqual(child.forkOrigin);
    expect((await reopened.threads.branching.mergeBack(params)).id).toBe(letter.id);
    expect(await thrown(reopened.threads.branching.mergeBack({ ...params, summary: 'Changed after restart' }))).toThrow('different content');
    expect(reopened.coordination.get(source).messages.filter(item => item.id === letter.id)).toHaveLength(1);
    expect(reopened.journal.listTurns(source)).toHaveLength(1);
    expect(inspectJournal(reopened.journal, { limit: 500 }).issues).toEqual([]);
  } finally { await reopened.close(); }
});
test('only an authenticated fork may return to its actual origin under collaboration policy', async () => {
  const { source, child } = await fork();
  const unrelated = (await echoThread(h, client, 'Unrelated')).threadId;
  expect(await thrown(client.call('threads.mergeBack', { threadId: unrelated, summary: 'Summary', requestId: 'one' }))).toThrow('fork');
  const agent = await connect(h.url, h.core.agents.tokenFor(child.id));
  try {
    expect(await thrown(agent.call('threads.mergeBack', { threadId: unrelated, summary: 'Summary', requestId: 'two' }))).toThrow('not thread');
    const letter = await agent.call('threads.mergeBack', { threadId: child.id, summary: 'Checked', requestId: 'agent-return' });
    expect(letter.to.threadId).toBe(source);
    h.core.coordination.configure(source, { mode: 'off', resources: '', remote: false, paused: false });
    expect(await thrown(agent.call('threads.mergeBack', { threadId: child.id, summary: 'More', requestId: 'three' }))).toThrow('coordination');
  } finally { agent.close(); }
});
test('archived or deleted source refuses cleanly, summary is bounded, and child is not a delegated agent', async () => {
  const { source, child } = await fork();
  expect(child.parentThreadId).toBeUndefined();
  expect(await thrown(client.call('threads.mergeBack', { threadId: child.id, summary: 'x'.repeat(4001), requestId: 'too-long' }))).toThrow('4000');
  h.core.journal.putThread({ ...h.core.threads.require(source), archived: true });
  expect(await thrown(client.call('threads.mergeBack', { threadId: child.id, summary: 'Checked', requestId: 'archived' }))).toThrow('archived');
  h.core.journal.deleteThreads([source]);
  expect(await thrown(client.call('threads.mergeBack', { threadId: child.id, summary: 'Checked', requestId: 'deleted' }))).toThrow('source');
  expect(h.core.coordination.get(child.id).messages).toHaveLength(0);
  expect(inspectJournal(h.core.journal, { limit: 500 }).issues).toEqual([]);
});

test('paired owners can return conclusions and cross-project restrictions remain intact', async () => {
  const { source, child } = await fork();
  const grant = await client.call('pairing.grant', {});
  const phone = await connect(h.url, '', { grant: grant.grant });
  try {
    const letter = await phone.call('threads.mergeBack', { threadId: child.id, summary: 'Checked from phone', requestId: 'phone-return' });
    expect(letter.to.threadId).toBe(source);
    // Project reassignment keeps the origin immutable and must still satisfy current scope policy.
    h.core.journal.putThread({ ...h.core.threads.require(child.id), projectId: null });
    h.core.coordination.configure(child.id, { mode: 'brief', resources: '', remote: false, paused: false });
    expect(await thrown(phone.call('threads.mergeBack', { threadId: child.id, summary: 'Moved conclusion', requestId: 'cross-project' }))).toThrow('across projects');
    expect(h.core.coordination.get(source).messages).toHaveLength(1);
  } finally { phone.close(); }
});
test('a side answer fork records its source snapshot and seeded mode', async () => {
  const { source } = await fork();
  const snapshot = h.core.threads.get(source);
  const side = h.core.threads.branching.forkSnapshot(h.core.threads.require(source), snapshot.messages, snapshot.turns, 'Question', 'Answer');
  const last = snapshot.messages.at(-1)!;
  expect(side.forkOrigin).toEqual({ threadId: source, messageId: last.id, turnId: last.turnId, mode: 'seeded' });
});

test('soft deletion preserves valid fork projections without false missing owners', async () => {
  const { source } = await fork();
  h.core.journal.stageThreadDeletion(source, [h.core.threads.require(source)]);
  expect(h.core.journal.getThread(source)).toBeNull();
  expect(inspectJournal(h.core.journal, { limit: 500 }).issues).toEqual([]);
});

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_DELEGATION_CONFIG } from '@boite/contracts';
import type { CoreClient } from '../src/client.ts';
import { connect } from '../src/client.ts';
import { echoThread, startTestCore, waitFor, type TestCore } from './harness.ts';

let harness: TestCore;
let client: CoreClient;
beforeEach(async () => { harness = await startTestCore(); client = await harness.connect(); });
afterEach(async () => { await harness.stop(); });

test('removal stops the family and clears its stored history while keeping project files', async () => {
  const { threadId } = await echoThread(harness, client);
  const { threadId: keptId } = await echoThread(harness, client, 'keep');
  const parent = harness.core.threads.require(threadId);
  const marker = join(parent.cwd, 'keep.txt');
  writeFileSync(marker, 'project file');
  await client.call('delegation.configure', { threadId, config: { ...DEFAULT_DELEGATION_CONFIG, enabled: true, profiles: [{ id: 'worker', name: 'Worker', providerId: parent.providerId, accountId: parent.accountId, model: parent.model!, effort: null }] } });
  const child = await client.call('delegation.spawn', { threadId, profileId: 'worker', task: 'long running '.repeat(500), requestId: 'remove-child' });
  const childId = child.thread.id;
  const turns = [await client.call('turns.start', { threadId, prompt: 'long running '.repeat(500) })];
  const { questionId } = await client.call('questions.ask', { threadId, text: 'Pending question', options: ['Yes', 'No'] });
  for (const id of [threadId, childId]) {
    harness.core.journal.setSetting(`move-note:${id}`, { text: 'old move' });
    harness.core.journal.setSetting(`memory-notices:${id}`, [{ text: 'old notice' }]);
  }
  const removed: string[] = [];
  client.on('thread.removed', event => removed.push(event.threadId));
  await client.call('threads.remove', { threadId });
  await waitFor(() => removed.length === 2);
  expect(removed.sort()).toEqual([threadId, childId].sort());
  expect(harness.core.scheduler.state()).toEqual({ running: [], queued: [] });
  expect((await client.call('questions.list', {})).some(q => q.id === questionId)).toBe(false);
  for (const id of [threadId, childId]) {
    expect(harness.core.journal.getThread(id)).toBeNull();
    expect(harness.core.journal.listMessages(id)).toEqual([]);
    expect(harness.core.journal.listTurns(id)).toEqual([]);
    expect(harness.core.journal.getSetting(`move-note:${id}`)).toBeUndefined();
    expect(harness.core.journal.getSetting(`memory-notices:${id}`)).toBeUndefined();
    expect(harness.core.journal.db.query('SELECT COUNT(*) AS n FROM events WHERE thread_id = ?').get(id)).toEqual({ n: 0 });
  }
  for (const turn of turns) expect(harness.core.journal.getTurn(turn.id)).toBeNull();
  expect(harness.core.journal.getThread(keptId)).not.toBeNull();
  expect(existsSync(marker)).toBe(true);
  // A delayed turn completion or stream flush cannot recreate the removed rows.
  harness.core.journal.flushDeltas();
  expect(harness.core.journal.listMessages(threadId)).toEqual([]);
});

test('a paired device cannot delete conversations and agent sessions stay managed by Agents', async () => {
  const { threadId } = await echoThread(harness, client);
  const { grant } = await client.call('pairing.grant', {});
  const session = harness.core.sessions.exchange(grant, { name: 'phone', version: 'test' });
  const device = await connect(harness.url, session.token);
  try { await expect(device.call('threads.remove', { threadId })).rejects.toThrow(); }
  finally { device.close(); }
  const thread = harness.core.threads.require(threadId);
  harness.core.journal.putThread({ ...thread, agentSessionId: 'session-owned-by-agent' });
  await expect(client.call('threads.remove', { threadId })).rejects.toThrow('persistent agent sessions');
  expect(harness.core.journal.getThread(threadId)).not.toBeNull();
});

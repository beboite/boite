import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_DELEGATION_CONFIG } from '@boite/contracts';
import type { CoreClient } from '../src/client.ts';
import { connect } from '../src/client.ts';
import { threadTerminalId } from '../src/terminals.ts';
import { echoThread, startTestCore, waitFor, type TestCore } from './harness.ts';

let harness: TestCore;
let client: CoreClient;
let processOutput: Promise<unknown>[];
beforeEach(async () => { processOutput = []; harness = await startTestCore({ settings: { focusGuard: false, muteAgents: false } }); client = await harness.connect(); });
afterEach(async () => {
  await harness.stop();
  await Promise.all(processOutput);
});

test('removal stops the family and hides it until undo, preserving history and project files', async () => {
  const { threadId } = await echoThread(harness, client);
  const { threadId: keptId } = await echoThread(harness, client, 'keep');
  // Real owned processes keep the native tracker active and verify cancellation,
  // rather than testing only echo's in-process turn and idle warm-up workers.
  const startProcess = (id: string) => {
    const child = harness.core.procs.spawn(id, process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
    // Drain the test-owned pipes, including the unrelated process stopped by
    // teardown: an exited Bun subprocess can still own unread native handles.
    processOutput.push(new Response(child.proc.stdout).text(), new Response(child.proc.stderr).text());
    return child;
  };
  const parentProcess = startProcess(threadId);
  const keptProcess = startProcess(keptId);
  const parent = harness.core.threads.require(threadId);
  const marker = join(parent.cwd, 'keep.txt');
  writeFileSync(marker, 'project file');
  await client.call('delegation.configure', { threadId, config: { ...DEFAULT_DELEGATION_CONFIG, enabled: true, profiles: [{ id: 'worker', name: 'Worker', providerId: parent.providerId, accountId: parent.accountId, model: parent.model!, effort: null }] } });
  const child = await client.call('delegation.spawn', { threadId, profileId: 'worker', task: 'long running '.repeat(500), requestId: 'remove-child' });
  const childId = child.thread.id;
  const childProcess = startProcess(childId);
  const terminalId = threadTerminalId(threadId);
  const terminalProcess = startProcess(terminalId);
  const turns = [await client.call('turns.start', { threadId, prompt: 'long running '.repeat(500) })];
  const { questionId } = await client.call('questions.ask', { threadId, text: 'Pending question', options: ['Yes', 'No'] });
  for (const id of [threadId, childId]) {
    harness.core.journal.setSetting(`move-note:${id}`, { text: 'old move' });
    harness.core.journal.setSetting(`memory-notices:${id}`, [{ text: 'old notice' }]);
    harness.core.journal.setSetting(`coordination:${id}`, { resources: 'private conversation resources' });
  }
  const removed: string[] = [];
  client.on('thread.removed', event => removed.push(event.threadId));
  await client.call('threads.remove', { threadId });
  await Promise.all([parentProcess.exited, childProcess.exited, terminalProcess.exited]);
  await waitFor(() => removed.length === 2);
  expect(removed.sort()).toEqual([threadId, childId].sort());
  expect(harness.core.scheduler.state()).toEqual({ running: [], queued: [] });
  expect((await client.call('questions.list', {})).some(q => q.id === questionId)).toBe(false);
  for (const id of [threadId, childId]) {
    expect(harness.core.journal.getThread(id)).toBeNull();
    expect(harness.core.journal.listMessages(id).length).toBeGreaterThan(0);
    expect(harness.core.journal.listTurns(id).length).toBeGreaterThan(0);
    expect(harness.core.journal.listProcesses(id, 100).length).toBeGreaterThan(0);
    expect(harness.core.journal.getSetting(`memory-notices:${id}`)).toEqual([{ text: 'old notice' }]);
    expect(harness.core.journal.getSetting(`coordination:${id}`)).toMatchObject({ resources: 'private conversation resources' });
  }
  for (const turn of turns) expect(harness.core.journal.getTurn(turn.id)?.status).toBe('stopped');
  expect(harness.core.journal.listProcesses(terminalId, 100).length).toBeGreaterThan(0);
  expect(keptProcess.proc.exitCode).toBeNull();
  expect(harness.core.procs.liveCount(keptId)).toBeGreaterThan(0);
  expect(harness.core.journal.getThread(keptId)).not.toBeNull();
  expect(existsSync(marker)).toBe(true);
  await expect(client.call('threads.get', { threadId })).rejects.toThrow('unknown thread');
  expect((await client.call('threads.list', { includeArchived: true })).some(t => t.id === threadId || t.id === childId)).toBe(false);
  expect((await client.call('threads.deleted', {})).map(t => t.id)).toEqual([threadId]);
  const history = harness.core.journal.listMessages(threadId);
  const restored = await client.call('threads.restore', { threadId });
  expect(restored.archived).toBe(false);
  expect(harness.core.journal.getThread(childId)?.archived).toBe(false);
  expect((await client.call('delegation.get', { threadId })).agents.some(a => a.thread.id === childId)).toBe(true);
  expect((await client.call('threads.get', { threadId })).messages).toEqual(history);
  expect(await client.call('threads.deleted', {})).toEqual([]);
  expect(harness.core.procs.liveCount(threadId)).toBe(0);
  // A delayed stream flush does not change restored history.
  harness.core.journal.flushDeltas();
  expect(harness.core.journal.listMessages(threadId)).toEqual(history);
});

test('a paired device cannot delete conversations and agent sessions stay managed by Agents', async () => {
  const { threadId } = await echoThread(harness, client);
  const { grant } = await client.call('pairing.grant', {});
  const session = harness.core.sessions.exchange(grant, { name: 'phone', version: 'test' });
  const device = await connect(harness.url, session.token);
  try {
    for (const method of ['threads.remove', 'threads.restore'] as const) await expect(device.call(method, { threadId })).rejects.toThrow();
    await expect(device.call('threads.deleted', {})).rejects.toThrow();
  }
  finally { device.close(); }
  const thread = harness.core.threads.require(threadId);
  harness.core.journal.putThread({ ...thread, agentSessionId: 'session-owned-by-agent' });
  await expect(client.call('threads.remove', { threadId })).rejects.toThrow('persistent agent sessions');
  expect(harness.core.journal.getThread(threadId)).not.toBeNull();
});

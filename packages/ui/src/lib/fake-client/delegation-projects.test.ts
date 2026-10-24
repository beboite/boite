import { expect, vi } from 'vitest';
import { test } from '../../test/fake-client';
import { archivedThreads } from '../archive';

test('fake bot delegation runs in its sole entrusted project and accepts an explicit project among several', async ({ createClient }) => {
  const client = await createClient({ delayMs: 0 });
  let bot = await client.call('agents.profile.save', { value: {
    name: 'Scout', domain: '', instructions: '', avatar: '', status: 'active', projectIds: ['p-boite'],
    selection: { providerId: 'echo', accountId: 'a-echo', model: 'echo-1', effort: null, permissionMode: 'default' },
  } });
  const { threadId } = await client.call('agents.open', { agentId: bot.id });
  await vi.waitFor(async () => expect((await client.call('threads.get', { threadId })).status).toBe('idle'));
  expect((await client.call('threads.get', { threadId })).projectId).toBeNull();
  await expect(client.call('threads.move', { threadId, projectId: 'p-boite' })).rejects.toThrow('cannot be moved');
  const spawn = (requestId: string, project?: string) => client.call('delegation.spawn', { threadId, task: 'Inspect project files', requestId, ...(project ? { project } : {}) });
  const child = await spawn('sole');
  expect(child.thread).toMatchObject({ parentThreadId: threadId, projectId: 'p-boite', cwd: 'C:\\src\\boite', branch: null });
  expect(child.thread.agentSessionId).toBeUndefined();
  bot = await client.call('agents.profile.save', { id: bot.id, expectedRevision: bot.revision, value: { ...bot, projectIds: ['p-boite', 'p-notes'] } });
  expect((await spawn('sole')).thread.id).toBe(child.thread.id);
  expect((await spawn('personal')).thread.projectId).toBeNull();
  const explicit = await spawn('named', 'notes');
  expect(explicit.thread).toMatchObject({ projectId: 'p-notes', cwd: 'C:\\src\\notes', parentThreadId: threadId });
  expect((await spawn('folded-name', ' NoTeS ')).thread.projectId).toBe('p-notes');
  await expect(spawn('named', 'boite')).rejects.toThrow('requestId');
  bot = await client.call('agents.profile.save', { id: bot.id, expectedRevision: bot.revision, value: { ...bot, projectIds: ['p-boite'] } });
  await expect(spawn('withdrawn', 'notes')).rejects.toThrow('entrusted');
});

test('a bot project worker remains in Done and project counts after its bot is archived', async ({ ready }) => {
  const { client, store } = await ready({ delayMs: 0 });
  const bot = await client.call('agents.profile.save', { value: {
    name: 'Scout', domain: '', instructions: '', avatar: '', status: 'active', projectIds: ['p-boite'],
    selection: { providerId: 'echo', accountId: 'a-echo', model: 'echo-1', effort: null, permissionMode: 'default' },
  } });
  const { threadId } = await client.call('agents.open', { agentId: bot.id });
  const child = await client.call('delegation.spawn', { threadId, task: 'Inspect the project', requestId: 'finish-project' });
  await client.call('delegation.wait', { threadId, agentId: child.thread.id, timeoutMs: 5000 });
  await client.call('threads.archive', { threadId: child.thread.id, onlyIfIdle: true });
  expect((await client.call('projects.list', {})).find(p => p.id === 'p-boite')?.doneThreads).toBe(1);
  await client.call('threads.archive', { threadId });
  store.threads = [];
  const global = await archivedThreads(store);
  expect(global.find(t => t.id === threadId)).toMatchObject({ projectId: null, archived: true });
  expect(global.map(t => t.id)).toContain(child.thread.id);
  const project = (await archivedThreads(store, 'p-boite')).map(t => t.id);
  expect(project).toContain(child.thread.id);
  expect(project).not.toContain(threadId);
  await client.call('threads.archive', { threadId: child.thread.id, archived: false });
  expect((await client.call('projects.list', {})).find(p => p.id === 'p-boite')?.doneThreads).toBeUndefined();
});

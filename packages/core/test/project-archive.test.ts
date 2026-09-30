import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Project } from '@boite/contracts';
import type { CoreClient } from '../src/client.ts';
import { echoThread, startTestCore, testProject, waitFor } from './harness.ts';
import type { TestCore } from './harness.ts';

let harness: TestCore;
let client: CoreClient;

beforeEach(async () => {
  harness = await startTestCore();
  client = await harness.connect();
});

afterEach(async () => {
  await harness.stop();
});

test('archiving a project moves only its flag, says so to every client and survives a restart', async () => {
  const { threadId } = await echoThread(harness, client);
  const project = await testProject(harness, client);
  const other = await harness.connect();
  const heard: Project[] = [];
  other.on('project.updated', (payload) => heard.push(payload));

  const archived = await client.call('projects.archive', { projectId: project.id });
  expect(archived).toMatchObject({ id: project.id, archived: true });
  await waitFor(() => heard.length === 1);
  expect(heard[0]).toMatchObject({ id: project.id, archived: true });
  // Its threads are left as they were.
  const thread = (await client.call('threads.list', { projectId: project.id })).find((t) => t.id === threadId);
  expect(thread?.archived).toBe(false);
  // Twice is not a change: no second event.
  await client.call('projects.archive', { projectId: project.id, archived: true });
  await Bun.sleep(50);
  expect(heard).toHaveLength(1);

  // The flag is a column of the project's row, so a restarted core reads it back.
  expect(harness.core.journal.getProject(project.id)?.archived).toBe(true);
  expect((await client.call('projects.list', {})).find((p) => p.id === project.id)).toMatchObject({ archived: true });
  const restored = await client.call('projects.archive', { projectId: project.id, archived: false });
  expect(restored.archived).toBeUndefined();
  expect(harness.core.journal.getProject(project.id)?.archived).toBeUndefined();
  await waitFor(() => heard.length === 2);
  other.close();
});

test('a project counts its archived threads, and each archive or restore announces the new count', async () => {
  const { threadId } = await echoThread(harness, client, 'first');
  const project = await testProject(harness, client);
  const heard: Project[] = [];
  client.on('project.updated', (payload) => heard.push(payload));
  expect((await client.call('projects.list', {})).find((p) => p.id === project.id)?.archivedThreads).toBeUndefined();

  await client.call('threads.archive', { threadId });
  await waitFor(() => heard.length === 1);
  expect(heard[0]).toMatchObject({ id: project.id, archivedThreads: 1 });
  expect((await client.call('projects.list', {})).find((p) => p.id === project.id)?.archivedThreads).toBe(1);

  await client.call('threads.archive', { threadId, archived: false });
  await waitFor(() => heard.length === 2);
  expect(heard[1]?.archivedThreads).toBeUndefined();
});

test('a thread started in an archived project brings the project back', async () => {
  const project = await testProject(harness, client);
  await client.call('projects.archive', { projectId: project.id });
  await echoThread(harness, client, 'back to work');
  expect((await client.call('projects.list', {})).find((p) => p.id === project.id)?.archived).toBeUndefined();
});

test('the drafts project and an unknown one are refused by name', async () => {
  const drafts = await client.call('projects.drafts', {});
  await expect(client.call('projects.archive', { projectId: drafts.id })).rejects.toThrow('the drafts project cannot be archived');
  await expect(client.call('projects.archive', { projectId: 'prj_missing' })).rejects.toThrow('unknown project prj_missing');
});

test('a project worktree default is broadcast, survives archive and restore, and can be disabled', async () => {
  mkdirSync(join(harness.dataDir, '.git'));
  const project = await testProject(harness, client);
  const other = await harness.connect();
  const heard: Project[] = [];
  other.on('project.updated', payload => heard.push(payload));
  expect(harness.core.projects.require(project.id).worktreeDefault).toBeUndefined();
  await client.call('projects.setWorktreeDefault', { projectId: project.id, enabled: true });
  await waitFor(() => heard.length === 1);
  expect(heard[0]?.worktreeDefault).toBe(true);
  await client.call('projects.setWorktreeDefault', { projectId: project.id, enabled: true });
  await client.call('projects.archive', { projectId: project.id });
  expect(harness.core.journal.getProject(project.id)).toMatchObject({ archived: true, worktreeDefault: true });
  await client.call('projects.archive', { projectId: project.id, archived: false });
  expect((await client.call('projects.list', {})).find(p => p.id === project.id)?.worktreeDefault).toBe(true);
  await client.call('projects.setWorktreeDefault', { projectId: project.id, enabled: false });
  await waitFor(() => heard.length === 4);
  expect(heard.at(-1)?.worktreeDefault).toBeUndefined();
});

test('worktree defaults reject non-repositories, Drafts, missing projects and non-boolean values', async () => {
  const project = await client.call('projects.add', { path: harness.dataDir });
  await expect(client.call('projects.setWorktreeDefault', { projectId: project.id, enabled: true })).rejects.toThrow('must name a Git repository');
  const drafts = await client.call('projects.drafts', {});
  await expect(client.call('projects.setWorktreeDefault', { projectId: drafts.id, enabled: true })).rejects.toThrow('must name a Git repository');
  await expect(client.call('projects.setWorktreeDefault', { projectId: 'missing', enabled: true })).rejects.toThrow('unknown project missing');
  await expect(client.call('projects.setWorktreeDefault', { projectId: project.id, enabled: 'yes' as unknown as boolean })).rejects.toThrow('enabled must be a boolean');
  expect((await client.call('projects.setWorktreeDefault', { projectId: project.id, enabled: false })).worktreeDefault).toBeUndefined();
});

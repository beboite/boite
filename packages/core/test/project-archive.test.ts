import { afterEach, beforeEach, expect, test } from 'bun:test';
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

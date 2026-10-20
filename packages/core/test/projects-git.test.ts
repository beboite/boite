import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { ProjectStore, hasGitMarker, probeFolder, probeGit } from '../src/projects.ts';
import { startTestCore, waitFor } from './harness.ts';
import type { TestCore } from './harness.ts';
import { thrown } from './settle.ts';

let harness: TestCore;

beforeEach(async () => {
  harness = await startTestCore();
});

afterEach(async () => {
  await harness.stop();
});

test('projects.list answers from the last check once the disk is past its deadline', async () => {
  const client = await harness.connect();
  const path = join(harness.dataDir, 'share');
  mkdirSync(path, { recursive: true });
  // add() checks the folder itself and starts no check. Any other check is
  // instant and over before the pending one is swapped in: a real stat still in
  // flight on a loaded machine would hold the only slot.
  harness.core.projects.gitProbe = async () => false;
  const project = await client.call('projects.add', { path });
  await Bun.sleep(0);
  expect(project.repository).toBe(false);

  // A share whose host went away: the check never answers.
  const pending = Promise.withResolvers<boolean | null>();
  let checks = 0;
  harness.core.projects.gitProbe = () => { checks += 1; return pending.promise; };
  harness.core.projects.gitWaitMs = 100;
  mkdirSync(join(path, '.git'));
  const started = performance.now();
  const listed = await client.call('projects.list', {});
  const waited = performance.now() - started;
  expect(waited).toBeGreaterThanOrEqual(90);
  expect(waited).toBeLessThan(1_000);
  expect(listed.find((entry) => entry.id === project.id)?.repository).toBe(false);
  // The check still pending is not waited for twice: the next answers are immediate.
  const again = performance.now();
  await client.call('projects.list', {});
  harness.core.projects.require(project.id);
  expect(performance.now() - again).toBeLessThan(90);
  // One check per folder at a time, however often the list is asked for.
  expect(checks).toBe(1);

  pending.resolve(true);
  await Bun.sleep(0);
  const after = await client.call('projects.list', {});
  expect(after.find((entry) => entry.id === project.id)?.repository).toBe(true);
});

test('the first projects.list after a git init already says repository', async () => {
  const client = await harness.connect();
  const path = join(harness.dataDir, 'plain');
  mkdirSync(path, { recursive: true });
  const project = await client.call('projects.add', { path });
  expect((await client.call('projects.list', {})).find((entry) => entry.id === project.id)?.repository).toBe(false);
  mkdirSync(join(path, '.git'));
  expect((await client.call('projects.list', {})).find((entry) => entry.id === project.id)?.repository).toBe(true);
});

test('a check with no clear answer keeps the last one, and a restart checks every project', async () => {
  const client = await harness.connect();
  const path = join(harness.dataDir, 'repo');
  mkdirSync(join(path, '.git'), { recursive: true });
  const project = await client.call('projects.add', { path });
  harness.core.projects.gitProbe = async () => null;
  await client.call('projects.list', {});
  await Bun.sleep(0);
  const listed = await client.call('projects.list', {});
  expect(listed.find((entry) => entry.id === project.id)?.repository).toBe(true);

  // A store made at start checks every project before the first list.
  const restarted = new ProjectStore(harness.core);
  await waitFor(() => restarted.list().find((entry) => entry.id === project.id)?.repository === true, 2000);
});

test('hasGitMarker answers from the disk within its deadline', async () => {
  expect(await hasGitMarker(harness.dataDir)).toBe(false);
  mkdirSync(join(harness.dataDir, '.git'));
  expect(await hasGitMarker(harness.dataDir)).toBe(true);
});

test.skipIf(process.platform !== 'win32')('a folder added again in another case answers its fresh git check under the stored spelling', async () => {
  const client = await harness.connect();
  const path = join(harness.dataDir, 'Case');
  mkdirSync(path, { recursive: true });
  // No background check may answer in the test's place: only add() looks at the disk.
  harness.core.projects.gitProbe = async () => null;
  const first = await client.call('projects.add', { path });
  expect(first.repository).toBe(false);
  mkdirSync(join(path, '.git'));
  const again = await client.call('projects.add', { path: path.toUpperCase() });
  expect(again.id).toBe(first.id);
  expect(again.repository).toBe(true);
  expect(harness.core.projects.list().find((entry) => entry.id === first.id)?.repository).toBe(true);
});

test('a deleted project folder is named by every refusal, and a folder put back is a project again', async () => {
  const client = await harness.connect();
  const path = join(harness.dataDir, 'gone');
  mkdirSync(join(path, '.git'), { recursive: true });
  const project = await client.call('projects.add', { path });
  const account = (await client.call('accounts.list', {})).find((entry) => entry.providerId === 'echo');
  const thread = await client.call('threads.create', { projectId: project.id, providerId: 'echo', accountId: account?.id ?? '', title: 'gone' });
  rmSync(path, { recursive: true, force: true });

  const sentence = `the folder ${path} does not exist any more`;
  // Reading the changes used to answer "git did not start: needs git on PATH".
  expect(await thrown(client.call('git.status', { threadId: thread.id }))).toThrow(sentence);
  // These two used to answer "is not a git repository".
  expect(await thrown(client.call('worktrees.list', { projectId: project.id }))).toThrow(sentence);
  expect(await thrown(client.call('projects.setWorktreeDefault', { projectId: project.id, enabled: true }))).toThrow(sentence);
  expect((await client.call('projects.list', {})).find((entry) => entry.id === project.id)?.missing).toBe(true);

  const updated: (boolean | undefined)[] = [];
  client.on('project.updated', (entry) => { if (entry.id === project.id) updated.push(entry.missing); });
  mkdirSync(path, { recursive: true });
  const back = (await client.call('projects.list', {})).find((entry) => entry.id === project.id);
  expect(back?.missing).toBeUndefined();
  expect(back?.repository).toBe(false);
  await waitFor(() => updated.length > 0);
  expect(updated.at(-1)).toBeUndefined();
  await client.call('threads.create', { projectId: project.id, providerId: 'echo', accountId: account?.id ?? '', title: 'back' });
});

test('a list asked after a folder came back is not answered by a check that read the disk before', async () => {
  const client = await harness.connect();
  const path = join(harness.dataDir, 'returning');
  mkdirSync(path, { recursive: true });
  const project = await client.call('projects.add', { path });
  rmSync(path, { recursive: true, force: true });
  expect((await client.call('projects.list', {})).find((entry) => entry.id === project.id)?.missing).toBe(true);
  // Any request naming the project starts a check in the background. Its folder
  // read saw the folder gone, and on a loaded runner its answer is not in yet
  // when the folder comes back.
  const stale = Promise.withResolvers<boolean | null>();
  const store = harness.core.projects;
  let reads = 0;
  // Every other folder answers at once.
  store.gitProbe = async (folder) => (folder === path ? probeGit(folder) : null);
  store.folderProbe = (folder) => (folder === path && ++reads === 1 ? stale.promise : probeFolder(folder));
  store.require(project.id);
  await waitFor(() => reads === 1);
  mkdirSync(path, { recursive: true });
  // The stale answer lands once the list has started.
  const listFresh = store.listFresh.bind(store);
  store.listFresh = () => { const answer = listFresh(); setTimeout(() => stale.resolve(false), 0); return answer; };
  const back = (await client.call('projects.list', {})).find((entry) => entry.id === project.id);
  expect(back?.missing).toBeUndefined();
});

test('a disk that gives no clear answer does not mark a project missing', async () => {
  const client = await harness.connect();
  const path = join(harness.dataDir, 'asleep');
  mkdirSync(path, { recursive: true });
  const project = await client.call('projects.add', { path });
  // A share whose host sleeps: neither check can say the folder is gone.
  harness.core.projects.gitProbe = async () => false;
  harness.core.projects.folderProbe = async () => null;
  const listed = (await client.call('projects.list', {})).find((entry) => entry.id === project.id);
  expect(listed?.missing).toBeUndefined();
  const account = (await client.call('accounts.list', {})).find((entry) => entry.providerId === 'echo');
  await client.call('threads.create', { projectId: project.id, providerId: 'echo', accountId: account?.id ?? '', title: 'asleep' });
});

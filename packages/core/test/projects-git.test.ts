import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { ProjectStore, hasGitMarker } from '../src/projects.ts';
import { startTestCore, waitFor } from './harness.ts';
import type { TestCore } from './harness.ts';

let harness: TestCore;

beforeEach(async () => {
  harness = await startTestCore();
});

afterEach(async () => {
  await harness.stop();
});

test('projects.list answers from the last check while the disk has not answered', async () => {
  const client = await harness.connect();
  const path = join(harness.dataDir, 'share');
  mkdirSync(path, { recursive: true });
  const project = await client.call('projects.add', { path });
  expect(project.repository).toBe(false);

  // A share whose host went away: the check never answers.
  const pending = Promise.withResolvers<boolean | null>();
  let checks = 0;
  harness.core.projects.gitProbe = () => { checks += 1; return pending.promise; };
  mkdirSync(join(path, '.git'));
  const started = performance.now();
  const listed = await client.call('projects.list', {});
  await client.call('projects.list', {});
  harness.core.projects.require(project.id);
  expect(performance.now() - started).toBeLessThan(200);
  expect(listed.find((entry) => entry.id === project.id)?.repository).toBe(false);
  // One check per folder at a time, however often the list is asked for.
  expect(checks).toBe(1);

  pending.resolve(true);
  await Bun.sleep(0);
  const after = await client.call('projects.list', {});
  expect(after.find((entry) => entry.id === project.id)?.repository).toBe(true);
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

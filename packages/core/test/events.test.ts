import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { startTestCore } from './harness.ts';
import type { TestCore } from './harness.ts';

let harness: TestCore;

beforeEach(async () => {
  harness = await startTestCore();
});

afterEach(async () => {
  await harness.stop();
});

/**
 * A second client subscribed to no thread at all still has to see what the
 * first one changed: that is what keeps the phone and a second shell in step
 * without a reload.
 */
test('a second connection sees settings, providers, projects and accounts change', async () => {
  const actor = await harness.connect();
  const watcher = await harness.connect();

  const settingsUpdated = watcher.next('settings.updated', (settings) => settings.maxConcurrentTurns === 9);
  await actor.call('settings.set', { maxConcurrentTurns: 9 });
  expect((await settingsUpdated).maxConcurrentTurns).toBe(9);

  const path = join(harness.dataDir, 'a-project');
  mkdirSync(path, { recursive: true });
  const projectAdded = watcher.next('project.added', (project) => project.path === resolve(path));
  const project = await actor.call('projects.add', { path, name: 'a project' });
  expect((await projectAdded).id).toBe(project.id);

  const accounts = await actor.call('accounts.list', {});
  const echo = accounts.find((account) => account.providerId === 'echo');
  if (echo === undefined) throw new Error('no echo account');
  const thread = await actor.call('threads.create', {
    projectId: project.id,
    providerId: 'echo',
    accountId: echo.id,
    title: 'in the project',
  });

  const order: string[] = [];
  const offAny = watcher.onAny((name) => {
    if (name === 'thread.removed' || name === 'project.removed') order.push(name);
  });
  const projectRemoved = watcher.next('project.removed', (event) => event.projectId === project.id);
  const threadRemoved = watcher.next('thread.removed', (event) => event.threadId === thread.id);
  await actor.call('projects.remove', { projectId: project.id });
  await Promise.all([threadRemoved, projectRemoved]);
  offAny();
  expect(order).toEqual(['thread.removed', 'project.removed']);

  const second = await actor.call('accounts.add', { providerId: 'echo', label: 'second' });
  const accountRemoved = watcher.next('accounts.removed', (event) => event.accountId === second.id);
  await actor.call('accounts.remove', { accountId: second.id });
  expect((await accountRemoved).accountId).toBe(second.id);

  // A reload that changes nothing tells nobody; a new descriptor on disk does.
  const providersDir = join(harness.dataDir, 'providers');
  mkdirSync(providersDir, { recursive: true });
  const profile = { detect: {}, executable: [], isolation: {} };
  writeFileSync(join(providersDir, 'echo-copy.json'), JSON.stringify({
    id: 'echo-copy',
    schemaVersion: 1,
    name: 'Echo copy',
    shortName: 'Copy',
    protocol: 'echo',
    roots: ['{isolationDir}'],
    profiles: { windows: profile, linux: profile, macos: profile },
    auth: { kind: 'none' },
    models: [{ id: 'echo', name: 'Echo', default: true }],
    capabilities: { approvals: true, hooks: false, checkpoint: false, images: false, planMode: false, resume: true },
  }));
  const providersUpdated = watcher.next('providers.updated');
  const reloaded = await actor.call('providers.reload', {});
  const seen = await providersUpdated;
  expect(seen.rejected).toEqual([]);
  expect(seen.loaded.map((provider) => provider.id)).toEqual(reloaded.loaded.map((provider) => provider.id));
});

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { startTestCore, type TestCore } from './harness.ts';
import { DEVICE_METHODS } from '../src/access.ts';
let harness: TestCore;
beforeEach(async () => { harness = await startTestCore(); });
afterEach(async () => { await harness.stop(); });
test('folder browsing names only directories, navigates parents and refuses invalid paths', async () => {
  const client = await harness.connect();
  const root = join(harness.dataDir, 'folders');
  mkdirSync(join(root, 'alpha'), { recursive: true });
  mkdirSync(join(root, 'with spaces'));
  writeFileSync(join(root, 'file.txt'), 'file');
  const listing = await client.call('projects.browse', { path: root });
  expect(listing).toEqual({ path: root, parent: dirname(root), directories: [
    { name: 'alpha', path: join(root, 'alpha') }, { name: 'with spaces', path: join(root, 'with spaces') }
  ] });
  expect((await client.call('projects.browse', { path: join(root, 'alpha') })).directories).toEqual([]);
  await expect(client.call('projects.browse', { path: 'relative' })).rejects.toThrow('absolute directory path');
  await expect(client.call('projects.browse', { path: join(root, 'file.txt') })).rejects.toThrow('projects.browse.path');
  await expect(client.call('projects.browse', { path: join(root, 'missing') })).rejects.toThrow('missing');
  expect(DEVICE_METHODS.has('projects.browse')).toBe(false);
});

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { startTestCore, type TestCore } from './harness.ts';
import { DEVICE_METHODS } from '../src/access.ts';
import { thrown } from './settle.ts';
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
  expect(await thrown(client.call('projects.browse', { path: 'relative' }))).toThrow('absolute directory path');
  expect(await thrown(client.call('projects.browse', { path: join(root, 'file.txt') }))).toThrow('projects.browse.path');
  expect(await thrown(client.call('projects.browse', { path: join(root, 'missing') }))).toThrow('missing');
  expect(DEVICE_METHODS.has('projects.browse')).toBe(false);
});

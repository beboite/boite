import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'bun:test';
import type { ProviderInstall } from '@boite/contracts';
import { readTreeSide } from '../src/git/read.ts';
import { InstallManager } from '../src/providers/install.ts';
import { extractRelease } from '../src/providers/install-unpack.ts';
import { snapshot } from '../src/threads/checkpoint-files.ts';
import { echoThread, startTestCore, type TestCore } from './harness.ts';

let harness: TestCore | undefined;
const leftovers: string[] = [];

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
  for (const path of leftovers.splice(0)) rmSync(path, { recursive: true, force: true });
});

function outside(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  leftovers.push(path);
  return path;
}

test('git status does not run a core.fsmonitor command', async () => {
  harness = await startTestCore();
  const client = await harness.connect();
  const { threadId } = await echoThread(harness, client);
  const repo = outside('boite-fsmonitor-');
  const markerDir = outside('boite-fsmonitor-marker-');
  const marker = join(markerDir, 'ran');
  const script = join(repo, 'watch.js');
  writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran\\n');\n`);
  const quote = (value: string): string => process.platform === 'win32' ? `"${value}"` : `'${value.replaceAll("'", `'\\''`)}'`;
  const git = (args: string[]): number => Bun.spawnSync({
    cmd: ['git', ...args],
    cwd: repo,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'boite test',
      GIT_AUTHOR_EMAIL: 'test@boite.invalid',
      GIT_COMMITTER_NAME: 'boite test',
      GIT_COMMITTER_EMAIL: 'test@boite.invalid',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  }).exitCode;
  expect(git(['init', '-q'])).toBe(0);
  writeFileSync(join(repo, 'README.md'), 'hello\n');
  expect(git(['add', 'README.md', 'watch.js'])).toBe(0);
  expect(git(['commit', '-q', '-m', 'init'])).toBe(0);
  expect(git(['config', 'core.fsmonitor', `${quote(process.execPath)} ${quote(script)}`])).toBe(0);
  git(['status', '--porcelain']);
  expect(existsSync(marker)).toBe(true);
  rmSync(marker);
  const thread = harness.core.threads.require(threadId);
  harness.core.journal.putThread({ ...thread, cwd: repo });
  const status = await client.call('git.status', { threadId });
  expect(status.changes).toEqual([]);
  expect(existsSync(marker)).toBe(false);
});

test('a symlink diff is the link text', async () => {
  const dir = outside('boite-link-diff-');
  writeFileSync(join(dir, 'target.txt'), 'secret bytes\n');
  symlinkSync('target.txt', join(dir, 'link.txt'));
  const side = await readTreeSide(join(dir, 'link.txt'));
  expect(Buffer.from(side.data ?? []).toString()).toBe('target.txt');
  expect(side.tooBig).toBe(false);
});

test('a poisoned checkpoint blob is rewritten from the file', async () => {
  harness = await startTestCore();
  const client = await harness.connect();
  const { threadId } = await echoThread(harness, client);
  const root = outside('boite-checkpoint-');
  writeFileSync(join(root, 'note.txt'), 'hello\n');
  const objects = join(harness.dataDir, 'checkpoint-objects');
  const first = await snapshot(harness.core, threadId, root, objects);
  const hash = createHash('sha256').update('hello\n').digest('hex');
  expect(first['note.txt']?.hash).toBe(hash);
  writeFileSync(join(objects, hash), 'poison');
  const second = await snapshot(harness.core, threadId, root, objects);
  expect(second['note.txt']?.hash).toBe(hash);
  expect(readFileSync(join(objects, hash)).toString()).toBe('hello\n');
});

test('held answers are journaled once and still prefix the next prompt', async () => {
  harness = await startTestCore();
  const client = await harness.connect();
  const { threadId } = await echoThread(harness, client);
  harness.core.threads.deferred.deferredAnswers.set(threadId, ['held once']);
  harness.core.threads.deferred.recordHeldBeforePrompt(threadId, 'trn_held', 1_000);
  harness.core.threads.deferred.recordHeldBeforePrompt(threadId, 'trn_held', 2_000);
  const held = harness.core.journal.listMessages(threadId).filter((message) => message.role === 'user' && message.parts[0]?.type === 'text' && message.parts[0].text === 'held once');
  expect(held).toHaveLength(1);
  expect(harness.core.threads.deferred.deferredAnswers.has(threadId)).toBe(false);
  expect(harness.core.threads.deferred.takeDeferred(threadId)).toBe('held once\n\n');
  expect(harness.core.threads.deferred.takeDeferred(threadId)).toBe('');
  expect((await client.call('threads.get', { threadId })).pendingAnswers).toEqual([]);
});

const binaryInstall = (path: string): ProviderInstall => ({
  version: '1.0.0',
  format: 'binary',
  url: 'https://example.invalid/agent',
  sha256: 'abc',
  archiveBytes: 4,
  files: [{ path, bytes: 4 }],
});

test('a release directory planted as a symlink is not unpacked into', async () => {
  const data = outside('boite-install-');
  const target = outside('boite-install-outside-');
  writeFileSync(join(target, 'secret.txt'), 'keep');
  const manager = new InstallManager(data);
  const release = manager.releaseDir('echo', '1.0.0');
  mkdirSync(join(data, 'agents', 'echo', 'releases'), { recursive: true });
  symlinkSync(target, release, 'junction');
  const part = join(data, 'payload.bin');
  writeFileSync(part, 'leak');
  await expect(extractRelease(binaryInstall('secret.txt'), new AbortController().signal, part, release)).rejects.toThrow(/symlink/);
  expect(readFileSync(join(target, 'secret.txt'), 'utf8')).toBe('keep');
});

test('prune removes a releases symlink and a child symlink without following either', () => {
  const data = outside('boite-prune-');
  const manager = new InstallManager(data);
  const live = join(data, 'live');
  mkdirSync(live);
  const current = manager.currentDir('echo');
  mkdirSync(join(data, 'agents', 'echo'), { recursive: true });
  symlinkSync(live, current, 'junction');

  const linkedReleases = outside('boite-prune-releases-');
  writeFileSync(join(linkedReleases, 'secret.txt'), 'secret');
  symlinkSync(linkedReleases, join(data, 'agents', 'echo', 'releases'), 'junction');
  manager.prune('echo');
  expect(existsSync(join(linkedReleases, 'secret.txt'))).toBe(true);
  expect(existsSync(join(data, 'agents', 'echo', 'releases'))).toBe(false);

  const releases = join(data, 'agents', 'echo', 'releases');
  const stale = join(releases, '0.9.0');
  mkdirSync(stale, { recursive: true });
  writeFileSync(join(stale, 'old.txt'), 'old');
  const childOutside = outside('boite-prune-child-');
  writeFileSync(join(childOutside, 'secret.txt'), 'secret');
  symlinkSync(childOutside, join(releases, 'linked'), 'junction');
  manager.prune('echo');
  expect(existsSync(join(childOutside, 'secret.txt'))).toBe(true);
  expect(existsSync(join(releases, 'linked'))).toBe(false);
  expect(existsSync(stale)).toBe(false);
  expect(existsSync(live)).toBe(true);
});

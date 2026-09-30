import { existsSync, mkdirSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { WorktreeEntry } from '@boite/contracts';
import { parseWorktreeList } from '../src/worktree-sweep.ts';
import { worktreeRoot } from '../src/worktree.ts';
import { startTestCore } from './harness.ts';
import type { TestCore } from './harness.ts';
import type { CoreClient } from '../src/client.ts';

let harness: TestCore;
let client: CoreClient;

beforeEach(async () => {
  harness = await startTestCore();
  client = await harness.connect();
});

afterEach(async () => {
  await harness.stop();
});

/** The fixture repository's own identity: a commit needs one, and the machine's config is not the test's business. */
const FIXTURE_GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'boite test',
  GIT_AUTHOR_EMAIL: 'test@boite.invalid',
  GIT_COMMITTER_NAME: 'boite test',
  GIT_COMMITTER_EMAIL: 'test@boite.invalid',
};

function git(cwd: string, ...args: string[]): string {
  const run = Bun.spawnSync({ cmd: ['git', ...args], cwd, env: FIXTURE_GIT_ENV, stdout: 'pipe', stderr: 'pipe', windowsHide: true });
  if (!run.success) throw new Error(`git ${args.join(' ')} failed: ${run.stderr.toString()}`);
  return run.stdout.toString();
}

async function repoProject(name = 'repo'): Promise<{ id: string; path: string }> {
  const path = join(harness.dataDir, name);
  mkdirSync(path, { recursive: true });
  git(path, 'init', '-q');
  writeFileSync(join(path, 'README.md'), 'hello\n');
  git(path, 'add', 'README.md');
  git(path, 'commit', '-q', '-m', 'init');
  return client.call('projects.add', { path, name });
}

/** A worktree on a fresh branch beside the repository, the way the core places its own. */
function addWorktree(project: { path: string }, slug: string): string {
  const path = join(worktreeRoot(project.path), slug);
  git(project.path, 'worktree', 'add', '-q', '-b', `boite/${slug}`, path);
  return path;
}

async function echoAccount(): Promise<string> {
  const account = (await client.call('accounts.list', {})).find((entry) => entry.providerId === 'echo');
  if (account === undefined) throw new Error('no echo account');
  return account.id;
}

/**
 * A path as git reports it: resolved through its nearest existing folder, so
 * the temp directory's `/var` meets `/private/var` on macOS and an 8.3 alias
 * its long name on Windows.
 */
function realKey(path: string): string {
  let head = resolve(path);
  const tail: string[] = [];
  while (!existsSync(head) && dirname(head) !== head) {
    tail.unshift(basename(head));
    head = dirname(head);
  }
  const full = join(realpathSync.native(head), ...tail);
  return process.platform === 'win32' ? full.toLowerCase() : full;
}

function byPath(entries: WorktreeEntry[], path: string): WorktreeEntry {
  const found = entries.find((entry) => realKey(entry.path) === realKey(path));
  if (found === undefined) throw new Error(`${path} not listed in ${entries.map((entry) => entry.path).join(', ')}`);
  return found;
}

function branches(project: { path: string }): string[] {
  return git(project.path, 'branch', '--format=%(refname:short)').split('\n').filter(Boolean);
}

describe('worktrees.list', () => {
  test('reports each linked worktree with what removing it would lose, never the main checkout', async () => {
    const project = await repoProject();
    const clean = addWorktree(project, 'clean');
    const modified = addWorktree(project, 'modified');
    writeFileSync(join(modified, 'README.md'), 'changed\n');
    const untracked = addWorktree(project, 'untracked');
    writeFileSync(join(untracked, 'notes.txt'), 'new\n');
    const unmerged = addWorktree(project, 'unmerged');
    git(unmerged, 'commit', '-q', '--allow-empty', '-m', 'work nowhere else');
    const kept = addWorktree(project, 'kept');
    git(kept, 'commit', '-q', '--allow-empty', '-m', 'work kept elsewhere');
    git(project.path, 'branch', 'keeper', 'boite/kept');
    const gone = addWorktree(project, 'gone');
    rmSync(gone, { recursive: true, force: true });
    // One the user made by hand, outside the core's folder and detached.
    const manual = join(harness.dataDir, 'by-hand');
    git(project.path, 'worktree', 'add', '-q', '--detach', manual);

    const entries = await client.call('worktrees.list', { projectId: project.id });
    expect(entries).toHaveLength(7);
    expect(entries.some((entry) => realKey(entry.path) === realKey(project.path))).toBe(false);
    expect(byPath(entries, clean)).toEqual({
      path: expect.any(String), branch: 'boite/clean', dirty: false, unmerged: false, missing: false,
      threadId: null, threadTitle: null, threadArchived: false,
    });
    expect(byPath(entries, modified)).toMatchObject({ dirty: true, unmerged: false });
    expect(byPath(entries, untracked)).toMatchObject({ dirty: true, unmerged: false });
    expect(byPath(entries, unmerged)).toMatchObject({ dirty: false, unmerged: true });
    expect(byPath(entries, kept)).toMatchObject({ dirty: false, unmerged: false });
    expect(byPath(entries, gone)).toMatchObject({ missing: true, dirty: false, unmerged: false, branch: 'boite/gone' });
    expect(byPath(entries, manual)).toMatchObject({ branch: null, dirty: false, unmerged: false, missing: false });

    // The git calls ran under the project's trace id.
    const processes = await client.call('trace.get', { threadId: `worktrees:${project.id}` });
    expect(processes.some((record) => record.exe === 'git')).toBe(true);
  });

  test('a detached HEAD with a commit on no ref is unmerged', async () => {
    const project = await repoProject();
    const detached = join(harness.dataDir, 'detached');
    git(project.path, 'worktree', 'add', '-q', '--detach', detached);
    git(detached, 'commit', '-q', '--allow-empty', '-m', 'orphan');
    expect(byPath(await client.call('worktrees.list', { projectId: project.id }), detached)).toMatchObject({ branch: null, unmerged: true });
  });

  test('names the thread standing in a worktree, and says when it is archived', async () => {
    const project = await repoProject();
    const accountId = await echoAccount();
    const thread = await client.call('threads.create', { projectId: project.id, providerId: 'echo', accountId, title: 'Fix the login', worktree: {} });
    let entry = byPath(await client.call('worktrees.list', { projectId: project.id }), thread.cwd);
    expect(entry).toMatchObject({ threadId: thread.id, threadTitle: 'Fix the login', threadArchived: false, branch: thread.branch });

    await client.call('threads.archive', { threadId: thread.id });
    entry = byPath(await client.call('worktrees.list', { projectId: project.id }), thread.cwd);
    expect(entry).toMatchObject({ threadId: thread.id, threadArchived: true });
  });

  test('a project that is not a repository is refused by name', async () => {
    const path = join(harness.dataDir, 'plain');
    mkdirSync(path);
    const project = await client.call('projects.add', { path, name: 'plain' });
    await expect(client.call('worktrees.list', { projectId: project.id })).rejects.toThrow(`${path} is not a git repository`);
  });

  test('parses the porcelain list, a bare repository and an unborn branch included', () => {
    const out = 'worktree /r\0HEAD abc\0branch refs/heads/main\0\0worktree /w\0HEAD 0000000000000000000000000000000000000000\0branch refs/heads/new\0\0worktree /d\0HEAD def\0detached\0prunable gitdir file points to non-existent location\0\0';
    const parsed = parseWorktreeList(out);
    expect(parsed.map((entry) => [entry.branch, entry.head, entry.main])).toEqual([
      ['main', 'abc', true],
      ['new', null, false],
      [null, 'def', false],
    ]);
  });
});

describe('worktrees.remove', () => {
  test('refuses a path git does not list, the main checkout and a worktree a live thread uses', async () => {
    const project = await repoProject();
    await expect(client.call('worktrees.remove', { projectId: project.id, path: join(harness.dataDir, 'nowhere') })).rejects.toMatchObject({
      rpc: { message: expect.stringContaining('is not a worktree git lists'), data: expect.objectContaining({ field: 'path', expected: 'a worktree of this project' }) },
    });
    await expect(client.call('worktrees.remove', { projectId: project.id, path: project.path })).rejects.toMatchObject({
      rpc: { message: expect.stringContaining("the project's own checkout"), data: expect.objectContaining({ field: 'path' }) },
    });

    const accountId = await echoAccount();
    const thread = await client.call('threads.create', { projectId: project.id, providerId: 'echo', accountId, title: 'Busy here', worktree: {} });
    await expect(client.call('worktrees.remove', { projectId: project.id, path: thread.cwd, force: true })).rejects.toMatchObject({
      rpc: { message: expect.stringContaining(`thread "Busy here" (${thread.id})`), data: expect.objectContaining({ field: 'path', expected: 'a worktree no live thread uses', threadId: thread.id, threadTitle: 'Busy here' }) },
    });
    expect(existsSync(thread.cwd)).toBe(true);
  });

  test('without force, refuses what would lose work and names what', async () => {
    const project = await repoProject();
    const dirty = addWorktree(project, 'dirty');
    writeFileSync(join(dirty, 'notes.txt'), 'new\n');
    const unmerged = addWorktree(project, 'unmerged');
    // Two messages: two empty commits on one parent in the same second would be one commit.
    git(unmerged, 'commit', '-q', '--allow-empty', '-m', 'only in unmerged');
    const both = addWorktree(project, 'both');
    git(both, 'commit', '-q', '--allow-empty', '-m', 'only in both');
    writeFileSync(join(both, 'notes.txt'), 'new\n');

    await expect(client.call('worktrees.remove', { projectId: project.id, path: dirty })).rejects.toMatchObject({
      rpc: { message: 'This worktree has uncommitted changes.', data: expect.objectContaining({ field: 'force', dirty: true, unmerged: false }) },
    });
    await expect(client.call('worktrees.remove', { projectId: project.id, path: unmerged })).rejects.toMatchObject({
      rpc: { message: 'This worktree has commits on no other branch.', data: expect.objectContaining({ field: 'force', dirty: false, unmerged: true }) },
    });
    await expect(client.call('worktrees.remove', { projectId: project.id, path: both })).rejects.toThrow(
      'This worktree has uncommitted changes. This worktree has commits on no other branch.',
    );
    for (const path of [dirty, unmerged, both]) expect(existsSync(path)).toBe(true);
  });

  test('a clean worktree goes with its branch, and the list no longer has it', async () => {
    const project = await repoProject();
    const clean = addWorktree(project, 'clean');
    expect(await client.call('worktrees.remove', { projectId: project.id, path: clean })).toEqual({ ok: true, branchDeleted: true });
    expect(existsSync(clean)).toBe(false);
    expect(branches(project)).not.toContain('boite/clean');
    expect(await client.call('worktrees.list', { projectId: project.id })).toEqual([]);
  });

  test('git keeps a branch it does not see merged: the worktree goes, branchDeleted says so', async () => {
    const project = await repoProject();
    const kept = addWorktree(project, 'kept');
    git(kept, 'commit', '-q', '--allow-empty', '-m', 'on another branch too');
    git(project.path, 'branch', 'keeper', 'boite/kept');
    // Not unmerged (keeper holds it), but not merged into HEAD either, so `branch -d` refuses.
    expect(await client.call('worktrees.remove', { projectId: project.id, path: kept })).toEqual({ ok: true, branchDeleted: false });
    expect(existsSync(kept)).toBe(false);
    expect(branches(project)).toContain('boite/kept');
  });

  test('force removes a dirty and unmerged worktree and deletes its branch', async () => {
    const project = await repoProject();
    const both = addWorktree(project, 'both');
    git(both, 'commit', '-q', '--allow-empty', '-m', 'only here');
    writeFileSync(join(both, 'README.md'), 'changed\n');
    writeFileSync(join(both, 'notes.txt'), 'new\n');
    expect(await client.call('worktrees.remove', { projectId: project.id, path: both, force: true })).toEqual({ ok: true, branchDeleted: true });
    expect(existsSync(both)).toBe(false);
    expect(branches(project)).not.toContain('boite/both');
  });

  test('a missing directory loses its registration and its branch', async () => {
    const project = await repoProject();
    const gone = addWorktree(project, 'gone');
    rmSync(gone, { recursive: true, force: true });
    expect(await client.call('worktrees.remove', { projectId: project.id, path: gone })).toEqual({ ok: true, branchDeleted: true });
    expect(git(project.path, 'worktree', 'list', '--porcelain')).not.toContain('boite/gone');
    expect(branches(project)).not.toContain('boite/gone');
  });

  test('a missing directory named through a link still matches the path git lists', async () => {
    const project = await repoProject();
    const gone = addWorktree(project, 'gone');
    rmSync(gone, { recursive: true, force: true });
    // What a temp path under /var or an 8.3 alias is to git: another name for the same folder.
    const alias = join(harness.dataDir, 'alias');
    symlinkSync(harness.dataDir, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const named = join(alias, relative(harness.dataDir, gone));
    expect(await client.call('worktrees.remove', { projectId: project.id, path: named })).toEqual({ ok: true, branchDeleted: true });
    expect(branches(project)).not.toContain('boite/gone');
  });

  test('the prune after a removal drops registrations gone for over an hour, not fresh ones', async () => {
    const project = await repoProject();
    const target = addWorktree(project, 'target');
    const old = addWorktree(project, 'old');
    const fresh = addWorktree(project, 'fresh');
    rmSync(old, { recursive: true, force: true });
    rmSync(fresh, { recursive: true, force: true });
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000);
    // Git dates a vanished worktree by its private index.
    utimesSync(join(project.path, '.git', 'worktrees', 'old', 'index'), twoHoursAgo, twoHoursAgo);

    await client.call('worktrees.remove', { projectId: project.id, path: target });
    const listed = git(project.path, 'worktree', 'list', '--porcelain');
    expect(listed).not.toContain('boite/target');
    expect(listed).not.toContain('boite/old');
    expect(listed).toContain('boite/fresh');
  });

  test('an archived thread does not hold its worktree, and a turn after the restore is refused by folder', async () => {
    const project = await repoProject();
    const accountId = await echoAccount();
    const thread = await client.call('threads.create', { projectId: project.id, providerId: 'echo', accountId, title: 'Put away', worktree: {} });
    await client.call('threads.archive', { threadId: thread.id });
    expect(await client.call('worktrees.remove', { projectId: project.id, path: thread.cwd })).toEqual({ ok: true, branchDeleted: true });
    expect(existsSync(thread.cwd)).toBe(false);

    const restored = await client.call('threads.archive', { threadId: thread.id, archived: false });
    expect(restored.cwd).toBe(thread.cwd);
    await expect(client.call('turns.start', { threadId: thread.id, prompt: 'still there?' })).rejects.toMatchObject({
      rpc: { message: expect.stringContaining(thread.cwd), data: expect.objectContaining({ threadId: thread.id, field: 'cwd', cwd: thread.cwd }) },
    });
  });
});

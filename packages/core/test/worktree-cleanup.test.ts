import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type { ThreadSummary } from '@boite/contracts';
import { assertAllowed } from '../src/access.ts';
import { WorktreeCleanup } from '../src/worktree-cleanup.ts';
import { worktreeRoot } from '../src/worktree.ts';
import { startTestCore, type TestCore } from './harness.ts';
import type { CoreClient } from '../src/client.ts';
import { rejection } from './settle.ts';

let harness: TestCore;
let client: CoreClient;
let cleanup: WorktreeCleanup;
let restoreSpawn: (() => void) | undefined;

beforeEach(async () => {
  harness = await startTestCore();
  client = await harness.connect();
  // The core's own pass waits five minutes; the test runs one with no grace.
  cleanup = new WorktreeCleanup(harness.core, { graceMs: 0, startDelayMs: 3_600_000 });
});

afterEach(async () => {
  restoreSpawn?.();
  restoreSpawn = undefined;
  await cleanup.close();
  await harness.stop();
});

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
  return run.stdout.toString().trim();
}

async function repoProject(): Promise<{ id: string; path: string }> {
  const path = join(harness.dataDir, 'repo');
  mkdirSync(path, { recursive: true });
  git(path, 'init', '-q', '-b', 'main');
  writeFileSync(join(path, 'README.md'), 'hello\n');
  git(path, 'add', 'README.md');
  git(path, 'commit', '-q', '-m', 'init');
  git(path, 'remote', 'add', 'origin', 'https://github.com/example/repo.git');
  return client.call('projects.add', { path, name: 'repo' });
}

async function worktreeThread(project: { id: string }, title: string): Promise<ThreadSummary> {
  const account = (await client.call('accounts.list', {})).find((entry) => entry.providerId === 'echo');
  if (account === undefined) throw new Error('no echo account');
  return client.call('threads.create', { projectId: project.id, providerId: 'echo', accountId: account.id, title, worktree: {} });
}

/** A commit only this worktree's branch has, as an agent's work before a squash merge. */
function commitWork(cwd: string): string {
  writeFileSync(join(cwd, 'work.txt'), 'done\n');
  git(cwd, 'add', 'work.txt');
  git(cwd, 'commit', '-q', '-m', 'work');
  return git(cwd, 'rev-parse', 'HEAD');
}

/** Dates the worktree's `.git` file and its admin folder's HEAD, index and HEAD log two hours back. */
function ageGitFiles(cwd: string): void {
  const old = (Date.now() - 2 * 3_600_000) / 1000;
  const admin = git(cwd, 'rev-parse', '--absolute-git-dir');
  for (const path of [join(cwd, '.git'), join(admin, 'HEAD'), join(admin, 'index'), join(admin, 'logs', 'HEAD')]) {
    if (existsSync(path)) utimesSync(path, old, old);
  }
}

function branches(project: { path: string }): string[] {
  return git(project.path, 'branch', '--format=%(refname:short)').split('\n').filter(Boolean);
}

async function summary(threadId: string): Promise<ThreadSummary> {
  const found = (await client.call('threads.list', { includeArchived: true })).find((thread) => thread.id === threadId);
  if (found === undefined) throw new Error(`${threadId} not listed`);
  return found;
}

/** `gh pr list` answers this merged pull request for any branch it is asked about. */
function mergedPullRequest(branch: string, sha: string, during?: () => void): { calls: () => number } {
  let calls = 0;
  const spawn = harness.core.procs.spawn.bind(harness.core.procs);
  const replacement = spyOn(harness.core.procs, 'spawn').mockImplementation((scope, command, args, options) => {
    if (command !== 'gh') return spawn(scope, command, args, options);
    calls++;
    during?.();
    const pr = { number: 12, url: 'https://github.com/example/repo/pull/12', state: 'MERGED', headRefName: branch, headRefOid: sha, headRepository: { name: 'repo' }, headRepositoryOwner: { login: 'example' }, isCrossRepository: false, mergedAt: '2026-10-15T10:00:00Z' };
    return spawn(scope, process.execPath, ['-e', `console.log(${JSON.stringify(JSON.stringify([pr]))})`], options);
  });
  restoreSpawn = () => replacement.mockRestore();
  return { calls: () => calls };
}

describe('settled worktree cleanup', () => {
  test('keeps a Done conversation checkout until its prompt finishes, even with no tracked process', async () => {
    const project = await repoProject();
    const thread = await worktreeThread(project, 'Finishing in Done');
    const sha = commitWork(thread.cwd);
    mergedPullRequest(thread.branch!, sha);
    const journal = harness.core.journal;
    journal.putThread({ ...journal.getThread(thread.id)!, archived: true, archivedAt: 1, doneAt: 1, status: 'running' });
    expect(harness.core.procs.liveCount(thread.id)).toBe(0);
    expect(await cleanup.run()).toEqual([]);
    expect(existsSync(thread.cwd)).toBe(true);
    journal.putThread({ ...journal.getThread(thread.id)!, status: 'idle' });
    expect(await cleanup.run()).toEqual([expect.objectContaining({ projectId: project.id, branch: thread.branch, reason: 'pr-merged' })]);
    expect(existsSync(thread.cwd)).toBe(false);
  });

  test('keeps a worktree whose conversation is restored while the merge proof is read', async () => {
    const project = await repoProject();
    const thread = await worktreeThread(project, 'Restored meanwhile');
    const sha = commitWork(thread.cwd);
    await client.call('threads.archive', { threadId: thread.id });
    const gh = mergedPullRequest(thread.branch!, sha, () => harness.core.journal.putThread({ ...harness.core.journal.getThread(thread.id)!, archived: false }));
    expect(await cleanup.run()).toEqual([]);
    expect(gh.calls()).toBeGreaterThan(0);
    expect(existsSync(thread.cwd)).toBe(true);
  });

  test('removes an archived thread\'s clean worktree with its branch, and the restored thread says so', async () => {
    const project = await repoProject();
    const thread = await worktreeThread(project, 'Settled');
    await client.call('threads.archive', { threadId: thread.id });

    const removed = await cleanup.run();
    expect(removed).toEqual([expect.objectContaining({ path: expect.any(String), reason: 'clean', branch: thread.branch, branchDeleted: true })]);
    expect(existsSync(thread.cwd)).toBe(false);
    expect(branches(project)).toEqual(['main']);
    expect((await summary(thread.id)).worktreeRemoved).toMatchObject({ path: thread.cwd, reason: 'clean', branch: thread.branch, branchDeleted: true });

    const restored = await client.call('threads.archive', { threadId: thread.id, archived: false });
    expect(restored.worktreeRemoved).toMatchObject({ path: thread.cwd, reason: 'clean' });
    expect((await rejection(client.call('turns.start', { threadId: thread.id, prompt: 'still there?' }))).reason).toMatchObject({
      rpc: { message: expect.stringContaining(thread.cwd) },
    });
  });

  test('a squash-merged head goes with its branch once the merged pull request names that exact commit', async () => {
    const project = await repoProject();
    const thread = await worktreeThread(project, 'Squashed');
    const sha = commitWork(thread.cwd);
    const branch = git(thread.cwd, 'branch', '--show-current');
    await client.call('threads.archive', { threadId: thread.id });
    const gh = mergedPullRequest(branch, sha);

    expect(await cleanup.run()).toEqual([expect.objectContaining({ reason: 'pr-merged', branch, branchDeleted: true })]);
    expect(gh.calls()).toBeGreaterThan(0);
    expect(existsSync(thread.cwd)).toBe(false);
    expect(branches(project)).toEqual(['main']);
    expect((await summary(thread.id)).worktreeRemoved).toMatchObject({ reason: 'pr-merged', pullRequest: { number: 12, url: 'https://github.com/example/repo/pull/12' } });
  });

  test('keeps an unmerged head when the merged pull request names another commit', async () => {
    const project = await repoProject();
    const thread = await worktreeThread(project, 'Moved on');
    const merged = commitWork(thread.cwd);
    writeFileSync(join(thread.cwd, 'later.txt'), 'after the merge\n');
    git(thread.cwd, 'add', 'later.txt');
    git(thread.cwd, 'commit', '-q', '-m', 'later');
    await client.call('threads.archive', { threadId: thread.id });
    mergedPullRequest(git(thread.cwd, 'branch', '--show-current'), merged);

    expect(await cleanup.run()).toEqual([]);
    expect(existsSync(thread.cwd)).toBe(true);
    expect((await summary(thread.id)).worktreeRemoved ?? null).toBeNull();
  });

  test('keeps a live thread\'s worktree, a fresh archive, a dirty one, an unproved one and a project that turned it off', async () => {
    const project = await repoProject();
    const live = await worktreeThread(project, 'Live');
    const dirty = await worktreeThread(project, 'Dirty');
    writeFileSync(join(dirty.cwd, 'notes.txt'), 'unsaved\n');
    const unproved = await worktreeThread(project, 'Unproved');
    commitWork(unproved.cwd);
    const fresh = await worktreeThread(project, 'Fresh');
    for (const thread of [dirty, unproved, fresh]) await client.call('threads.archive', { threadId: thread.id });
    // A fresh archive waits out the grace; every other one here has none.
    const graceful = new WorktreeCleanup(harness.core, { graceMs: 3_600_000, startDelayMs: 3_600_000 });
    expect(await graceful.run()).toEqual([]);
    await graceful.close();

    // No gh: an unmerged head without a proof stays.
    expect((await cleanup.run()).map((entry) => entry.path)).toEqual([expect.stringContaining(fresh.cwd.split(/[\\/]/).pop()!)]);
    for (const thread of [live, dirty, unproved]) expect(existsSync(thread.cwd)).toBe(true);

    const off = await worktreeThread(project, 'Off');
    await client.call('threads.archive', { threadId: off.id });
    const updated = await client.call('projects.setAutoRemoveWorktrees', { projectId: project.id, enabled: false });
    expect(updated.autoRemoveWorktrees).toBe(false);
    expect(await cleanup.run()).toEqual([]);
    expect(existsSync(off.cwd)).toBe(true);
  });

  test('a worktree no thread stands in goes only on a boite branch, outside a reservation, an hour after git last touched it', async () => {
    const project = await repoProject();
    const root = worktreeRoot(project.path);
    const orphan = join(root, 'orphan');
    git(project.path, 'worktree', 'add', '-q', '-b', 'boite/orphan', orphan);
    const recent = join(root, 'recent');
    git(project.path, 'worktree', 'add', '-q', '-b', 'boite/recent', recent);
    const mine = join(root, 'mine');
    git(project.path, 'worktree', 'add', '-q', '-b', 'feature/mine', mine);
    const elsewhere = join(harness.dataDir, 'elsewhere');
    git(project.path, 'worktree', 'add', '-q', '-b', 'boite/elsewhere', elsewhere);
    for (const path of [orphan, mine, elsewhere]) ageGitFiles(path);
    // Made two hours ago, but its HEAD, index and HEAD log moved just now: an agent still works in it.
    const active = join(root, 'active');
    git(project.path, 'worktree', 'add', '-q', '-b', 'boite/active', active);
    const old = (Date.now() - 2 * 3_600_000) / 1000;
    utimesSync(join(active, '.git'), old, old);

    const hourly = new WorktreeCleanup(harness.core, { graceMs: 3_600_000, startDelayMs: 3_600_000 });
    expect((await hourly.run()).map((entry) => entry.branch)).toEqual(['boite/orphan']);
    await hourly.close();
    expect(existsSync(orphan)).toBe(false);
    for (const path of [recent, mine, elsewhere, active]) expect(existsSync(path)).toBe(true);
  });

  test('a worktree no thread stands in stays while a live thread links an open pull request on its branch', async () => {
    const project = await repoProject();
    const linked = join(worktreeRoot(project.path), 'linked');
    git(project.path, 'worktree', 'add', '-q', '-b', 'boite/linked', linked);
    ageGitFiles(linked);
    // A delegated worker runs in another folder, made the worktree with git and linked its pull request.
    const account = (await client.call('accounts.list', {})).find((entry) => entry.providerId === 'echo');
    if (account === undefined) throw new Error('no echo account');
    const worker = await client.call('threads.create', { projectId: project.id, providerId: 'echo', accountId: account.id, title: 'Worker' });
    harness.core.journal.setSetting(`linked-pull-requests:${worker.id}`, [{
      url: 'https://github.com/example/repo/pull/7', repository: 'example/repo', number: 7, title: 'work', state: 'OPEN', draft: false,
      head: 'boite/linked', base: 'main', headRepository: 'example/repo', checkedAt: Date.now(),
    }]);

    const hourly = new WorktreeCleanup(harness.core, { graceMs: 3_600_000, startDelayMs: 3_600_000 });
    expect(await hourly.run()).toEqual([]);
    expect(existsSync(linked)).toBe(true);
    await hourly.close();

    // Once the worker is archived, the abandoned worktree goes as before.
    await client.call('threads.archive', { threadId: worker.id });
    const later = new WorktreeCleanup(harness.core, { graceMs: 3_600_000, startDelayMs: 3_600_000 });
    expect((await later.run()).map((entry) => entry.branch)).toEqual(['boite/linked']);
    await later.close();
    expect(existsSync(linked)).toBe(false);
  });

  test('an open pull request claims a worktree only from a repository the project fetches', async () => {
    const project = await repoProject();
    git(project.path, 'remote', 'add', 'fork', 'git@github.com:me/repo.git');
    const account = (await client.call('accounts.list', {})).find((entry) => entry.providerId === 'echo');
    if (account === undefined) throw new Error('no echo account');
    const worker = await client.call('threads.create', { projectId: project.id, providerId: 'echo', accountId: account.id, title: 'Worker' });
    const link = (url: string, head: string, headRepository: string) => ({
      url, repository: url.split('/').slice(3, 5).join('/'), number: Number(url.split('/').pop()), title: 'work', state: 'OPEN', draft: false,
      head, base: 'main', headRepository, checkedAt: Date.now(),
    });
    const worktrees = Object.fromEntries(['unrelated', 'forked', 'unnamed'].map((slug) => {
      const path = join(worktreeRoot(project.path), slug);
      git(project.path, 'worktree', 'add', '-q', '-b', `boite/${slug}`, path);
      ageGitFiles(path);
      return [slug, path];
    }));
    harness.core.journal.setSetting(`linked-pull-requests:${worker.id}`, [
      // Another repository's branch of the same name claims nothing here.
      link('https://github.com/other/unrelated/pull/1', 'boite/unrelated', 'other/unrelated'),
      // A pull request from the project's fork, and one whose head repository GitHub no longer names.
      link('https://github.com/example/repo/pull/2', 'boite/forked', 'me/repo'),
      link('https://github.com/example/repo/pull/3', 'boite/unnamed', ''),
    ]);
    const hourly = new WorktreeCleanup(harness.core, { graceMs: 3_600_000, startDelayMs: 3_600_000 });
    expect((await hourly.run()).map((entry) => entry.branch)).toEqual(['boite/unrelated']);
    await hourly.close();
    expect(existsSync(worktrees.unrelated!)).toBe(false);
    expect(existsSync(worktrees.forked!)).toBe(true);
    expect(existsSync(worktrees.unnamed!)).toBe(true);
  });

  test('the project policy is on by default, owner only, and refuses anything but a boolean', async () => {
    const project = await repoProject();
    expect((await client.call('projects.list', {})).find((entry) => entry.id === project.id)?.autoRemoveWorktrees).toBe(true);
    expect((await rejection(client.call('projects.setAutoRemoveWorktrees', { projectId: project.id, enabled: 'no' as unknown as boolean }))).reason).toMatchObject({
      rpc: { data: expect.objectContaining({ field: 'enabled' }) },
    });
    expect((await client.call('projects.setAutoRemoveWorktrees', { projectId: project.id, enabled: true })).autoRemoveWorktrees).toBe(true);
    for (const principal of ['session', 'agent'] as const) {
      expect(() => assertAllowed('projects.setAutoRemoveWorktrees', { identity: { principal, threadId: 'thr_fixture', sessionId: 'fixture' } } as never, { projectId: project.id, enabled: false })).toThrow();
    }
  });
});

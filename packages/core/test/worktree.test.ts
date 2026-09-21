import { existsSync, mkdirSync, realpathSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { slugOf, worktreeRoot } from '../src/worktree.ts';
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
  const run = Bun.spawnSync({
    cmd: ['git', ...args],
    cwd,
    env: FIXTURE_GIT_ENV,
    stdout: 'pipe',
    stderr: 'pipe',
    windowsHide: true,
  });
  if (!run.success) throw new Error(`git ${args.join(' ')} failed: ${run.stderr.toString()}`);
  return run.stdout.toString();
}

/** A repository with one commit inside the test data directory, so its worktrees land in the data directory too. */
async function repoProject(name = 'repo'): Promise<{ id: string; path: string }> {
  const path = join(harness.dataDir, name);
  mkdirSync(path, { recursive: true });
  git(path, 'init', '-q');
  git(path, 'commit', '-q', '--allow-empty', '-m', 'init');
  return client.call('projects.add', { path, name });
}

async function echoAccount(): Promise<string> {
  const accounts = await client.call('accounts.list', {});
  const account = accounts.find((entry) => entry.providerId === 'echo');
  if (account === undefined) throw new Error('no echo account');
  return account.id;
}

describe('a thread in its own worktree', () => {
  test('workspace recovery adopts the registered directory through a parent alias', async () => {
    const root = join(harness.dataDir, 'real');
    mkdirSync(root);
    const project = await repoProject(join('real', 'repo'));
    const row = harness.core.projects.require(project.id);
    const branch = 'boite/recovered-agent';
    const original = await harness.core.worktrees.ensure('thr_recover', row, branch);
    const alias = join(harness.dataDir, 'alias');
    symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
    try {
      const adopted = await harness.core.worktrees.ensure('thr_recover', { ...row, path: join(alias, 'repo') }, branch);
      expect(realpathSync(adopted.path)).toBe(realpathSync(original.path));
      expect(adopted.branch).toBe(branch);
      expect(git(project.path, 'worktree', 'list', '--porcelain').split(`branch refs/heads/${branch}`)).toHaveLength(2);
    } finally { unlinkSync(alias); }
  });

  test('the slug and the root are what name the branch and its directory', () => {
    expect(slugOf('Fix the login: retry on 401!')).toBe('fix-the-login-retry-on-401');
    expect(slugOf('   ')).toBe('thread');
    expect(slugOf('a'.repeat(60))).toBe('a'.repeat(40));
    expect(worktreeRoot(join('D:', 'Dev', 'boite'))).toBe(join('D:', 'Dev', '.boite-worktrees', 'boite'));
  });

  test('the branch is boite/<slug>, the worktree is beside the repository, and the journal keeps both', async () => {
    const project = await repoProject();
    const accountId = await echoAccount();
    const thread = await client.call('threads.create', {
      projectId: project.id,
      providerId: 'echo',
      accountId,
      title: 'Fix the login',
      worktree: {},
    });
    expect(thread.branch).toBe('boite/fix-the-login');
    expect(thread.cwd).toBe(join(worktreeRoot(project.path), 'fix-the-login'));
    expect(existsSync(join(thread.cwd, '.git'))).toBe(true);
    expect(git(project.path, 'worktree', 'list', '--porcelain')).toContain('branch refs/heads/boite/fix-the-login');
    expect(harness.core.journal.getThread(thread.id)?.branch).toBe('boite/fix-the-login');
    expect(harness.core.journal.getThread(thread.id)?.cwd).toBe(thread.cwd);
    // The git calls ran under the thread's id, so the trace has them.
    const processes = await client.call('trace.get', { threadId: thread.id });
    expect(processes.some((record) => record.exe === 'git')).toBe(true);
  });

  test('a second thread with the same title gets -2, and a wanted branch is honoured or refused', async () => {
    const project = await repoProject();
    const accountId = await echoAccount();
    const base = { projectId: project.id, providerId: 'echo' as const, accountId, title: 'Fix the login' };
    await client.call('threads.create', { ...base, worktree: {} });
    const second = await client.call('threads.create', { ...base, worktree: {} });
    expect(second.branch).toBe('boite/fix-the-login-2');
    expect(second.cwd).toBe(join(worktreeRoot(project.path), 'fix-the-login-2'));

    const named = await client.call('threads.create', { ...base, worktree: { branch: 'feature/retry' } });
    expect(named.branch).toBe('feature/retry');
    expect(named.cwd).toBe(join(worktreeRoot(project.path), 'feature-retry'));

    await expect(client.call('threads.create', { ...base, worktree: { branch: 'feature/retry' } })).rejects.toThrow(
      'branch feature/retry already exists',
    );
    await expect(client.call('threads.create', { ...base, worktree: { branch: 'two words' } })).rejects.toThrow(
      'not a branch name',
    );
    await expect(client.call('threads.create', { ...base, cwd: project.path, worktree: {} })).rejects.toThrow(
      'cwd and worktree exclude each other',
    );
  });

  test('a project that is not a git repository is refused by path, and no thread is written', async () => {
    const path = join(harness.dataDir, 'plain');
    mkdirSync(path, { recursive: true });
    const project = await client.call('projects.add', { path, name: 'plain' });
    const accountId = await echoAccount();
    await expect(
      client.call('threads.create', { projectId: project.id, providerId: 'echo', accountId, title: 'x', worktree: {} }),
    ).rejects.toThrow(`${path} is not a git repository`);
    expect(await client.call('threads.list', {})).toHaveLength(0);
    expect(existsSync(worktreeRoot(path))).toBe(false);
  });

  test('a model nobody offers is refused before any worktree exists', async () => {
    const project = await repoProject();
    const accountId = await echoAccount();
    // The check used to run after `git worktree add`, so a typo in the model
    // left a branch and a directory behind with no thread pointing at them.
    await expect(
      client.call('threads.create', {
        projectId: project.id,
        providerId: 'echo',
        accountId,
        title: 'Fix the login',
        model: 'no-such-model',
        worktree: {},
      }),
    ).rejects.toThrow('the provider does not offer this model');
    expect(existsSync(worktreeRoot(project.path))).toBe(false);
    expect(git(project.path, 'branch', '--list', 'boite/fix-the-login').trim()).toBe('');
    expect(await client.call('threads.list', {})).toHaveLength(0);
  });

  test('rolling a worktree back takes its directory, its branch and its registration', async () => {
    const project = await repoProject();
    const row = harness.core.projects.require(project.id);
    const threadId = 'thr_rollback';
    const placed = await harness.core.worktrees.add(threadId, row, 'Fix the login');
    expect(existsSync(placed.path)).toBe(true);

    await harness.core.worktrees.remove(threadId, row, placed);
    expect(existsSync(placed.path)).toBe(false);
    expect(git(project.path, 'branch', '--list', placed.branch).trim()).toBe('');
    expect(git(project.path, 'worktree', 'list', '--porcelain')).not.toContain(placed.branch);
  });

  test('a thread without the option keeps working in the project itself', async () => {
    const project = await repoProject();
    const accountId = await echoAccount();
    const thread = await client.call('threads.create', { projectId: project.id, providerId: 'echo', accountId, title: 'plain' });
    expect(thread.branch).toBeNull();
    expect(thread.cwd).toBe(project.path);
    rmSync(worktreeRoot(project.path), { recursive: true, force: true });
  });
});

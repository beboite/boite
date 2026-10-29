import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { slugOf, worktreeRoot } from '../src/worktree.ts';
import { echoDriver } from '../src/drivers/echo.ts';
import { setDriver } from '../src/drivers/index.ts';
import { startTestCore, waitFor } from './harness.ts';
import type { TestCore } from './harness.ts';
import type { CoreClient } from '../src/client.ts';
import { rejection, thrown } from './settle.ts';

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
async function repoProject(name = 'repo'): Promise<{ id: string; path: string; repository?: boolean }> {
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
  test('explicit branch names stop at 48 characters before creating a thread or worktree', async () => {
    const project = await repoProject();
    const base = { projectId: project.id, providerId: 'echo', accountId: await echoAccount() };
    const branch = 'feature/' + 'a'.repeat(41);
    const before = await client.call('threads.list', {});
    expect((await rejection(client.call('threads.create', { ...base, worktree: { branch } }))).reason).toMatchObject({
      rpc: { data: { field: 'branch', maxLength: 48, actualLength: 49, expected: 'at most 48 characters' } },
    });
    expect(await client.call('threads.list', {})).toEqual(before);
    expect(git(project.path, 'branch', '--list', branch).trim()).toBe('');
    expect(existsSync(worktreeRoot(project.path))).toBe(false);
    const accepted = await client.call('threads.create', { ...base, worktree: { branch: branch.slice(0, 48) } });
    expect(accepted.branch).toBe(branch.slice(0, 48));
  });

  test('generated branch collision suffixes fit within the full name limit', async () => {
    const project = await repoProject();
    const row = harness.core.projects.require(project.id);
    const placed = await harness.core.worktrees.add('thr_name_limit', row);
    const slug = 'a'.repeat(40);
    for (let n = 1; n <= 9; n += 1) git(project.path, 'branch', `boite/${slug}${n === 1 ? '' : `-${n}`}`);
    const branch = await harness.core.worktrees.nameBranch('thr_name_limit', placed.path, placed.branch, slug);
    expect(branch).toBe(`boite/${'a'.repeat(39)}-10`);
    expect(branch!.length).toBe(48);
    expect(git(placed.path, 'branch', '--show-current').trim()).toBe(branch!);
  });

  test('one title call names the temporary branch while the first turn runs without moving files or losing commits', async () => {
    let titleCalls = 0;
    const releaseTurn = Promise.withResolvers<void>();
    const restore = setDriver('echo', {
      ...echoDriver,
      startTurn: ctx => {
        const handle = echoDriver.startTurn(ctx);
        return {
          ...handle,
          done: handle.done.then(async result => { await releaseTurn.promise; return result; }),
          stop: () => { releaseTurn.resolve(); handle.stop(); },
        };
      },
      title: async ctx => {
        titleCalls += 1;
        expect(ctx.initial).toBe(true);
        expect(ctx.nameBranch).toBe(true);
        return JSON.stringify({ title: 'Noms de worktrees', needsRefinement: false, branch: 'fix-worktree-names' });
      },
    });
    try {
      const project = await repoProject();
      const thread = await client.call('threads.create', {
        projectId: project.id, providerId: 'echo', accountId: await echoAccount(),
        title: 'les noms des worktree sont completement debiles', worktree: {},
      });
      expect(thread.branch).toMatch(/^boite\/wt-[a-z0-9]{8}$/);
      git(thread.cwd, 'commit', '-q', '--allow-empty', '-m', 'keep this work');
      const head = git(thread.cwd, 'rev-parse', 'HEAD');
      writeFileSync(join(thread.cwd, 'pending.txt'), 'keep this edit');
      git(project.path, 'branch', 'boite/fix-worktree-names');
      await client.call('threads.subscribe', { threadId: thread.id });
      const finished = client.next('turn.finished', row => row.threadId === thread.id, 5000);
      const named = client.next('thread.updated', row => row.id === thread.id && row.branch === 'boite/fix-worktree-names-2' && row.titleSource === 'agent', 5000);
      await client.call('turns.start', { threadId: thread.id, prompt: 'Fix worktree naming' });
      expect(await named).toMatchObject({ title: 'Noms de worktrees', cwd: thread.cwd, branchNamingPending: false });
      expect((await client.call('threads.get', { threadId: thread.id })).status).toBe('running');
      releaseTurn.resolve();
      expect((await finished).status).toBe('done');
      expect(titleCalls).toBe(1);
      expect(git(thread.cwd, 'branch', '--show-current').trim()).toBe('boite/fix-worktree-names-2');
      expect(git(thread.cwd, 'rev-parse', 'HEAD')).toBe(head);
      expect(readFileSync(join(thread.cwd, 'pending.txt'), 'utf8')).toBe('keep this edit');
      expect(existsSync(thread.cwd)).toBe(true);
      expect(git(project.path, 'branch', '--list', thread.branch!).trim()).toBe('');
      expect((await client.call('worktrees.list', { projectId: project.id })).find(row => row.threadId === thread.id)?.branch).toBe('boite/fix-worktree-names-2');
    } finally { releaseTurn.resolve(); restore(); }
  });

  test('automatic naming preserves explicitly chosen branches, including temporary-looking names', async () => {
    const project = await repoProject();
    const thread = await client.call('threads.create', {
      projectId: project.id, providerId: 'echo', accountId: await echoAccount(),
      title: 'Fix worktree names', worktree: { branch: 'boite/wt-explicit' },
    });
    await client.call('threads.subscribe', { threadId: thread.id });
    const named = client.next('thread.updated', row => row.id === thread.id && row.titleSource === 'agent', 5000);
    await client.call('turns.start', { threadId: thread.id, prompt: 'Fix worktree names' });
    expect(await named).toMatchObject({ branch: 'boite/wt-explicit', branchNamingPending: false });
    expect(git(thread.cwd, 'branch', '--show-current').trim()).toBe(thread.branch!);
  });

  test('invalid branch output keeps the title and a later retitle can name the worktree', async () => {
    let output = 'Noms de branches\nBranch: ../outside';
    const restore = setDriver('echo', { ...echoDriver, title: async () => output });
    try {
      const project = await repoProject();
      const thread = await client.call('threads.create', {
        projectId: project.id, providerId: 'echo', accountId: await echoAccount(), title: 'Fix naming', worktree: {},
      });
      await client.call('threads.subscribe', { threadId: thread.id });
      const named = client.next('thread.updated', row => row.id === thread.id && row.titleSource === 'agent', 5000);
      await client.call('turns.start', { threadId: thread.id, prompt: 'Fix naming' });
      expect(await named).toMatchObject({ title: 'Noms de branches', branch: thread.branch, branchNamingPending: true });
      expect(git(thread.cwd, 'branch', '--show-current').trim()).toBe(thread.branch!);
      output = 'Noms de branches\nBranch: fix-naming';
      expect(await client.call('threads.retitle', { threadId: thread.id })).toMatchObject({ branch: 'boite/fix-naming', cwd: thread.cwd, branchNamingPending: false });
    } finally { restore(); }
  });

  test('naming does not change an agent-renamed branch or a published temporary branch', async () => {
    const project = await repoProject();
    const row = harness.core.projects.require(project.id);
    const placed = await harness.core.worktrees.add('thr_git_names', row);
    git(placed.path, 'branch', '-m', 'feature/chosen-by-agent');
    expect(await harness.core.worktrees.nameBranch('thr_git_names', placed.path, placed.branch, 'generated')).toBeNull();
    expect(git(placed.path, 'branch', '--show-current').trim()).toBe('feature/chosen-by-agent');
    git(placed.path, 'branch', '-m', placed.branch);
    git(project.path, 'update-ref', `refs/remotes/origin/${placed.branch}`, 'HEAD');
    expect(await harness.core.worktrees.nameBranch('thr_git_names', placed.path, placed.branch, 'generated')).toBeNull();
    git(project.path, 'update-ref', '-d', `refs/remotes/origin/${placed.branch}`);
    git(project.path, 'remote', 'add', 'origin', project.path);
    git(project.path, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    git(placed.path, 'branch', '--set-upstream-to=origin/main');
    expect(await harness.core.worktrees.nameBranch('thr_git_names', placed.path, placed.branch, 'generated')).toBeNull();
    expect(git(placed.path, 'branch', '--show-current').trim()).toBe(placed.branch);
  });

  test('workspace recovery reattaches a surviving legacy long branch after its directory was removed', async () => {
    const project = await repoProject();
    const row = harness.core.projects.require(project.id);
    const branch = 'boite/' + 'recovered-directory-'.repeat(5);
    const original = { path: join(worktreeRoot(project.path), 'legacy'), branch };
    git(project.path, 'worktree', 'add', '-b', branch, original.path);
    git(original.path, 'commit', '-q', '--allow-empty', '-m', 'work to preserve');
    const head = git(original.path, 'rev-parse', 'HEAD');
    git(project.path, 'worktree', 'remove', original.path);
    const recovered = await harness.core.worktrees.ensure('thr_recover', row, branch, original.path);
    expect(git(recovered.path, 'rev-parse', 'HEAD')).toBe(head);
  });
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
    expect(worktreeRoot(join('D:', 'Dev', 'boite'))).toBe(join('D:', 'Dev', 'boite', '.boite', 'worktrees'));
  });

  test('the worktree lives inside the project without dirtying it, and the journal keeps its branch and path', async () => {
    const project = await repoProject();
    const accountId = await echoAccount();
    const thread = await client.call('threads.create', {
      projectId: project.id,
      providerId: 'echo',
      accountId,
      title: 'Fix the login',
      worktree: {},
    });
    expect(thread.branch).toMatch(/^boite\/wt-[a-z0-9]{8}$/);
    const directory = thread.branch!.slice('boite/'.length);
    expect(thread.cwd).toBe(join(worktreeRoot(project.path), directory));
    expect(existsSync(join(thread.cwd, '.git'))).toBe(true);
    expect(thread.cwd).toBe(join(project.path, '.boite', 'worktrees', directory));
    expect(git(project.path, 'status', '--porcelain')).toBe('');
    expect(git(project.path, 'worktree', 'list', '--porcelain')).toContain(`branch refs/heads/${thread.branch}`);
    expect(harness.core.journal.getThread(thread.id)?.branch).toBe(thread.branch);
    expect(harness.core.journal.getThread(thread.id)?.cwd).toBe(thread.cwd);
    // The git calls ran under the thread's id, so the trace has them.
    const processes = await client.call('trace.get', { threadId: thread.id });
    expect(processes.some((record) => record.exe === 'git')).toBe(true);
  });

  test('a new worktree checks out with one worker per core unless the repository config names a count, asked once per repository', async () => {
    const accountId = await echoAccount();
    const calls: string[][] = [];
    const spawn = harness.core.procs.spawn.bind(harness.core.procs);
    const spy = spyOn(harness.core.procs, 'spawn').mockImplementation((scope, command, args, options) => {
      if (command === 'git') calls.push(args);
      return spawn(scope, command, args, options);
    });
    try {
      const open = await repoProject('open');
      // The machine's own config is the user's: a count set there must stand too.
      const presetByMachine = Bun.spawnSync({ cmd: ['git', 'config', '--get', 'checkout.workers'], cwd: open.path }).exitCode === 0;
      for (const title of ['one', 'two']) await client.call('threads.create', { projectId: open.id, providerId: 'echo', accountId, title, worktree: {} });
      const adds = calls.filter((args) => args.includes('worktree') && args.includes('add'));
      expect(adds).toHaveLength(2);
      for (const args of adds) expect(args.slice(0, 2)).toEqual(presetByMachine ? ['worktree', 'add'] : ['-c', 'checkout.workers=0']);
      expect(calls.filter((args) => args.join(' ') === 'config --get checkout.workers')).toHaveLength(1);

      calls.length = 0;
      const pinned = await repoProject('pinned');
      git(pinned.path, 'config', 'checkout.workers', '2');
      await client.call('threads.create', { projectId: pinned.id, providerId: 'echo', accountId, title: 'three', worktree: {} });
      const pinnedAdd = calls.find((args) => args.includes('worktree') && args.includes('add'));
      expect(pinnedAdd?.slice(0, 2)).toEqual(['worktree', 'add']);
    } finally {
      spy.mockRestore();
    }
  });

  test('a branch name git could not look up is refused, not taken as free', async () => {
    const accountId = await echoAccount();
    const project = await repoProject('lookup');
    const spawn = harness.core.procs.spawn.bind(harness.core.procs);
    // The lookup fails the way a damaged repository does: exit 128, not the 1 of an absent ref.
    const spy = spyOn(harness.core.procs, 'spawn').mockImplementation((scope, command, args, options) =>
      spawn(scope, command, command === 'git' && args.includes('rev-parse') && args.some((arg) => arg.startsWith('refs/heads/')) ? ['--git-dir=/nonexistent', ...args] : args, options));
    try {
      expect(await thrown(client.call('threads.create', { projectId: project.id, providerId: 'echo', accountId, title: 'lookup', worktree: {} })))
        .toThrow('cannot tell whether branch boite/');
    } finally {
      spy.mockRestore();
    }
    expect(git(project.path, 'worktree', 'list', '--porcelain')).not.toContain('refs/heads/boite/');
  });

  test('concurrent registrations share the repository gate across linked checkouts but leave other repositories free', async () => {
    const project = await repoProject('registration'), other = await repoProject('independent');
    const row = harness.core.projects.require(project.id), otherRow = harness.core.projects.require(other.id);
    const linked = await harness.core.worktrees.add('thr_linked', row, 'boite/linked');
    const paused = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const spawn = harness.core.procs.spawn.bind(harness.core.procs);
    const firstPath = harness.core.worktrees.pathFor(row, 'boite/registration-first');
    let cancelledSpawns = 0;
    const spy = spyOn(harness.core.procs, 'spawn').mockImplementation((threadId, command, args, options) => {
      if (threadId === 'thr_registration_cancelled') cancelledSpawns++;
      const child = spawn(threadId, command, args, options);
      if (command !== 'git' || !args.includes('add') || !args.includes('boite/registration-first')) return child;
      return {...child, exited: child.exited.then(async code => {
        if (code !== 0) {paused.reject(new Error('first registration failed')); return code;}
        // Reproduce Git's visible half-written commondir before registration completes.
        const file = join(project.path, '.git', 'worktrees', basename(firstPath), 'commondir');
        const saved = readFileSync(file);
        writeFileSync(file, ''); paused.resolve();
        try {await release.promise;} finally {writeFileSync(file, saved);}
        return code;
      })};
    });
    const first = harness.core.worktrees.add('thr_registration_first', row, 'boite/registration-first');
    const completed = Promise.allSettled([first]);
    let results: Awaited<ReturnType<typeof Promise.allSettled>> = [];
    try {
      await paused.promise;
      let active = true;
      const cancelled = harness.core.worktrees.ensure('thr_registration_cancelled', row, linked.branch, linked.path,
        {beforeMutation() {}, assertActive() {if (!active) throw new Error('queued registration cancelled');}});
      const cancelledResult = Promise.allSettled([cancelled]); active = false;
      // Expiry must return while the first owner is still paused, without releasing its slot.
      const expired = harness.core.worktrees.ensure('thr_registration_expired', row, linked.branch, linked.path,
        {beforeMutation() {}, assertActive() {}, timeoutMs: 10});
      expect(await thrown(expired)).toThrow('did not finish within 10 ms');
      const same = harness.core.worktrees.add('thr_registration_second', {...row, path: linked.path}, 'boite/registration-second');
      const registrations = Promise.allSettled([first, same]);
      let independentDone = false;
      const independent = harness.core.worktrees.add('thr_registration_other', otherRow, 'boite/registration-other')
        .finally(() => {independentDone = true;});
      const independentResult = Promise.allSettled([independent]);
      try {await waitFor(() => independentDone, 5000);} finally {release.resolve();}
      results = [...await registrations, ...await independentResult];
      const [cancelledOutcome] = await cancelledResult;
      expect(cancelledOutcome).toMatchObject({status: 'rejected', reason: new Error('queued registration cancelled')});
      expect(cancelledSpawns).toBe(0);
    } finally {release.resolve(); await completed; spy.mockRestore();}
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled']);
    expect(git(project.path, 'worktree', 'list', '--porcelain')).toContain('branch refs/heads/boite/registration-second');
    // A rejected registration releases its slot instead of poisoning later work.
    const recovery = await Promise.allSettled([
      harness.core.worktrees.add('thr_registration_bad', row, 'boite/registration-bad', undefined, undefined, 'missing-base'),
      harness.core.worktrees.add('thr_registration_after', row, 'boite/registration-after'),
    ]);
    expect(recovery.map(result => result.status)).toEqual(['rejected', 'fulfilled']);
  });

  test('storage changes affect new worktrees only and separate repositories with the same name', async () => {
    const first = await repoProject('one/repo');
    const second = await repoProject('two/repo');
    const accountId = await echoAccount();
    const create = (projectId: string, title: string) => client.call('threads.create', { projectId, title, providerId: 'echo', accountId, worktree: {} });
    const original = await create(first.id, 'Original');
    const directory = join(harness.dataDir, 'shared');
    await client.call('settings.set', { worktreeStorage: { mode: 'shared', directory } });
    const a = await create(first.id, 'Same title');
    const b = await create(second.id, 'Same title');
    expect(a.cwd.startsWith(directory)).toBe(true);
    expect(b.cwd.startsWith(directory)).toBe(true);
    expect(a.cwd).not.toBe(b.cwd);
    expect(harness.core.threads.require(original.id).cwd).toBe(original.cwd);
    expect(existsSync(original.cwd)).toBe(true);
    await client.call('settings.set', { worktreeStorage: { mode: 'project', directory } });
    const back = await create(first.id, 'Back');
    expect(back.cwd).toBe(join(first.path, '.boite', 'worktrees', back.branch!.slice('boite/'.length)));
    const listed = (await client.call('worktrees.list', { projectId: first.id })).find(w => w.branch === a.branch);
    if (!listed) throw new Error(`shared worktree ${a.branch} was not listed`);
    // Bun's realpath preserves Windows 8.3 aliases; compare the directory identity.
    const actual = statSync(listed.path, { bigint: true });
    const expected = statSync(a.cwd, { bigint: true });
    expect([actual.dev, actual.ino]).toEqual([expected.dev, expected.ino]);
    expect(harness.core.journal.getSetting('settings')).toMatchObject({ worktreeStorage: { mode: 'project', directory } });
  });

  test('a shared folder inside the project escapes literal characters in its Git exclusion', async () => {
    const project = await repoProject();
    const name = process.platform === 'win32' ? 'shared [work] !' : 'shared \\[work] !';
    const directory = join(project.path, name);
    await client.call('settings.set', { worktreeStorage: { mode: 'shared', directory } });
    const accountId = await echoAccount();
    await client.call('threads.create', { projectId: project.id, providerId: 'echo', accountId, title: 'Nested', worktree: {} });
    expect(git(project.path, 'status', '--porcelain')).toBe('');
  });

  test('identical prompts get distinct short names, and a wanted branch is honoured or refused', async () => {
    const project = await repoProject();
    const accountId = await echoAccount();
    const base = { projectId: project.id, providerId: 'echo' as const, accountId, title: 'Fix the login' };
    const first = await client.call('threads.create', { ...base, worktree: {} });
    const second = await client.call('threads.create', { ...base, worktree: {} });
    expect(second.branch).toMatch(/^boite\/wt-[a-z0-9]{8}$/);
    expect(second.branch).not.toBe(first.branch);
    expect(second.cwd).not.toBe(first.cwd);
    expect(second.cwd).toBe(join(worktreeRoot(project.path), second.branch!.slice('boite/'.length)));

    const named = await client.call('threads.create', { ...base, worktree: { branch: 'feature/retry' } });
    expect(named.branch).toBe('feature/retry');
    expect(named.branchNamingPending).toBe(false);
    expect(named.cwd).toBe(join(worktreeRoot(project.path), 'feature-retry'));

    expect(await thrown(client.call('threads.create', { ...base, worktree: { branch: 'feature/retry' } }))).toThrow(
      'branch feature/retry already exists',
    );
    expect(await thrown(client.call('threads.create', { ...base, worktree: { branch: 'two words' } }))).toThrow(
      'not a branch name',
    );
    expect(await thrown(client.call('threads.create', { ...base, cwd: project.path, worktree: {} }))).toThrow(
      'cwd and worktree exclude each other',
    );
  });

  test('a project that is not a git repository is refused by path, and no thread is written', async () => {
    const path = join(harness.dataDir, 'plain');
    mkdirSync(path, { recursive: true });
    const project = await client.call('projects.add', { path, name: 'plain' });
    const accountId = await echoAccount();
    expect(await thrown(client.call('threads.create', { projectId: project.id, providerId: 'echo', accountId, title: 'x', worktree: {} }))).toThrow(`${path} is not a git repository`);
    expect(await client.call('threads.list', {})).toHaveLength(0);
    expect(existsSync(worktreeRoot(path))).toBe(false);
  });

  test('a project says whether it is a repository, on add and on list, by the test the worktree refuses on', async () => {
    const plainPath = join(harness.dataDir, 'plain');
    mkdirSync(plainPath, { recursive: true });
    const plain = await client.call('projects.add', { path: plainPath, name: 'plain' });
    const repo = await repoProject();
    expect(plain.repository).toBe(false);
    expect(repo.repository).toBe(true);
    const listed = await client.call('projects.list', {});
    expect(listed.find((project) => project.id === plain.id)?.repository).toBe(false);
    expect(listed.find((project) => project.id === repo.id)?.repository).toBe(true);
    // Checked on each answer: a folder that becomes a repository says so next time.
    git(plainPath, 'init', '-q');
    expect((await client.call('projects.list', {})).find((project) => project.id === plain.id)?.repository).toBe(true);
  });

  test('a model nobody offers is refused before any worktree exists', async () => {
    const project = await repoProject();
    const accountId = await echoAccount();
    // The check used to run after `git worktree add`, so a typo in the model
    // left a branch and a directory behind with no thread pointing at them.
    expect(await thrown(client.call('threads.create', {
        projectId: project.id,
        providerId: 'echo',
        accountId,
        title: 'Fix the login',
        model: 'no-such-model',
        worktree: {},
      }))).toThrow('the provider does not offer this model');
    expect(existsSync(worktreeRoot(project.path))).toBe(false);
    expect(git(project.path, 'branch', '--list', 'boite/fix-the-login').trim()).toBe('');
    expect(await client.call('threads.list', {})).toHaveLength(0);
  });

  test('rolling a worktree back takes its directory, its branch and its registration', async () => {
    const project = await repoProject();
    const row = harness.core.projects.require(project.id);
    const threadId = 'thr_rollback';
    const placed = await harness.core.worktrees.add(threadId, row);
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

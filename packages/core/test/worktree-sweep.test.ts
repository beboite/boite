import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type { WorktreeEntry } from '@boite/contracts';
import { realKey as removalKey } from '../src/checkout-removal.ts';
import { setDriver } from '../src/drivers/index.ts';
import { echoDriver } from '../src/drivers/echo.ts';
import { parseWorktreeList, WorktreeSweep } from '../src/worktree-sweep.ts';
import { worktreeRoot } from '../src/worktree.ts';
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
    expect(await thrown(client.call('worktrees.list', { projectId: project.id }))).toThrow(`${path} is not a git repository`);
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
    expect((await rejection(client.call('worktrees.remove', { projectId: project.id, path: join(harness.dataDir, 'nowhere') }))).reason).toMatchObject({
      rpc: { message: expect.stringContaining('is not a worktree git lists'), data: expect.objectContaining({ field: 'path', expected: 'a worktree of this project' }) },
    });
    expect((await rejection(client.call('worktrees.remove', { projectId: project.id, path: project.path }))).reason).toMatchObject({
      rpc: { message: expect.stringContaining("the project's own checkout"), data: expect.objectContaining({ field: 'path' }) },
    });

    const accountId = await echoAccount();
    const thread = await client.call('threads.create', { projectId: project.id, providerId: 'echo', accountId, title: 'Busy here', worktree: {} });
    expect((await rejection(client.call('worktrees.remove', { projectId: project.id, path: thread.cwd, force: true }))).reason).toMatchObject({
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

    expect((await rejection(client.call('worktrees.remove', { projectId: project.id, path: dirty }))).reason).toMatchObject({
      rpc: { message: 'This worktree has uncommitted changes.', data: expect.objectContaining({ field: 'force', dirty: true, unmerged: false }) },
    });
    expect((await rejection(client.call('worktrees.remove', { projectId: project.id, path: unmerged }))).reason).toMatchObject({
      rpc: { message: 'This worktree has commits on no other branch.', data: expect.objectContaining({ field: 'force', dirty: false, unmerged: true }) },
    });
    expect(await thrown(client.call('worktrees.remove', { projectId: project.id, path: both }))).toThrow(
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

  test('an archived thread holds its worktree while it runs, a process or a shell lives, or a restore lands during the checks', async () => {
    const project = await repoProject();
    const accountId = await echoAccount();
    const thread = await client.call('threads.create', { projectId: project.id, providerId: 'echo', accountId, title: 'Finishing in Done', worktree: {} });
    const journal = harness.core.journal;
    const put = (patch: Partial<ReturnType<typeof journal.getThread> & object>): void => journal.putThread({ ...journal.getThread(thread.id)!, ...patch });
    const held = async (): Promise<void> => {
      expect((await rejection(client.call('worktrees.remove', { projectId: project.id, path: thread.cwd, force: true }))).reason).toMatchObject({
        rpc: { data: expect.objectContaining({ threadId: thread.id, expected: 'a worktree no live thread uses' }) },
      });
      expect(existsSync(thread.cwd)).toBe(true);
    };
    // Automatic Done moves a merged conversation away while its prompt finishes, with no tracked process.
    put({ archived: true, archivedAt: 1, doneAt: 1, status: 'running' });
    await held();
    put({ status: 'idle' });
    const procs = harness.core.procs, liveCount = procs.liveCount.bind(procs);
    const live = spyOn(procs, 'liveCount').mockImplementation((id) => (id === thread.id ? 1 : liveCount(id)));
    try { await held(); } finally { live.mockRestore(); }
    const shells = spyOn(harness.core.terminals, 'threadProcesses').mockImplementation((id) => (id === thread.id ? 1 : 0));
    try { await held(); } finally { shells.mockRestore(); }
    // Restored while git status reads the worktree: the removal checks again before it deletes.
    const spawn = procs.spawn.bind(procs);
    const restoring = spyOn(procs, 'spawn').mockImplementation((scope, command, args, options) => {
      if (command === 'git' && args.includes('status')) put({ archived: false });
      return spawn(scope, command, args, options);
    });
    try { await held(); } finally { restoring.mockRestore(); }
    // A turn that ended in error rests like an idle one: nothing runs there.
    put({ archived: true, archivedAt: 1, status: 'error' });
    expect(await client.call('worktrees.remove', { projectId: project.id, path: thread.cwd })).toEqual({ ok: true, branchDeleted: true });
  });

  /** Starts `worktrees.remove` and holds its git once started, before it deletes anything; `during` runs meanwhile. */
  async function whileGitRemoves(projectId: string, path: string, during: () => Promise<void>): Promise<void> {
    const signal = join(harness.dataDir, 'remove-may-run');
    // Bun itself waits, then runs the real git with its output: no shell, so Windows runs it too.
    const hold = 'const [signal, ...args] = process.argv.slice(1); while (!require("node:fs").existsSync(signal)) Bun.sleepSync(20);'
      + ' process.exit(Bun.spawnSync(["git", ...args], { stdout: "inherit", stderr: "inherit" }).exitCode ?? 1);';
    const procs = harness.core.procs, spawn = procs.spawn.bind(procs);
    let waiting = false;
    const spy = spyOn(procs, 'spawn').mockImplementation((scope, command, args, options) => {
      if (command !== 'git' || !args.includes('remove')) return spawn(scope, command, args, options);
      waiting = true;
      return spawn(scope, process.execPath, ['-e', hold, signal, ...args], options);
    });
    try {
      const removing = client.call('worktrees.remove', { projectId, path });
      await waitFor(() => waiting);
      await during();
      writeFileSync(signal, '');
      expect(await removing).toEqual({ ok: true, branchDeleted: true });
    } finally { writeFileSync(signal, ''); spy.mockRestore(); }
    expect(existsSync(path)).toBe(false);
  }

  test('a checkout git is removing cannot be restored or given a new thread until git ends', async () => {
    const project = await repoProject();
    const accountId = await echoAccount();
    const thread = await client.call('threads.create', { projectId: project.id, providerId: 'echo', accountId, title: 'Being removed', worktree: {} });
    await client.call('threads.archive', { threadId: thread.id, archived: true });
    await whileGitRemoves(project.id, thread.cwd, async () => {
      const restored = await rejection(client.call('threads.archive', { threadId: thread.id, archived: false }));
      expect(restored.reason).toMatchObject({ rpc: { message: expect.stringContaining('is being removed'), data: expect.objectContaining({ field: 'cwd' }) } });
      expect(harness.core.threads.require(thread.id).archived).toBe(true);
      expect(await thrown(client.call('threads.create', { projectId: project.id, providerId: 'echo', accountId, title: 'Arrives', cwd: thread.cwd }))).toThrow('is being removed');
    });
    // Once git is done the reservation goes: restoring works, and the folder refuses the turn.
    expect((await client.call('threads.archive', { threadId: thread.id, archived: false })).archived).toBe(false);
  });

  test('neither a deleted conversation brought back nor a link to the checkout gets past its removal', async () => {
    const project = await repoProject();
    const accountId = await echoAccount();
    const thread = await client.call('threads.create', { projectId: project.id, providerId: 'echo', accountId, title: 'Deleted', worktree: {} });
    await client.call('threads.remove', { threadId: thread.id });
    // A link made before the removal: the same folder under another name, and a folder inside it.
    const alias = join(project.path, 'alias');
    symlinkSync(thread.cwd, alias, process.platform === 'win32' ? 'junction' : 'dir');
    mkdirSync(join(thread.cwd, 'sub'));
    const inner = join(project.path, 'inner');
    symlinkSync(join(thread.cwd, 'sub'), inner, process.platform === 'win32' ? 'junction' : 'dir');
    await whileGitRemoves(project.id, thread.cwd, async () => {
      // Undoing the deletion would bring it back live, and its next turn would start in the folder git deletes.
      expect(await thrown(client.call('threads.restore', { threadId: thread.id }))).toThrow('is being removed');
      expect(harness.core.journal.listDeletedThreads().map((one) => one.id)).toContain(thread.id);
      for (const cwd of [alias, join(alias, 'sub'), inner]) {
        expect(await thrown(client.call('threads.create', { projectId: project.id, providerId: 'echo', accountId, title: 'Through a link', cwd }))).toThrow('is being removed');
      }
      // Admission and spawn both normalize `inner/..` lexically to the project before following links.
      const climb = `${inner}${sep}..`;
      const admitted = await client.call('threads.create', { projectId: project.id, providerId: 'echo', accountId, title: 'Lexical parent', cwd: climb });
      expect(admitted.cwd).toBe(resolve(project.path));
      const started = harness.core.procs.spawn('thr_climb' as never, process.execPath, ['-e', 'console.log(process.cwd())'], { cwd: climb });
      const [ran] = await Promise.all([new Response(started.proc.stdout).text(), started.exited]);
      expect(realpathSync(ran.trim())).toBe(realpathSync(project.path));
    });
    expect(harness.core.threads.list({ includeArchived: true }).filter((one) => one.cwd.startsWith(alias))).toEqual([]);
  });

  test('a draft cannot start its agent in a checkout being removed, and a draft whose agent runs there holds it', async () => {
    const project = await repoProject();
    const accountId = await echoAccount();
    const worktree = async (title: string): Promise<string> => {
      const thread = await client.call('threads.create', { projectId: project.id, providerId: 'echo', accountId, title, worktree: {} });
      await client.call('threads.archive', { threadId: thread.id, archived: true });
      return thread.cwd;
    };
    // The native drivers start their process as the draft is prepared; this one starts a sleeper the same way.
    // It ignores the polite stop, as an agent busy writing may: off Windows only the SIGKILL two seconds later ends it.
    const sleeper = 'process.on("SIGTERM", () => {}); console.log("ready"); setTimeout(() => {}, 60_000)';
    const started: string[] = [], refusals: string[] = [];
    let gate: Promise<void> | null = null;
    const restore = setDriver('echo', { ...echoDriver, setViewed: () => {}, releaseThread: () => {},
      prepare: async (context) => {
        await gate;
        try {
          const child = context.spawnChild(process.execPath, ['-e', sleeper], { cwd: context.thread.cwd });
          child.stdout.once('data', () => started.push(context.thread.id));
        }
        catch (error) { refusals.push(error instanceof Error ? error.message : String(error)); }
      },
    });
    try {
      const removed = await worktree('Removed');
      await whileGitRemoves(project.id, removed, async () => {
        const draft = await client.call('drafts.prepare', { projectId: project.id, providerId: 'echo', accountId, cwd: removed, preparationId: 'draft_during_removal' });
        await waitFor(() => refusals.length + started.length > 0);
        expect(refusals).toEqual([expect.stringContaining('is being removed')]);
        expect(harness.core.procs.liveCount(draft.threadId as never)).toBe(0);
        await client.call('drafts.release', { preparationId: draft.preparationId });
      });
      const held = await worktree('Held by a draft');
      const draft = await client.call('drafts.prepare', { projectId: project.id, providerId: 'echo', accountId, cwd: held, preparationId: 'draft_before_removal' });
      await waitFor(() => started.includes(draft.threadId));
      expect(await thrown(client.call('worktrees.remove', { projectId: project.id, path: held }))).toThrow('is a draft whose agent still runs there');
      expect(existsSync(held)).toBe(true);
      // Discarded, its agent is still stopping: the checkout stays held until it has exited.
      await client.call('drafts.release', { preparationId: draft.preparationId });
      if (process.platform !== 'win32') {
        expect(harness.core.procs.liveCount(draft.threadId as never)).toBe(1);
        expect(await thrown(client.call('worktrees.remove', { projectId: project.id, path: held }))).toThrow('is a draft whose agent still runs there');
        expect(existsSync(held)).toBe(true);
      }
      await waitFor(() => harness.core.procs.liveCount(draft.threadId as never) === 0);
      expect(await client.call('worktrees.remove', { projectId: project.id, path: held })).toEqual({ ok: true, branchDeleted: true });
      // A preparation still running when its draft is discarded starts nothing afterwards.
      const late = await worktree('Late preparation');
      let open = () => {};
      gate = new Promise((resolve) => { open = resolve; });
      const discarded = await client.call('drafts.prepare', { projectId: project.id, providerId: 'echo', accountId, cwd: late, preparationId: 'draft_discarded_early' });
      await client.call('drafts.release', { preparationId: discarded.preparationId });
      open();
      await waitFor(() => refusals.length === 2);
      expect(refusals[1]).toContain('draft preparation was released');
      expect(harness.core.procs.liveCount(discarded.threadId as never)).toBe(0);
    } finally { restore(); }
  });

  test('a draft sent while the removal resolves folders holds the checkout by its live row', async () => {
    const project = await repoProject();
    const accountId = await echoAccount();
    const thread = await client.call('threads.create', { projectId: project.id, providerId: 'echo', accountId, title: 'Sent', worktree: {} });
    // Each check lists who stands there, resolves their folders, then decides. Here the thread is still a draft
    // when each check starts and sent by the time it decides: no process, a live row.
    let calls = 0;
    const spy = spyOn(harness.core.drafts, 'threads').mockImplementation(() => (calls++ % 2 === 0 ? [harness.core.threads.require(thread.id)] : []));
    try {
      expect(await thrown(client.call('worktrees.remove', { projectId: project.id, path: thread.cwd }))).toThrow('works there: archive it first');
    } finally { spy.mockRestore(); }
    expect(existsSync(thread.cwd)).toBe(true);
  });

  test('a proved branch is deleted only if no checkout took it back while the deletion waited', async () => {
    const project = await repoProject();
    const row = harness.core.projects.require(project.id);
    const removable = addWorktree(project, 'reused');
    const sha = git(removable, 'rev-parse', 'HEAD').trim();
    const fresh = join(dirname(removable), 'reused-again');
    const sweep = new WorktreeSweep(harness.core);
    let removed = false, listing = 0;
    let reusing: Promise<unknown> | null = null;
    const reuse = (): Promise<unknown> => (reusing = harness.core.worktrees.ensure('thr_reused', row, 'boite/reused', fresh).catch((error: unknown) => error));
    const procs = harness.core.procs, spawn = procs.spawn.bind(procs);
    const spy = spyOn(procs, 'spawn').mockImplementation((scope, command, args, options) => {
      if (command === 'git' && args.includes('remove')) removed = true;
      // The deletion's own check of the branch: a thread taking the branch back starts beside it.
      if (command === 'git' && removed && reusing === null && listing === 0 && args.includes('list')) void reuse();
      return spawn(scope, command, args, options);
    });
    // A deletion that checks the branch in one locked section and deletes it in another leaves the reuse room in between.
    const listed = sweep.listed.bind(sweep);
    const between = spyOn(sweep, 'listed').mockImplementation(async (project) => {
      listing += 1;
      const answer = await listed(project).finally(() => { listing -= 1; });
      if (removed && reusing === null) await reuse();
      return answer;
    });
    try {
      await sweep.removeSettled(row, removable, { sha, branch: 'boite/reused' });
      await reusing;
    } finally { spy.mockRestore(); between.mockRestore(); }
    expect(reusing).not.toBeNull();
    // A checkout that came back still has its branch; one that could not keeps nothing pointing at a deleted ref.
    if (existsSync(fresh)) expect(git(project.path, 'rev-parse', '--verify', '--quiet', 'refs/heads/boite/reused').trim()).toBe(sha);
    else {
      const ref = Bun.spawnSync({ cmd: ['git', 'rev-parse', '--verify', '--quiet', 'refs/heads/boite/reused'], cwd: project.path, env: FIXTURE_GIT_ENV, stdout: 'pipe', stderr: 'pipe' });
      expect(ref.exitCode).toBe(1);
    }
  });

  test('the list and a removal wait for a registration in progress in the same repository', async () => {
    const project = await repoProject();
    const row = harness.core.projects.require(project.id);
    const removable = addWorktree(project, 'removable');
    const registering = harness.core.worktrees.pathFor(row, 'boite/registering');
    const paused = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    let released = false;
    const early: string[] = [];
    const procs = harness.core.procs, spawn = procs.spawn.bind(procs);
    const spy = spyOn(procs, 'spawn').mockImplementation((scope, command, args, options) => {
      const child = spawn(scope, command, args, options);
      if (command === 'git' && String(scope).startsWith('worktrees:') && !released) early.push(args.filter((arg) => !arg.startsWith('core.')).join(' '));
      if (command !== 'git' || !args.includes('add') || !args.includes('boite/registering')) return child;
      return { ...child, exited: child.exited.then(async (code) => {
        // Git's half-written registration: commondir is empty until the add completes.
        const file = join(project.path, '.git', 'worktrees', basename(registering), 'commondir');
        const saved = readFileSync(file);
        writeFileSync(file, '');
        paused.resolve();
        try { await release.promise; } finally { writeFileSync(file, saved); released = true; }
        return code;
      }) };
    });
    try {
      const adding = harness.core.worktrees.add('thr_registering', row, 'boite/registering');
      await paused.promise;
      const listing = Promise.allSettled([client.call('worktrees.list', { projectId: project.id })]);
      const removing = Promise.allSettled([client.call('worktrees.remove', { projectId: project.id, path: removable })]);
      // Long enough for an ungated read to reach git while the registration is half written.
      await waitFor(() => early.length > 0, 500).catch(() => undefined);
      release.resolve();
      await adding;
      const [[listed], [removed]] = await Promise.all([listing, removing]);
      expect(early).toEqual([]);
      expect(listed).toMatchObject({ status: 'fulfilled' });
      expect(removed).toMatchObject({ status: 'fulfilled', value: { ok: true } });
      expect(existsSync(removable)).toBe(false);
    } finally { release.resolve(); spy.mockRestore(); }
  });

  test('the list reads a checkout a removal holds as leaving, without starting git in it', async () => {
    const project = await repoProject();
    const removable = addWorktree(project, 'removable');
    // The moment `detach` holds it, under the resolved key `withVacantCheckout` adds:
    // Windows CI reached the list's status then, and macOS lists `/private/var`.
    const release = harness.core.worktrees.reservations.reserve(removable, [await removalKey(removable)]);
    try {
      const listed = await client.call('worktrees.list', { projectId: project.id });
      expect(byPath(listed, removable)).toMatchObject({ missing: true, dirty: false });
    } finally { release(); }
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
    expect((await rejection(client.call('turns.start', { threadId: thread.id, prompt: 'still there?' }))).reason).toMatchObject({
      rpc: { message: expect.stringContaining(thread.cwd), data: expect.objectContaining({ threadId: thread.id, field: 'cwd', cwd: thread.cwd }) },
    });
  });
});

/*
 * What git tells a thread about its own working directory. The fixture is a
 * repository built inside the test data directory, so nothing here touches a
 * repository anybody works in, and the parsing is checked on the exact `-z`
 * output git produces for a rename and a binary file.
 */

import { chmodSync, mkdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { DIFF_MAX_BYTES, RpcErrorCode } from '@boite/contracts';
import type { CoreClient } from '../src/client.ts';
import { parseNumstat, parseStatus } from '../src/git.ts';
import { GIT_READ_SLOTS, git as readGit, SIDE_CEILING_BYTES } from '../src/git/read.ts';
import { startTestCore, waitFor } from './harness.ts';
import type { TestCore } from './harness.ts';
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

/** The fixture's own identity: a commit needs one, and the machine's config is not the test's business. */
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

async function threadIn(path: string, name: string): Promise<string> {
  const project = await client.call('projects.add', { path, name });
  const accounts = await client.call('accounts.list', {});
  const account = accounts.find((entry) => entry.providerId === 'echo');
  const thread = await client.call('threads.create', {
    projectId: project.id,
    providerId: 'echo',
    accountId: account?.id ?? '',
    title: name,
  });
  return thread.id;
}

/**
 * One commit, then every shape of change at once: a file modified, a file
 * deleted, a file renamed through the index, a binary file touched and a file
 * git has never seen.
 */
async function fixture(): Promise<string> {
  const path = join(harness.dataDir, 'repo');
  mkdirSync(path, { recursive: true });
  git(path, 'init', '-q');
  // `git init -b` is younger than some of the gits this runs on.
  git(path, 'symbolic-ref', 'HEAD', 'refs/heads/work');
  writeFileSync(join(path, 'a.txt'), 'one\ntwo\nthree\n');
  writeFileSync(join(path, 'keep.txt'), 'keep\n');
  writeFileSync(join(path, 'gone.txt'), 'gone\n');
  writeFileSync(join(path, 'pic.png'), new Uint8Array([137, 80, 78, 71, 0, 13, 10, 26, 10, 0, 1, 2]));
  git(path, 'add', '-A');
  git(path, 'commit', '-q', '-m', 'init');

  writeFileSync(join(path, 'a.txt'), 'one\ntwo\nthree\nfour\n');
  writeFileSync(join(path, 'new.txt'), 'brand new\n');
  writeFileSync(join(path, 'pic.png'), new Uint8Array([137, 80, 78, 71, 0, 13, 10, 26, 10, 0, 1, 2, 3]));
  rmSync(join(path, 'gone.txt'));
  git(path, 'mv', 'keep.txt', 'moved.txt');
  return path;
}

describe('git.status', () => {
  test('the branch, every change and the numbers git counts for them', async () => {
    const path = await fixture();
    const threadId = await threadIn(path, 'repo');
    const status = await client.call('git.status', { threadId });
    expect(status.branch).toBe('work');
    expect(status.upstream).toBe(null);
    expect(status.ahead).toBe(0);
    expect(status.behind).toBe(0);

    const byPath = new Map(status.changes.map((change) => [change.path, change]));
    expect([...byPath.keys()].sort()).toEqual(['a.txt', 'gone.txt', 'moved.txt', 'new.txt', 'pic.png']);
    expect(byPath.get('a.txt')).toMatchObject({ status: 'modified', staged: false, additions: 1, deletions: 0, oldPath: null });
    expect(byPath.get('gone.txt')).toMatchObject({ status: 'deleted', additions: 0, deletions: 1 });
    expect(byPath.get('moved.txt')).toMatchObject({ status: 'renamed', oldPath: 'keep.txt', staged: true });
    // Untracked files are outside the diff, so they carry no numbers at all.
    expect(byPath.get('new.txt')).toMatchObject({ status: 'untracked', staged: false, additions: null, deletions: null });
    expect(byPath.get('pic.png')).toMatchObject({ status: 'modified', additions: null, deletions: null });
  });

  test('reading the changes never rewrites the index an agent in the same checkout may be locking', async () => {
    const path = await fixture();
    const threadId = await threadIn(path, 'repo');
    git(path, 'add', '-A');
    git(path, 'commit', '-q', '-m', 'second');
    // Stale stat data: a plain `git status` refreshes it and writes the index back under index.lock.
    const index = join(path, '.git', 'index');
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(index, old, old);
    const later = new Date(Date.now() - 60_000);
    utimesSync(join(path, 'a.txt'), later, later);
    const envs: (Record<string, string | undefined> | undefined)[] = [];
    const spawn = harness.core.procs.spawn.bind(harness.core.procs);
    const spy = spyOn(harness.core.procs, 'spawn').mockImplementation((scope, command, args, options) => {
      envs.push(options?.env);
      return spawn(scope, command, args, options);
    });
    try {
      await client.call('git.status', { threadId });
      await client.call('git.diff', { threadId, path: 'a.txt' });
    } finally {
      spy.mockRestore();
    }
    expect(envs.length).toBeGreaterThan(2);
    expect(envs.every((env) => env?.['GIT_OPTIONAL_LOCKS'] === '0')).toBe(true);
    expect(statSync(index).mtimeMs).toBe(old.getTime());
  });

  test('a git that does not answer is stopped by its own process and the read refused by name', async () => {
    const path = await fixture();
    const threadId = await threadIn(path, 'repo');
    const spawn = harness.core.procs.spawn.bind(harness.core.procs);
    const spy = spyOn(harness.core.procs, 'spawn').mockImplementation((scope, _command, _args, options) =>
      spawn(scope, process.execPath, ['-e', 'await Bun.sleep(20000)'], options),
    );
    try {
      const started = Date.now();
      expect(await thrown(readGit(harness.core, threadId, path, ['status'], 300))).toThrow(/git status did not answer within 0.3 s/);
      expect(Date.now() - started).toBeLessThan(5_000);
      await waitFor(() => harness.core.procs.liveCount(threadId) === 0);
    } finally {
      spy.mockRestore();
    }
  });

  test('at most eight short reads run at once, and the wait for a slot does not count against a deadline', async () => {
    const path = await fixture();
    const threadId = await threadIn(path, 'repo');
    let live = 0;
    let most = 0;
    const spawn = harness.core.procs.spawn.bind(harness.core.procs);
    // Each stand-in git takes 400 ms; the deadline of 700 ms is shorter than two in a row.
    const spy = spyOn(harness.core.procs, 'spawn').mockImplementation((scope, _command, _args, options) => {
      live += 1;
      most = Math.max(most, live);
      const spawned = spawn(scope, process.execPath, ['-e', 'await Bun.sleep(400)'], options);
      void spawned.exited.then(() => { live -= 1; });
      return spawned;
    });
    try {
      const reads = Array.from({ length: GIT_READ_SLOTS + 4 }, () => readGit(harness.core, threadId, path, ['status'], 700));
      const answers = await Promise.all(reads);
      expect(answers.every((answer) => answer.code === 0)).toBe(true);
      expect(most).toBe(GIT_READ_SLOTS);
    } finally {
      spy.mockRestore();
    }
  });

  test('a working directory outside a repository is refused by name', async () => {
    const path = join(harness.dataDir, 'plain');
    mkdirSync(path, { recursive: true });
    const threadId = await threadIn(path, 'plain');
    let failure = 'none';
    try {
      await client.call('git.status', { threadId });
    } catch (error) {
      failure = (error as Error).message;
    }
    expect(failure).toContain(`the working directory of thread ${threadId} is not inside a git repository`);
  });
});

describe('git.diff', () => {
  test('both sides of a modified file, and the side that does not exist', async () => {
    const path = await fixture();
    const threadId = await threadIn(path, 'repo');

    const modified = await client.call('git.diff', { threadId, path: 'a.txt' });
    expect(modified).toMatchObject({
      path: 'a.txt',
      oldPath: null,
      status: 'modified',
      oldText: 'one\ntwo\nthree\n',
      newText: 'one\ntwo\nthree\nfour\n',
      binary: false,
      truncated: false,
    });

    const added = await client.call('git.diff', { threadId, path: 'new.txt' });
    expect(added).toMatchObject({ status: 'untracked', oldText: null, newText: 'brand new\n' });

    const deleted = await client.call('git.diff', { threadId, path: 'gone.txt' });
    expect(deleted).toMatchObject({ status: 'deleted', oldText: 'gone\n', newText: null });

    const renamed = await client.call('git.diff', { threadId, path: 'moved.txt' });
    expect(renamed).toMatchObject({ status: 'renamed', oldPath: 'keep.txt', oldText: 'keep\n', newText: 'keep\n' });

    // A file with a NUL in it has no sides to show, whatever its extension.
    const binary = await client.call('git.diff', { threadId, path: 'pic.png' });
    expect(binary).toMatchObject({ binary: true, oldText: null, newText: null });
  });

  test('one git reads a diff when the client gives the origin from its status, two when the core must find it', async () => {
    const path = await fixture();
    const threadId = await threadIn(path, 'repo');
    const spawned: string[] = [];
    const spawn = harness.core.procs.spawn.bind(harness.core.procs);
    const piped = harness.core.procs.spawnPiped.bind(harness.core.procs);
    const spies = [
      spyOn(harness.core.procs, 'spawn').mockImplementation((scope, command, args, options) => {
        spawned.push(args.filter((arg) => !arg.startsWith('-') && !arg.includes('=')).slice(0, 1).join(''));
        return spawn(scope, command, args, options);
      }),
      spyOn(harness.core.procs, 'spawnPiped').mockImplementation((scope, command, args, options) => {
        spawned.push(args.filter((arg) => !arg.startsWith('-') && !arg.includes('=')).slice(0, 1).join(''));
        return piped(scope, command, args, options);
      }),
    ];
    const counted = async (params: { path: string; oldPath?: string | null }) => {
      spawned.length = 0;
      const diff = await client.call('git.diff', { threadId, ...params });
      return { diff, spawned: [...spawned] };
    };
    try {
      const walked = await counted({ path: 'moved.txt' });
      expect(walked.spawned).toEqual(['status', 'cat-file']);
      const given = await counted({ path: 'moved.txt', oldPath: 'keep.txt' });
      expect(given.spawned).toEqual(['cat-file']);
      expect(given.diff).toEqual(walked.diff);
      const plain = await counted({ path: 'a.txt', oldPath: null });
      expect(plain.spawned).toEqual(['cat-file']);
      expect(plain.diff).toMatchObject({ oldPath: null, status: 'modified', oldText: 'one\ntwo\nthree\n', newText: 'one\ntwo\nthree\nfour\n' });
      const deleted = await counted({ path: 'gone.txt', oldPath: null });
      expect(deleted.diff).toMatchObject({ status: 'deleted', oldText: 'gone\n', newText: null });
      const added = await counted({ path: 'new.txt', oldPath: null });
      expect(added.diff).toMatchObject({ status: 'added', oldText: null, newText: 'brand new\n' });
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    expect(await thrown(client.call('git.diff', { threadId, path: 'moved.txt', oldPath: '../keep.txt' })))
      .toThrow("git.diff oldPath leaves the thread's working directory: ../keep.txt");
    expect(await thrown(client.call('git.diff', { threadId, path: 'moved.txt', oldPath: 3 as unknown as string })))
      .toThrow('git.diff oldPath must be a path, got number');
  });

  test('a git without `cat-file --batch -z` reads the side in three steps, and only asks once', async () => {
    const path = await fixture();
    const threadId = await threadIn(path, 'repo');
    let batches = 0;
    const piped = harness.core.procs.spawnPiped.bind(harness.core.procs);
    // The answer an older git gives: an unknown option, exit 129.
    const spy = spyOn(harness.core.procs, 'spawnPiped').mockImplementation((scope, command, args, options) => {
      batches += 1;
      return piped(scope, command, args.map((arg) => (arg === '-z' ? '--no-such-switch' : arg)), options);
    });
    try {
      const first = await client.call('git.diff', { threadId, path: 'moved.txt', oldPath: 'keep.txt' });
      expect(first).toMatchObject({ status: 'renamed', oldText: 'keep\n', newText: 'keep\n' });
      const second = await client.call('git.diff', { threadId, path: 'a.txt' });
      expect(second.oldText).toBe('one\ntwo\nthree\n');
      expect((await rejection(client.call('git.diff', { threadId, path: 'a.txt', ref: 'missing-ref', oldPath: null }))).reason)
        .toMatchObject({ rpc: { message: expect.stringContaining('missing-ref'), data: expect.objectContaining({ field: 'ref' }) } });
      expect(await client.call('git.diff', { threadId, path: 'new.txt', oldPath: null })).toMatchObject({ status: 'added', oldText: null });
      // A folder at the ref, a file in the tree: that file is new, as the batch says.
      mkdirSync(join(path, 'dir'));
      writeFileSync(join(path, 'dir', 'file'), 'inside\n');
      git(path, 'add', 'dir');
      git(path, 'commit', '-q', '-m', 'dir');
      rmSync(join(path, 'dir'), { recursive: true });
      writeFileSync(join(path, 'dir'), 'replacement\n');
      expect(await client.call('git.diff', { threadId, path: 'dir', oldPath: null })).toMatchObject({ status: 'added', oldText: null, newText: 'replacement\n' });
    } finally {
      spy.mockRestore();
    }
    expect(batches).toBe(1);
  });

  test('a side at the ref past the ceiling is refused from its size, its git stopped before the bytes', async () => {
    const path = await fixture();
    const threadId = await threadIn(path, 'repo');
    writeFileSync(join(path, 'huge.bin'), 'x'.repeat(SIDE_CEILING_BYTES + 1));
    git(path, 'add', 'huge.bin');
    git(path, 'commit', '-q', '-m', 'huge');
    writeFileSync(join(path, 'huge.bin'), 'small now\n');
    expect(await thrown(client.call('git.diff', { threadId, path: 'huge.bin', oldPath: null })))
      .toThrow(`git.diff will not read huge.bin: it is over ${SIDE_CEILING_BYTES / (1024 * 1024)} MB on one side`);
    await waitFor(() => harness.core.procs.liveCount(threadId) === 0);
  });

  test('a diff outside a repository is refused by name, with or without the origin', async () => {
    const path = join(harness.dataDir, 'plain');
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'a.txt'), 'a\n');
    const threadId = await threadIn(path, 'plain');
    for (const params of [{}, { oldPath: null }]) {
      expect(await thrown(client.call('git.diff', { threadId, path: 'a.txt', ...params })))
        .toThrow(`the working directory of thread ${threadId} is not inside a git repository`);
    }
  });

  test('an unknown ref, an unreadable file and a lost object are refused, never shown as a side that does not exist', async () => {
    const path = await fixture();
    const threadId = await threadIn(path, 'repo');
    expect((await rejection(client.call('git.diff', { threadId, path: 'a.txt', ref: 'missing-ref', oldPath: null }))).reason)
      .toMatchObject({ rpc: { code: RpcErrorCode.Refused, message: expect.stringContaining('missing-ref'), data: expect.objectContaining({ field: 'ref' }) } });
    // A ref that exists and a file it does not have: that side is absent, as before.
    expect(await client.call('git.diff', { threadId, path: 'new.txt', ref: 'HEAD', oldPath: null })).toMatchObject({ status: 'added', oldText: null, newText: 'brand new\n' });
    if (process.platform !== 'win32' && process.getuid?.() !== 0) {
      chmodSync(join(path, 'a.txt'), 0o000);
      try {
        expect(await thrown(client.call('git.diff', { threadId, path: 'a.txt', oldPath: null }))).toThrow('git.diff cannot read a.txt');
      } finally { chmodSync(join(path, 'a.txt'), 0o644); }
    }
    // The blob the commit names is gone from the object store.
    const blob = git(path, 'rev-parse', 'HEAD:gone.txt').trim();
    rmSync(join(path, '.git', 'objects', blob.slice(0, 2), blob.slice(2)));
    expect(await thrown(client.call('git.diff', { threadId, path: 'gone.txt', oldPath: null }))).toThrow(`git.diff cannot read HEAD:./gone.txt: it names ${blob}, which the repository does not hold`);
    // Before the first commit HEAD names nothing, and a file is simply new.
    const unborn = join(harness.dataDir, 'unborn');
    mkdirSync(unborn, { recursive: true });
    git(unborn, 'init', '-q');
    writeFileSync(join(unborn, 'first.txt'), 'first\n');
    const fresh = await threadIn(unborn, 'unborn');
    expect(await client.call('git.diff', { threadId: fresh, path: 'first.txt', oldPath: null })).toMatchObject({ status: 'added', newText: 'first\n' });
  });

  test('a git failure inside a repository is reported in its own words, not as a folder outside one', async () => {
    const path = await fixture();
    const threadId = await threadIn(path, 'repo');
    writeFileSync(join(path, '.git', 'index'), 'not an index');
    const failure = (await rejection(client.call('git.status', { threadId }))).reason as Error;
    expect(failure.message).not.toContain('not inside a git repository');
    expect(failure.message).toContain('index');
  });

  test('malformed refs are refused while an empty ref defaults to HEAD', async () => {
    const path = await fixture();
    const threadId = await threadIn(path, 'repo');
    for (const ref of [null, false, 0, [], { length: 0 }]) {
      expect((await rejection(client.call('git.diff', { threadId, path: 'a.txt', ref: ref as unknown as string }))).reason)
        .toMatchObject({ rpc: { code: RpcErrorCode.Refused, message: 'git.diff ref must be a revision' } });
    }
    const diff = await client.call('git.diff', { threadId, path: 'a.txt', ref: '' });
    expect(diff.oldText).toBe('one\ntwo\nthree\n');
  });

  test('a working-tree file past the diff limit is cut without being read whole', async () => {
    const path = await fixture();
    const threadId = await threadIn(path, 'repo');
    // One byte of padding past the limit, then a marker the cut must not reach:
    // seeing it would mean the tail was read and thrown away afterwards.
    writeFileSync(join(path, 'big.log'), `${'x'.repeat(DIFF_MAX_BYTES + 1)}THE-TAIL\n`);

    const diff = await client.call('git.diff', { threadId, path: 'big.log' });
    expect(diff.newText?.length).toBe(DIFF_MAX_BYTES);
    expect(diff.newText).not.toContain('THE-TAIL');
    expect(diff.truncated).toBe(true);
    // The file is not in the repository, so the other side stays absent.
    expect(diff.oldText).toBeNull();
  });

  test('a path outside the working directory, a ref that is an option and a file nobody has are refused', async () => {
    const path = await fixture();
    const threadId = await threadIn(path, 'repo');
    const failures: string[] = [];
    const attempts: (() => Promise<unknown>)[] = [
      () => client.call('git.diff', { threadId, path: '../escaped.txt' }),
      () => client.call('git.diff', { threadId, path: 'a.txt', ref: '--upload-pack=touch' }),
      () => client.call('git.diff', { threadId, path: 'never-existed.txt' }),
    ];
    for (const attempt of attempts) {
      try {
        await attempt();
        failures.push('none');
      } catch (error) {
        failures.push((error as Error).message);
      }
    }
    expect(failures).toEqual([
      "git.diff path leaves the thread's working directory: ../escaped.txt",
      'git.diff refuses the ref --upload-pack=touch',
      'git.diff has no file to read at never-existed.txt, in the working tree or at HEAD',
    ]);
  });
});

test('git.diff refuses a junction leading outside the working directory', async () => {
  const cwd = await fixture();
  const threadId = await threadIn(cwd, 'junction boundary');
  const outside = join(harness.dataDir, 'outside-diff');
  mkdirSync(outside);
  writeFileSync(join(outside, 'private.txt'), 'outside data');
  symlinkSync(outside, join(cwd, 'linked'), 'junction');
  expect(await thrown(client.call('git.diff', { threadId, path: 'linked/private.txt' }))).toThrow("leaves the thread's working directory");
});

describe('the porcelain formats', () => {
  test('a rename carries its origin as the record behind it, and the branch header is read whole', () => {
    const raw = ['## work...origin/work [ahead 2, behind 1]', 'R  moved.txt', 'keep.txt', ' M a.txt', '?? new.txt', ''].join(' ');
    const status = parseStatus(raw);
    expect(status).toMatchObject({ branch: 'work', upstream: 'origin/work', ahead: 2, behind: 1 });
    expect(status.changes.map((change) => [change.path, change.status, change.oldPath, change.staged])).toEqual([
      ['moved.txt', 'renamed', 'keep.txt', true],
      ['a.txt', 'modified', null, false],
      ['new.txt', 'untracked', null, false],
    ]);
    expect(parseStatus(['## No commits yet on work', '?? a.txt', ''].join(' ')).branch).toBe('work');
    expect(parseStatus(['## HEAD (no branch)', ''].join(' ')).branch).toBe(null);
  });

  test('numstat counts a rename by its destination and a binary file as nothing', () => {
    const numbers = parseNumstat(['1\t0\ta.txt', '-\t-\tpic.png', '0\t0\t', 'keep.txt', 'moved.txt', ''].join(' '));
    expect(numbers.get('a.txt')).toEqual({ additions: 1, deletions: 0 });
    expect(numbers.get('pic.png')).toEqual({ additions: null, deletions: null });
    expect(numbers.get('moved.txt')).toEqual({ additions: 0, deletions: 0 });
  });
});

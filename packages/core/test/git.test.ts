/*
 * What git tells a thread about its own working directory. The fixture is a
 * repository built inside the test data directory, so nothing here touches a
 * repository anybody works in, and the parsing is checked on the exact `-z`
 * output git produces for a rename and a binary file.
 */

import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { DIFF_MAX_BYTES } from '@boite/contracts';
import type { CoreClient } from '../src/client.ts';
import { parseNumstat, parseStatus } from '../src/git.ts';
import { startTestCore } from './harness.ts';
import type { TestCore } from './harness.ts';

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
  await expect(client.call('git.diff', { threadId, path: 'linked/private.txt' })).rejects.toThrow("leaves the thread's working directory");
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

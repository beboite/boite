import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { echoThread, startTestCore, type TestCore } from './harness.ts';

let harness: TestCore;
let restore: (() => void) | undefined;
beforeEach(async () => { harness = await startTestCore(); });
afterEach(async () => { restore?.(); restore = undefined; await harness.stop(); });

const url = 'https://github.com/example/repo/pull/7';
const candidate = (state = 'OPEN', number = 7) => ({ number, url: `https://github.com/example/repo/pull/${number}`, state,
  title: 'Change', isDraft: false, headRefName: 'topic', baseRefName: 'main',
  headRepository: { name: 'repo' }, headRepositoryOwner: { login: 'example' }, isCrossRepository: false });

async function fixture() {
  const client = await harness.connect(), { threadId } = await echoThread(harness, client);
  const cwd = join(harness.dataDir, 'repo');
  mkdirSync(join(cwd, '.git'), { recursive: true });
  harness.core.journal.putThread({ ...harness.core.threads.require(threadId), cwd, branch: 'topic' });
  let list: unknown[] = [candidate()];
  let detail = candidate();
  let unavailable = false;
  const calls: string[][] = [];
  const spawn = harness.core.procs.spawn.bind(harness.core.procs);
  const replacement = spyOn(harness.core.procs, 'spawn').mockImplementation((scope, command, args, options) => {
    if (command === 'gh') {
      calls.push(args);
      if (unavailable) throw Object.assign(new Error('Executable not found in $PATH: gh'), { code: 'ENOENT' });
    }
    const value = command === 'git'
      ? 'origin\thttps://github.com/example/repo.git (fetch)\nupstream\thttps://github.com/other/repo.git (fetch)'
      : args[1] === 'view' ? detail : list;
    return spawn(scope, process.execPath, ['-e', `console.log(${JSON.stringify(typeof value === 'string' ? value : JSON.stringify(value))})`], options);
  });
  restore = () => replacement.mockRestore();
  return { client, threadId, calls, setList: (value: unknown[]) => { list = value; }, setDetail: (state: string) => { detail = candidate(state); },
    setUnavailable: (value: boolean) => { unavailable = value; } };
}

test('an explicit PR is detected without a branch or surviving checkout and refresh observes its merge', async () => {
  const f = await fixture();
  await f.client.call('threads.linkPullRequest', { threadId: f.threadId, url });
  harness.core.journal.putThread({ ...harness.core.threads.require(f.threadId), branch: null, cwd: join(harness.dataDir, 'removed-worktree') });
  expect(await f.client.call('threads.pullRequest', { threadId: f.threadId })).toEqual({ number: 7, url, state: 'OPEN' });
  f.setDetail('MERGED');
  expect(await f.client.call('threads.pullRequest', { threadId: f.threadId, refresh: true })).toEqual({ number: 7, url, state: 'MERGED' });
  expect((await f.client.call('threads.pullRequests', { threadId: f.threadId }))[0]?.state).toBe('MERGED');
});

test('automatic discovery pins the repository and ignores another fork with the same branch', async () => {
  const f = await fixture();
  f.setList([{ ...candidate('OPEN', 9), isCrossRepository: true, headRepositoryOwner: { login: 'someone' } }, candidate()]);
  expect(await f.client.call('threads.pullRequest', { threadId: f.threadId })).toEqual({ number: 7, url, state: 'OPEN' });
  expect(f.calls[0]).toEqual(expect.arrayContaining(['--hostname', 'github.com', 'owner=example', 'name=repo']));
});

test('an open PR takes precedence over the old merged PR of a reused branch', async () => {
  const f = await fixture();
  f.setList([candidate('MERGED', 8), candidate()]);
  expect((await f.client.call('threads.pullRequest', { threadId: f.threadId }))?.state).toBe('OPEN');
});

test('a missing gh is retried automatically after a bounded delay', async () => {
  const f = await fixture();
  f.setUnavailable(true);
  expect(await f.client.call('threads.pullRequest', { threadId: f.threadId })).toBeNull();
  f.setUnavailable(false);
  const now = Date.now();
  const clock = spyOn(Date, 'now').mockReturnValue(now + 61_000);
  try { expect((await f.client.call('threads.pullRequest', { threadId: f.threadId }))?.number).toBe(7); }
  finally { clock.mockRestore(); }
});


test('new automatic work supersedes a terminal explicit link on a reused branch', async () => {
  const f = await fixture();
  f.setDetail('CLOSED');
  f.setList([candidate('CLOSED')]);
  await f.client.call('threads.linkPullRequest', { threadId: f.threadId, url });
  f.setList([candidate('OPEN', 8), candidate('CLOSED')]);
  // The link read the repository's page: the next one, fifteen seconds later, shows the new work.
  const clock = spyOn(Date, 'now').mockReturnValue(Date.now() + 15_000);
  try { expect(await f.client.call('threads.pullRequest', { threadId: f.threadId })).toEqual({ number: 8, url: candidate('OPEN', 8).url, state: 'OPEN' }); }
  finally { clock.mockRestore(); }
});

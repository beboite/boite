import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { echoThread, startTestCore, type TestCore } from './harness.ts';
import { hasGitHubRemote, parsePullRequests, PullRequests } from '../src/pull-requests.ts';
let harness: TestCore;
beforeEach(async () => {
  harness = await startTestCore();
});
afterEach(async () => {
  await harness.stop();
});

test('last user message survives assistant output, title changes and reloading the projection', async () => {
  const client = await harness.connect();
  const { threadId } = await echoThread(harness, client);
  const journal = harness.core.journal;
  expect(journal.getThread(threadId)?.lastUserMessageAt).toBeNull();
  journal.putMessage({
    id: 'user-1',
    threadId,
    turnId: 'turn-1',
    role: 'user',
    state: 'complete',
    parts: [{ type: 'text', text: 'first' }],
    createdAt: 100
  });
  journal.putMessage({
    id: 'assistant-1',
    threadId,
    turnId: 'turn-1',
    role: 'assistant',
    state: 'complete',
    parts: [],
    createdAt: 900
  });
  await client.call('threads.update', { threadId, title: 'renamed' });
  expect((await client.call('threads.get', { threadId })).lastUserMessageAt).toBe(100);
  expect((await client.call('threads.list', {}))[0]?.lastUserMessageAt).toBe(100);
  journal.putMessage({
    id: 'user-2',
    threadId,
    turnId: 'turn-2',
    role: 'user',
    state: 'complete',
    parts: [],
    createdAt: 1000
  });
  expect(journal.getThread(threadId)?.lastUserMessageAt).toBe(1000);
});

test('browser origins are exact, explicit, validated and removable', async () => {
  const client = await harness.connect();
  await expect(client.call('settings.set', { browserOrigins: ['https://example.com/path'] })).rejects.toThrow(
    'browserOrigins'
  );
  await expect(client.call('settings.set', { browserOrigins: ['*'] })).rejects.toThrow('browserOrigins');
  const next = await client.call('settings.set', { browserOrigins: ['https://example.com'] });
  expect(next.browserOrigins).toEqual(['https://example.com']);
  expect((await client.call('settings.set', { browserOrigins: [] })).browserOrigins).toEqual([]);
});

test('PR metadata accepts absence and rejects unsafe URLs and malformed CLI output', () => {
  expect(parsePullRequests('[]')).toBeNull();
  expect(
    parsePullRequests('[{"number":4,"url":"https://github.com/example/repo/pull/4","state":"MERGED"}]')?.state
  ).toBe('MERGED');
  expect(() => parsePullRequests('[{"number":4,"url":"javascript:alert(1)","state":"OPEN"}]')).toThrow('HTTPS');
  expect(() => parsePullRequests('{}')).toThrow('array');
  expect(() => parsePullRequests('[null]')).toThrow('object');
});

test('PR host detection accepts GitHub transports and an explicitly configured enterprise host', () => {
  for (const url of ['https://github.com/example/repo.git', 'git@github.com:example/repo.git', 'github.com:example/repo.git', 'ssh://git@github.com/example/repo.git']) {
    expect(hasGitHubRemote(`origin\t${url} (fetch)`, 'github.com')).toBe(true);
  }
  expect(hasGitHubRemote('origin\thttps://git.example/team/repo.git (fetch)', 'git.example')).toBe(true);
  expect(hasGitHubRemote('origin\thttps://github.com.other.example/team/repo.git (fetch)', 'github.com')).toBe(false);
  expect(hasGitHubRemote('')).toBe(false);
});

/** A fake `gh pr list` that answers from `prs` after a short wait, as a real call over the network would. */
function fakeGh(prs: { headRefName: string; number: number }[]): string[] {
  const list = prs.map((pr) => ({ ...pr, url: `https://github.com/example/repo/pull/${pr.number}`, state: 'OPEN' }));
  return ['-e', `await Bun.sleep(60); console.log(${JSON.stringify(JSON.stringify(list))})`];
}

test('PR reads run one gh call per repository, two processes at a time, and match each branch', async () => {
  const client = await harness.connect();
  const ids: string[] = [];
  for (let index = 0; index < 3; index++) {
    const { threadId } = await echoThread(harness, client);
    const repo = join(harness.dataDir, `repo-${index}`);
    mkdirSync(join(repo, '.git'), { recursive: true });
    harness.core.journal.putThread({ ...harness.core.threads.require(threadId), cwd: repo, branch: `topic-${index}` });
    ids.push(threadId);
  }
  const spawn = harness.core.procs.spawn.bind(harness.core.procs);
  let running = 0,
    peak = 0;
  const calls: string[][] = [];
  const replacement = spyOn(harness.core.procs, 'spawn').mockImplementation((scope, command, args, options) => {
    expect(scope).toStartWith('pull-request:');
    running++;
    peak = Math.max(peak, running);
    const git = ['-e', 'await Bun.sleep(30); console.log("origin\\tgit@github.com:example/repo.git (fetch)")'];
    if (command !== 'git') {
      expect(command).toBe('gh');
      calls.push(args);
    }
    const proc = spawn(scope, process.execPath, command === 'git' ? git : fakeGh([0, 1, 2].map((index) => ({ headRefName: `topic-${index}`, number: 4 + index }))), options);
    void proc.exited.finally(() => running--);
    return proc;
  });
  try {
    const reader = new PullRequests(harness.core);
    const results = await Promise.all([reader.read(ids[0]!), reader.read(ids[0]!), reader.read(ids[1]!), reader.read(ids[2]!)]);
    expect(results.map((pr) => pr?.number)).toEqual([4, 4, 5, 6]);
    expect(peak).toBe(2);
    // Three repositories, three lists; the second read of the first thread shared its call.
    expect(calls).toHaveLength(3);
    expect(calls[0]).toContain('headRefName,number,url,state');
    await reader.read(ids[0]!);
    expect(calls).toHaveLength(3);
  } finally {
    replacement.mockRestore();
  }
});

test('threads of one repository share one git remote and one gh call, and a missing gh is not asked again', async () => {
  const client = await harness.connect();
  const repo = join(harness.dataDir, 'shared-repo');
  mkdirSync(join(repo, '.git'), { recursive: true });
  const ids: string[] = [];
  for (let index = 0; index < 3; index++) {
    const { threadId } = await echoThread(harness, client);
    harness.core.journal.putThread({ ...harness.core.threads.require(threadId), cwd: repo, branch: `topic-${index}` });
    ids.push(threadId);
  }
  const spawn = harness.core.procs.spawn.bind(harness.core.procs);
  const commands: string[] = [];
  let ghMissing = false;
  const replacement = spyOn(harness.core.procs, 'spawn').mockImplementation((scope, command, args, options) => {
    commands.push(command);
    if (command === 'git') return spawn(scope, process.execPath, ['-e', 'console.log("origin\\thttps://github.com/example/repo.git (fetch)")'], options);
    if (ghMissing) throw Object.assign(new Error('Executable not found in $PATH: "gh"'), { code: 'ENOENT' });
    return spawn(scope, process.execPath, fakeGh([{ headRefName: 'topic-0', number: 7 }, { headRefName: 'topic-1', number: 8 }]), options);
  });
  try {
    const reader = new PullRequests(harness.core);
    const results = await Promise.all(ids.map((id) => reader.read(id)));
    // topic-2 has no pull request: the list was not full, so gh is not asked for it alone.
    expect(results.map((pr) => pr?.number ?? null)).toEqual([7, 8, null]);
    expect(commands).toEqual(['git', 'gh']);

    ghMissing = true;
    const missing = new PullRequests(harness.core);
    commands.length = 0;
    expect(await missing.read(ids[0]!)).toBeNull();
    expect(await missing.read(ids[1]!, false)).toBeNull();
    expect(commands).toEqual(['git', 'gh']);
    // A user's refresh tries gh again.
    expect(await missing.read(ids[1]!, true)).toBeNull();
    expect(commands).toEqual(['git', 'gh', 'git', 'gh']);
  } finally {
    replacement.mockRestore();
  }
});

test('a Forgejo project has no GitHub PR and never launches gh', async () => {
  const client = await harness.connect();
  const { threadId } = await echoThread(harness, client);
  const thread = harness.core.threads.require(threadId);
  mkdirSync(join(thread.cwd, '.git'), { recursive: true });
  harness.core.journal.putThread({ ...thread, branch: 'main' });
  const spawn = harness.core.procs.spawn.bind(harness.core.procs);
  const commands: string[] = [];
  const replacement = spyOn(harness.core.procs, 'spawn').mockImplementation((scope, command, args, options) => {
    commands.push(command);
    if (command === 'gh') throw new Error('Executable not found in PATH: gh');
    return spawn(scope, process.execPath, ['-e', 'console.log("origin\\thttps://forgejo.example/team/project.git (fetch)")'], options);
  });
  try {
    expect(await new PullRequests(harness.core).read(threadId)).toBeNull();
    expect(commands).toEqual(['git']);
  } finally { replacement.mockRestore(); }
});

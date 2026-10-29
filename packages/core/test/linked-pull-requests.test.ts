import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { orderPullRequests, pullRequestAddress, type LinkedPullRequest } from '@boite/contracts';
import { LinkedPullRequests } from '../src/linked-pull-requests.ts';
import { connect } from '../src/client.ts';
import { echoThread, startTestCore, type TestCore } from './harness.ts';
import { thrown } from './settle.ts';

let harness: TestCore;
beforeEach(async () => { harness = await startTestCore(); });
afterEach(async () => { await harness.stop(); });
const pr = (n: number, base = 'main', repository = 'example/repo'): LinkedPullRequest => ({
  url: `https://github.com/${repository}/pull/${n}`, repository, number: n, title: `Change ${n}`, state: 'OPEN',
  draft: false, head: `feature-${n}`, base, headRepository: repository, checkedAt: Date.now(),
});

test('links persist, deduplicate concurrent requests, refresh states and unlink without changing GitHub', async () => {
  const owner = await harness.connect(), { threadId } = await echoThread(harness, owner);
  const calls: string[] = [];
  const fetch = async (_threadId: string, url: string) => { calls.push(url); return pr(pullRequestAddress(url).number, url.endsWith('/2') ? 'feature-1' : 'main'); };
  const links = new LinkedPullRequests(harness.core, fetch);
  await Promise.all([links.link(threadId, pr(2).url), links.link(threadId, pr(1).url), links.link(threadId, pr(1).url)]);
  expect(calls).toHaveLength(2);
  const reopened = new LinkedPullRequests(harness.core, async (_id, url) => ({ ...await fetch(_id, url), state: 'MERGED' }));
  expect((await reopened.list(threadId)).map(p => [p.number, p.state])).toEqual([[1, 'MERGED'], [2, 'MERGED']]);
  const offline = new LinkedPullRequests(harness.core, async () => { throw new Error('GitHub unavailable'); });
  expect((await offline.list(threadId, true))[0]).toMatchObject({ state: 'MERGED', error: 'GitHub unavailable' });
  expect((await offline.unlink(threadId, pr(1).url)).map(p => p.number)).toEqual([2]);
  harness.core.journal.deleteThreads([threadId]);
  expect(harness.core.journal.getSetting('linked-pull-requests:' + threadId)).toBeUndefined();
});

test('a linked PR stored as merged is read again only when the user refreshes', async () => {
  const owner = await harness.connect(), { threadId } = await echoThread(harness, owner);
  const calls: string[] = [];
  const states: Record<number, LinkedPullRequest['state']> = { 1: 'MERGED', 2: 'OPEN', 3: 'CLOSED' };
  const links = new LinkedPullRequests(harness.core, async (_threadId, url) => {
    calls.push(url);
    const number = pullRequestAddress(url).number;
    return { ...pr(number), state: states[number]! };
  });
  for (const number of [1, 2, 3]) await links.link(threadId, pr(number).url);
  calls.length = 0;
  const now = Date.now.bind(Date);
  const clock = spyOn(Date, 'now').mockImplementation(() => now() + 61_000);
  try {
    // A minute later the open and the closed PR are read again; the merged one is kept as stored.
    expect((await links.list(threadId)).map(p => [p.number, p.state])).toEqual([[1, 'MERGED'], [2, 'OPEN'], [3, 'CLOSED']]);
    expect(calls.sort()).toEqual([pr(2).url, pr(3).url]);
    calls.length = 0;
    expect((await links.list(threadId, true)).map(p => p.number)).toEqual([1, 2, 3]);
    expect(calls.sort()).toEqual([pr(1).url, pr(2).url, pr(3).url]);
  } finally { clock.mockRestore(); }
});

test('dependency ordering separates repositories, forks and ambiguous branch names and terminates on cycles', () => {
  expect(orderPullRequests([pr(3, 'feature-2'), pr(1), pr(2, 'feature-1')]).map(p => p.number)).toEqual([1, 2, 3]);
  expect(orderPullRequests([pr(2, 'feature-1'), { ...pr(1), headRepository: 'fork/repo' }]).map(p => p.number)).toEqual([2, 1]);
  expect(orderPullRequests([pr(1, 'feature-2'), pr(2, 'feature-1')])).toHaveLength(2);
  for (const url of ['http://github.com/a/b/pull/1', 'https://user:pass@github.com/a/b/pull/1', 'https://github.com:123/a/b/pull/1', 'https://github.com/a/b/issues/1', 'https://github.com/a/b/pull/9007199254740999']) expect(() => pullRequestAddress(url)).toThrow();
});

test('agent links are thread scoped, saved only after verification, and events reach subscribed clients', async () => {
  const owner = await harness.connect(), { threadId } = await echoThread(harness, owner);
  const agent = await connect(harness.url, harness.core.agents.tokenFor(threadId), { client: { name: 'boite-cli', version: 'test' } });
  const spawn = harness.core.procs.spawn.bind(harness.core.procs);
  const views: string[][] = [];
  const run = spyOn(harness.core.procs, 'spawn').mockImplementation((scope, command, args, options) => {
    expect(command).toBe('gh');
    // The repository's page comes first; this pull request is not on it.
    if (args[0] === 'api') return spawn(scope, process.execPath, ['-e', 'console.log("[]")'], options);
    expect(args.slice(0, 2)).toEqual(['pr', 'view']);
    views.push(args);
    return spawn(scope, process.execPath, ['-e', `console.log(${JSON.stringify(JSON.stringify({ number: 1, url: pr(1).url, title: 'Change 1', state: 'OPEN', isDraft: false, headRefName: 'feature-1', baseRefName: 'main', headRepository: { name: 'repo' }, headRepositoryOwner: { login: 'example' } }))})`], options);
  });
  try {
    await owner.call('threads.subscribe', { threadId });
    const event = owner.next('threads.pullRequestsChanged', p => p.threadId === threadId);
    const result = await agent.call('threads.linkPullRequest', { threadId, url: pr(1).url });
    expect(result[0]).toMatchObject({ number: 1, headRepository: 'example/repo' });
    expect((await event).pullRequests).toEqual(result);
    expect(await thrown(agent.call('threads.linkPullRequest', { threadId: 'other', url: pr(1).url }))).toThrow('not thread');
    expect(await thrown(agent.call('threads.linkPullRequest', { threadId, url: 'https://attacker.example/a/b/pull/1' }))).toThrow('host');
    expect(views).toHaveLength(1);
    expect(await agent.call('threads.unlinkPullRequest', { threadId, url: pr(1).url })).toEqual([]);
  } finally { agent.close(); run.mockRestore(); }
});

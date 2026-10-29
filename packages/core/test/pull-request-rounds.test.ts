import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { echoThread, startTestCore, type TestCore } from './harness.ts';

let harness: TestCore;
let restore: (() => void) | undefined;
beforeEach(async () => { harness = await startTestCore(); });
afterEach(async () => { restore?.(); restore = undefined; await harness.stop(); });

type World = { number: number; headRefName: string; state: 'OPEN' | 'CLOSED' | 'MERGED'; updatedAt: string }[];
const HOUR = 3_600_000;
const url = (number: number) => `https://github.com/example/repo/pull/${number}`;

/**
 * A gh that answers from a repository file the test rewrites: the GraphQL page
 * sorts by last update and stops at 100, `pr list` sorts newest first and
 * honours its limit, `--head` filters one branch, `pr view` names one URL.
 */
const FAKE_GH = `
const [file, ...args] = process.argv.slice(2);
const prs = JSON.parse(await Bun.file(file).text()).map(pr => ({ ...pr, url: 'https://github.com/example/repo/pull/' + pr.number,
  headRefOid: 'a'.repeat(40), isCrossRepository: false, mergedAt: pr.state === 'MERGED' ? pr.updatedAt : null, title: 'Change ' + pr.number,
  isDraft: false, baseRefName: 'main', headRepository: { name: 'repo' }, headRepositoryOwner: { login: 'example' } }));
const limit = Number(args[args.indexOf('--limit') + 1]) || 30;
let out;
if (args[0] === 'api') out = prs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 100);
else if (args[1] === 'view') { out = prs.find(pr => pr.url === args[2]); if (!out) { console.error('no pull requests found'); process.exit(1); } }
else if (args.includes('--head')) out = prs.filter(pr => pr.headRefName === args[args.indexOf('--head') + 1]).sort((a, b) => b.number - a.number).slice(0, limit);
else out = prs.sort((a, b) => b.number - a.number).slice(0, limit);
console.log(JSON.stringify(out));
`;

/** A repository of 250 pull requests, one updated an hour apart, and `threads` threads on branches with none. */
async function fixture(threads: number) {
  const client = await harness.connect();
  const repo = join(harness.dataDir, 'busy-repo');
  mkdirSync(join(repo, '.git'), { recursive: true });
  const start = Date.now();
  const world: World = Array.from({ length: 250 }, (_, index) => ({
    number: index + 1, headRefName: `old-${index + 1}`, state: 'MERGED', updatedAt: new Date(start - (250 - index) * HOUR).toISOString(),
  }));
  const ids: string[] = [];
  for (let index = 0; index < threads; index++) {
    const { threadId } = await echoThread(harness, client);
    harness.core.journal.putThread({ ...harness.core.threads.require(threadId), cwd: repo, branch: `topic-${index}` });
    ids.push(threadId);
  }
  const worldFile = join(harness.dataDir, 'gh-world.json'), script = join(harness.dataDir, 'fake-gh.ts');
  writeFileSync(script, FAKE_GH);
  const save = () => writeFileSync(worldFile, JSON.stringify(world));
  save();
  const calls: string[][] = [];
  const spawn = harness.core.procs.spawn.bind(harness.core.procs);
  const replacement = spyOn(harness.core.procs, 'spawn').mockImplementation((scope, command, args, options) => {
    if (command === 'git') return spawn(scope, process.execPath, ['-e', 'console.log("origin\\thttps://github.com/example/repo.git (fetch)")'], options);
    calls.push(args);
    return spawn(scope, process.execPath, [script, worldFile, ...args], options);
  });
  let offset = 0;
  const clock = spyOn(Date, 'now').mockImplementation(() => start + offset);
  restore = () => { replacement.mockRestore(); clock.mockRestore(); };
  // The core's own reader: conversation links read through it too.
  const reader = harness.core.pullRequests;
  return {
    client, ids, world, calls, reader,
    /** A change on GitHub. */
    change(apply: (world: World) => void) { apply(world); save(); },
    /** The next round of the UI's polling, `seconds` later: every thread asks once. */
    async round(seconds = 15) {
      offset += seconds * 1000;
      calls.length = 0;
      const results = await Promise.all(ids.map(id => reader.read(id)));
      return { results, gh: calls.length };
    },
    at: (seconds = 0) => new Date(start + offset + seconds * 1000).toISOString(),
  };
}

test('threads on branches without a pull request cost one gh call per round, not one each', async () => {
  const f = await fixture(6);
  const first = await f.round(0);
  expect(first.results).toEqual([null, null, null, null, null, null]);
  // The first round reads the page, then each branch once: nothing older was ever read.
  expect(first.gh).toBe(7);
  for (let round = 0; round < 3; round++) {
    const next = await f.round();
    expect(next.results).toEqual([null, null, null, null, null, null]);
    expect(next.gh).toBe(1);
  }
});

test('a pull request opened on a known branch shows in the next round from the page alone', async () => {
  const f = await fixture(2);
  await f.round(0);
  f.change(world => world.push({ number: 251, headRefName: 'topic-1', state: 'OPEN', updatedAt: f.at(5) }));
  const next = await f.round();
  expect(next.results).toEqual([null, { number: 251, url: url(251), state: 'OPEN' }]);
  expect(next.gh).toBe(1);
});

test('an old pull request that changes state shows from the page, for its branch and its link', async () => {
  const f = await fixture(2);
  // The oldest pull request, far below the page, moves to topic-0; the second thread links the next one.
  f.change(world => {
    Object.assign(world[0]!, { headRefName: 'topic-0', state: 'OPEN' });
    world[1]!.state = 'OPEN';
  });
  harness.core.journal.putThread({ ...harness.core.threads.require(f.ids[1]!), branch: null });
  await f.client.call('threads.linkPullRequest', { threadId: f.ids[1]!, url: url(2) });
  const first = await f.round(0);
  expect(first.results).toEqual([{ number: 1, url: url(1), state: 'OPEN' }, { number: 2, url: url(2), state: 'OPEN' }]);
  const quiet = await f.round();
  expect(quiet.gh).toBe(1);
  f.change(world => {
    Object.assign(world[0]!, { state: 'MERGED', updatedAt: f.at(5) });
    Object.assign(world[1]!, { state: 'CLOSED', updatedAt: f.at(5) });
  });
  const next = await f.round();
  expect(next.results).toEqual([{ number: 1, url: url(1), state: 'MERGED' }, { number: 2, url: url(2), state: 'CLOSED' }]);
  expect(next.gh).toBe(1);
});

test('a page that no longer reaches the previous one makes each branch ask again', async () => {
  const f = await fixture(2);
  await f.round(0);
  // An hour without a round, and more than a page of updates meanwhile.
  f.change(world => { for (const [index, pr] of world.slice(0, 120).entries()) pr.updatedAt = f.at(60 + index * 25); });
  const gap = await f.round(3600);
  expect(gap.results).toEqual([null, null]);
  expect(gap.gh).toBe(3);
  expect(f.calls.filter(args => args.includes('--head')).map(args => args[args.indexOf('--head') + 1]).sort()).toEqual(['topic-0', 'topic-1']);
  expect((await f.round()).gh).toBe(1);
});

test('a partial page cannot hide an older open pull request on a reused branch', async () => {
  const f = await fixture(1);
  f.change(world => {
    Object.assign(world[0]!, { headRefName: 'topic-0', state: 'OPEN' });
    world[249]!.headRefName = 'topic-0';
  });
  const first = await f.round(0);
  expect(first.results).toEqual([{ number: 1, url: url(1), state: 'OPEN' }]);
  expect(first.gh).toBe(2);
  expect((await f.round()).gh).toBe(1);
});

test('a refresh reads the page and the branch again', async () => {
  const f = await fixture(1);
  await f.round(0);
  f.calls.length = 0;
  expect(await f.reader.read(f.ids[0]!, true)).toBeNull();
  expect(f.calls.map(args => args.includes('--head') ? 'head' : args[0])).toEqual(['api', 'head']);
});

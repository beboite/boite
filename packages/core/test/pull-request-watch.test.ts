import { afterEach, expect, spyOn, test } from 'bun:test';
import { AGENT_ENV, type ThreadId } from '@boite/contracts';
import { runCli } from '../src/cli.ts';
import { connect } from '../src/client.ts';
import { PullRequestWatches } from '../src/pull-request-watch.ts';
import { evaluate, initialMemory, mergeChanges, parseDetail, parseRemarks, type Remark, type WatchDetail } from '../src/pull-request-watch-read.ts';
import { echoThread, startTestCore, type TestCore } from './harness.ts';

const URL = 'https://github.com/example/repo/pull/7';
let harness: TestCore | undefined;
afterEach(async () => { await harness?.stop(); harness = undefined; });

// --- What a read decides ----------------------------------------------------

type Run = { name: string; status?: string; conclusion?: string; required?: boolean; completedAt?: string; workflow?: string };
const checkRun = (run: Run) => ({ __typename: 'CheckRun', name: run.name, status: run.status ?? 'COMPLETED', conclusion: run.conclusion ?? 'SUCCESS',
  detailsUrl: `https://github.com/example/repo/actions/runs/1#${run.name}`, startedAt: '2026-10-15T10:00:00Z', completedAt: run.completedAt ?? '2026-10-15T10:05:00Z',
  isRequired: run.required ?? false, checkSuite: { workflowRun: { workflow: { name: run.workflow ?? 'CI' } } } });
const detailJson = (runs: Run[], extra: Record<string, unknown> = {}) => JSON.stringify({ data: { viewer: { login: 'meetsu' }, repository: { pullRequest: {
  url: URL, state: 'OPEN', mergeable: 'MERGEABLE', headRefOid: 'a'.repeat(40), baseRefName: 'main', ...extra,
  commits: { nodes: [{ commit: { oid: 'a'.repeat(40), statusCheckRollup: { contexts: { totalCount: runs.length, nodes: runs.map(checkRun) } } } }] },
} } } });
const detail = (runs: Run[], extra: Partial<WatchDetail> = {}): WatchDetail => ({ ...parseDetail(detailJson(runs)), ...extra });
const remark = (id: string, author: string, at: string, more: Partial<Remark> = {}): Remark => ({
  id: `comment:${id}`, kind: 'comment', author, bot: author.endsWith('[bot]'), body: `said ${id}`, url: `${URL}#issuecomment-${id}`, createdAt: at, editedAt: null, path: null, state: null, ...more });
const since = Date.parse('2026-10-15T09:00:00Z');

test('a check still running keeps its name pending over a finished run of it, in either order', () => {
  const finished = { name: 'test', completedAt: '2026-10-15T10:09:00Z' };
  const running = { name: 'test', status: 'IN_PROGRESS', conclusion: '' };
  for (const runs of [[finished, running], [running, finished]]) expect(detail(runs).checks).toEqual([expect.objectContaining({ name: 'CI / test', status: 'pending' })]);
  // The latest finished run wins when none runs.
  expect(detail([{ name: 'test', conclusion: 'FAILURE', completedAt: '2026-10-15T10:01:00Z' }, { name: 'test', completedAt: '2026-10-15T10:02:00Z' }]).checks[0]!.status).toBe('passed');
});

test('a failure is told once, a rerun failing again is told again, and passing waits for every required check', () => {
  let memory = initialMemory(since);
  let result = evaluate(memory, detail([{ name: 'lint', required: true }, { name: 'test', required: true, status: 'IN_PROGRESS' }, { name: 'docs', conclusion: 'FAILURE' }]), null);
  expect(result.changes).toEqual([{ kind: 'failed', head: 'a'.repeat(40), checks: [{ name: 'CI / docs', conclusion: 'FAILURE', url: expect.stringContaining('https://') }] }]);
  memory = result.next;
  expect(evaluate(memory, detail([{ name: 'lint', required: true }, { name: 'test', required: true, status: 'IN_PROGRESS' }, { name: 'docs', conclusion: 'FAILURE' }]), null).changes).toEqual([]);
  // The rerun leaves the failed list; failing again is news.
  memory = evaluate(memory, detail([{ name: 'docs', status: 'QUEUED', conclusion: '' }]), null).next;
  expect(evaluate(memory, detail([{ name: 'docs', conclusion: 'TIMED_OUT' }]), null).changes[0]).toMatchObject({ kind: 'failed' });
  // Only the required checks gate "passed"; an optional one still failing does not hold it.
  result = evaluate(memory, detail([{ name: 'lint', required: true }, { name: 'test', required: true }, { name: 'docs', conclusion: 'FAILURE' }]), null);
  expect(result.changes).toContainEqual({ kind: 'passed', head: 'a'.repeat(40), count: 2, required: true });
  // A required check that appears already passed is told too.
  const grown = evaluate(result.next, detail([{ name: 'lint', required: true }, { name: 'test', required: true }, { name: 'e2e', required: true }, { name: 'docs', conclusion: 'FAILURE' }]), null);
  expect(grown.changes).toEqual([{ kind: 'passed', head: 'a'.repeat(40), count: 3, required: true }]);
  expect(evaluate(grown.next, detail([{ name: 'lint', required: true }, { name: 'test', required: true }, { name: 'e2e', required: true }, { name: 'docs', conclusion: 'FAILURE' }]), null).changes).toEqual([]);
});

test('remarks count when someone else wrote them or a bot rewrote one, once each, and a conflict is told once', () => {
  const memory = initialMemory(since);
  const old = remark('1', 'reviewer', '2026-10-15T08:00:00Z');
  const mine = remark('2', 'meetsu', '2026-10-15T09:30:00Z');
  const bot = remark('3', 'coderabbitai[bot]', '2026-10-15T09:30:00Z');
  const human = remark('4', 'reviewer', '2026-10-15T09:31:00Z');
  const first = evaluate(memory, detail([]), [old, mine, bot, human]);
  expect(first.changes).toEqual([{ kind: 'remarks', remarks: [expect.objectContaining({ id: 'comment:3' }), expect.objectContaining({ id: 'comment:4' })] }]);
  expect(evaluate(first.next, detail([]), [old, mine, bot, human]).changes).toEqual([]);
  // A bot rewriting its summary is news; a person fixing a typo is not.
  const edited = { ...bot, body: 'new findings', editedAt: '2026-10-15T09:40:00Z' };
  const fixed = { ...human, editedAt: null };
  const second = evaluate(first.next, detail([]), [old, mine, edited, fixed]);
  expect(second.changes).toEqual([{ kind: 'remarks', remarks: [expect.objectContaining({ id: 'comment:3', body: 'new findings' })] }]);
  expect(evaluate(second.next, detail([]), [old, mine, edited, fixed]).changes).toEqual([]);
  // The edit time comes from a bot's `updated_at` only.
  const page = parseRemarks('comment', JSON.stringify([
    { id: 9, user: { login: 'coderabbitai[bot]', type: 'Bot' }, body: 'x', created_at: '2026-10-15T09:00:00Z', updated_at: '2026-10-15T09:10:00Z', html_url: URL },
    { id: 10, user: { login: 'reviewer', type: 'User' }, body: 'y', created_at: '2026-10-15T09:00:00Z', updated_at: '2026-10-15T09:10:00Z', html_url: URL },
  ]));
  expect(page.remarks.map(entry => entry.editedAt)).toEqual(['2026-10-15T09:10:00Z', null]);
  expect(page.full).toBe(false);
  // Conflicts: told once, kept while GitHub still computes, cleared by a clean answer.
  const conflict = evaluate(memory, { ...detail([]), mergeable: 'CONFLICTING' }, null);
  expect(conflict.changes).toEqual([{ kind: 'conflict', base: 'main' }]);
  expect(evaluate(conflict.next, { ...detail([]), mergeable: 'UNKNOWN' }, null).next.conflicting).toBe(true);
  expect(evaluate(conflict.next, { ...detail([]), mergeable: 'CONFLICTING' }, null).changes).toEqual([]);
});

test('a burst folds into one set of changes, and failures of an older head drop once the new head passed', () => {
  const merged = mergeChanges(
    [{ kind: 'failed', head: 'old', checks: [{ name: 'test', conclusion: 'FAILURE', url: '' }] }, { kind: 'remarks', remarks: [{ id: 'a', author: 'x', body: '1', url: '', path: null, state: null }] }],
    [{ kind: 'passed', head: 'new', count: 3, required: true }, { kind: 'remarks', remarks: [{ id: 'a', author: 'x', body: '2', url: '', path: null, state: null }, { id: 'b', author: 'y', body: '3', url: '', path: null, state: null }] }],
  );
  expect(merged).toEqual([
    { kind: 'remarks', remarks: [expect.objectContaining({ id: 'a', body: '2' }), expect.objectContaining({ id: 'b' })] },
    { kind: 'passed', head: 'new', count: 3, required: true },
  ]);
});

// --- The loop, against a scripted gh ----------------------------------------

interface FakeGitHub {
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  mergeable: string;
  head: string;
  runs: Run[];
  comments: unknown[];
  reviews: unknown[];
  inline: unknown[];
  updatedAt: string;
  /** Thrown instead of answering, once per call while set. */
  failure: string | null;
  calls: string[];
}

function fakeGitHub(): FakeGitHub {
  return { state: 'OPEN', mergeable: 'MERGEABLE', head: 'a'.repeat(40), runs: [{ name: 'test', status: 'IN_PROGRESS', conclusion: '' }], comments: [], reviews: [], inline: [], updatedAt: '2026-10-15T09:00:00Z', failure: null, calls: [] };
}

/** What `gh` prints for each call a watch makes. */
async function answer(github: FakeGitHub, args: string[]): Promise<string> {
  const query = args.find(arg => arg.startsWith('query='));
  const path = args.at(-1)!;
  github.calls.push(query ? (query.includes('viewer') ? 'detail' : 'fingerprint') : path.replace(/^repos\/example\/repo\//, ''));
  if (github.failure) throw new Error(github.failure);
  if (query?.includes('viewer')) return detailJson(github.runs, { state: github.state, mergeable: github.mergeable, headRefOid: github.head });
  if (query) {
    const counts = new Map<string, number>();
    for (const run of github.runs) { const key = run.status && run.status !== 'COMPLETED' ? run.status : run.conclusion ?? 'SUCCESS'; counts.set(key, (counts.get(key) ?? 0) + 1); }
    return JSON.stringify({ data: { repository: { pullRequest: { state: github.state, mergeable: github.mergeable, headRefOid: github.head, updatedAt: github.updatedAt,
      comments: { totalCount: github.comments.length, nodes: [] }, reviews: { totalCount: github.reviews.length, nodes: [] }, reviewThreads: { totalCount: 0 },
      commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { checkRunCountsByState: [...counts].map(([state, count]) => ({ state, count })), statusContextCountsByState: [] } } } }] } } } } });
  }
  const page = Number(/[?&]page=(\d+)/.exec(path)![1]);
  const all = path.includes('/reviews') ? github.reviews : path.includes('pulls/') ? github.inline : github.comments;
  return JSON.stringify(all.slice((page - 1) * 100, page * 100));
}

/** GitHub's per-second time, a minute after now: later than any watch a test starts. */
const later = (seconds = 60) => new Date(Math.floor(Date.now() / 1000) * 1000 + seconds * 1000).toISOString().replace('.000Z', 'Z');
const comment = (id: number, login: string, at: string) => ({ id, user: { login, type: login.endsWith('[bot]') ? 'Bot' : 'User' }, body: `comment ${id}`, created_at: at, updated_at: at, html_url: `${URL}#issuecomment-${id}` });

async function watchedThread(timing = { intervalMs: 0, coalesceMs: 0 }) {
  harness = await startTestCore({ pullRequestWatches: timing });
  const owner = await harness.connect();
  const { threadId } = await echoThread(harness, owner);
  harness.core.journal.setSetting(`linked-pull-requests:${threadId}`, [{ url: URL, repository: 'example/repo', number: 7, title: 'Change', state: 'OPEN', draft: false, head: 'feature', base: 'main', headRepository: 'example/repo', checkedAt: Date.now() }]);
  const github = fakeGitHub();
  spyOn(harness.core.pullRequests, 'gh').mockImplementation((_thread, args) => answer(github, args));
  const watches = harness.core.pullRequestWatches;
  // A pass may already run from the timer: the second call starts one that sees the latest state.
  const drive = async () => { await watches.pass(); await watches.pass(); };
  return { owner, threadId: threadId as ThreadId, github, watches, drive };
}

const wakes = (threadId: string) => harness!.core.journal.listTurns(threadId).filter(turn => turn.execution?.operation === 'pull-request');
async function settled(threadId: string): Promise<void> {
  for (let i = 0; i < 200 && harness!.core.journal.listTurns(threadId).some(turn => turn.status === 'queued' || turn.status === 'running'); i++) await Bun.sleep(20);
  for (let i = 0; i < 100 && harness!.core.journal.getThread(threadId)?.status !== 'idle'; i++) await Bun.sleep(20);
}
const wakeText = (threadId: string, turnId: string) => [...harness!.core.journal.walkTurnMessages(threadId, turnId)].find(message => message.role === 'system')!.parts
  .map(part => part.type === 'text' ? part.text : '').join('');

test('a watch reads first without waking, wakes once per change with links, and reads in full only when the fingerprint moves', async () => {
  const { owner, threadId, github, drive } = await watchedThread();
  const watch = await owner.call('threads.watchPullRequest', { threadId });
  expect(watch).toMatchObject({ url: URL, number: 7, paused: null, seen: { head: 'aaaaaaa', checks: { total: 1, running: 1, failed: 0 }, conflicting: false } });
  expect(harness!.core.threads.list({}).find(thread => thread.id === threadId)?.pullRequestWatches).toHaveLength(1);
  expect(github.calls).toEqual(['fingerprint', 'detail', 'issues/7/comments?per_page=100&page=1', 'pulls/7/reviews?per_page=100&page=1', 'pulls/7/comments?per_page=100&page=1']);

  // Nothing moved: one fingerprint per pass, no detail, no wake.
  github.calls = [];
  await drive();
  expect(github.calls.every(call => call === 'fingerprint')).toBe(true);
  expect(wakes(threadId)).toHaveLength(0);

  // The check fails and a bot reviews, with 101 comments so the second page is read too.
  github.runs = [{ name: 'test', conclusion: 'FAILURE' }];
  github.comments = Array.from({ length: 101 }, (_, index) => comment(index + 1, index === 100 ? 'coderabbitai[bot]' : 'meetsu', later()));
  github.updatedAt = '2026-10-15T09:31:00Z';
  github.calls = [];
  await drive();
  expect(github.calls).toContain('issues/7/comments?per_page=100&page=2');
  await settled(threadId);
  expect(wakes(threadId)).toHaveLength(1);
  const text = wakeText(threadId, wakes(threadId)[0]!.id);
  expect(text).toContain(`Pull request #7 (${URL})`);
  expect(text).toContain('Checks failed on aaaaaaa');
  expect(text).toContain('CI / test https://github.com/example/repo/actions/runs/1#test');
  expect(text).toContain(`coderabbitai[bot]: "comment 101" ${URL}#issuecomment-101`);
  expect(text).not.toContain('comment 100');

  // The same state never wakes twice, even when re-read in full.
  github.updatedAt = '2026-10-15T09:32:00Z';
  await drive();
  await settled(threadId);
  expect(wakes(threadId)).toHaveLength(1);

  // A new head that passes, then a conflict.
  github.head = 'b'.repeat(40);
  github.runs = [{ name: 'test' }];
  await drive();
  await settled(threadId);
  expect(wakes(threadId)).toHaveLength(2);
  expect(wakeText(threadId, wakes(threadId)[1]!.id)).toContain('All 1 check passed on bbbbbbb.');
  github.mergeable = 'CONFLICTING';
  await drive();
  await settled(threadId);
  expect(wakeText(threadId, wakes(threadId)[2]!.id)).toContain('The branch now conflicts with main.');

  // A merge ends the watch without a wake.
  github.state = 'MERGED';
  await drive();
  expect(harness!.core.pullRequestWatches.of(threadId)).toEqual([]);
  expect(harness!.core.journal.getSetting(`pr-watches:${threadId}`)).toBeUndefined();
  expect(wakes(threadId)).toHaveLength(3);
});

test('changes while the agent works wait for the turn to end and go out as one message', async () => {
  const { owner, threadId, github, watches, drive } = await watchedThread();
  await owner.call('threads.watchPullRequest', { threadId, url: '7' });
  // A turn that holds the thread busy: the echo agent waits for this prompt's sleep.
  await owner.call('turns.start', { threadId, prompt: 'wait [sleep:600]' });
  for (let i = 0; i < 100 && harness!.core.journal.getThread(threadId)?.status !== 'running'; i++) await Bun.sleep(10);
  github.runs = [{ name: 'test', conclusion: 'FAILURE' }];
  await drive();
  github.comments = [comment(1, 'reviewer', later())];
  github.updatedAt = '2026-10-15T10:00:00Z';
  await drive();
  expect(wakes(threadId)).toHaveLength(0);
  await settled(threadId);
  await drive();
  await settled(threadId);
  expect(wakes(threadId)).toHaveLength(1);
  const text = wakeText(threadId, wakes(threadId)[0]!.id);
  expect(text).toContain('Checks failed');
  expect(text).toContain('reviewer: "comment 1"');
  expect(watches.of(threadId)).toHaveLength(1);
});

test('a rate limit pauses every read until it passes, an unreachable GitHub only delays, and the watch survives a restart', async () => {
  const { owner, threadId, github, watches } = await watchedThread({ intervalMs: 40, coalesceMs: 0 });
  await owner.call('threads.watchPullRequest', { threadId });
  github.failure = 'gh: API rate limit exceeded for user ID 1. (HTTP 403)';
  await Bun.sleep(50);
  await watches.pass();
  expect(watches.of(threadId)[0]!.paused).toMatchObject({ reason: 'rate-limit' });
  github.failure = null;
  github.calls = [];
  await watches.pass();
  expect(github.calls).toEqual([]);
  await Bun.sleep(120);
  await watches.pass();
  // Reads resume once the pause passed, the background timer's included.
  expect(github.calls.length).toBeGreaterThan(0);
  expect(github.calls.every(call => call === 'fingerprint')).toBe(true);
  expect(watches.of(threadId)[0]!.paused).toBeNull();

  github.failure = 'error connecting to api.github.com';
  await Bun.sleep(50);
  await watches.pass();
  expect(watches.of(threadId)[0]!.paused).toMatchObject({ reason: 'unreachable', message: 'error connecting to api.github.com' });

  // A new store over the same journal (a restarted core) picks the watch up, with what it was told.
  const restarted = new PullRequestWatches(harness!.core, (_thread, args) => answer(github, args), { intervalMs: 0, coalesceMs: 0 });
  try {
    github.failure = null;
    expect(restarted.of(threadId)).toEqual([expect.objectContaining({ url: URL, seen: expect.objectContaining({ head: 'aaaaaaa' }) })]);
    await Bun.sleep(2_100);
    await restarted.pass();
    expect(restarted.of(threadId)[0]!.paused).toBeNull();
  } finally { await restarted.close(); }
});

test('Stop, unwatch and archive end watches, and the refusals name what is wrong', async () => {
  const { owner, threadId, github } = await watchedThread();
  await expect(owner.call('threads.watchPullRequest', { threadId, url: '8' })).rejects.toThrow('no linked pull request is #8');
  await expect(owner.call('threads.watchPullRequest', { threadId, url: 'https://gitlab.example/a/b/pull/1' })).rejects.toThrow('host');
  await owner.call('threads.watchPullRequest', { threadId });
  // The loop rests a second between its own passes even when a read is due at once:
  // re-arming at 0 ms kept a Windows event loop from reaching anything else.
  const before = github.calls.length;
  await Bun.sleep(300);
  expect(github.calls.length - before).toBeLessThanOrEqual(1);
  expect((await owner.call('turns.stop', { threadId })).stopped).toBe(true);
  expect(harness!.core.pullRequestWatches.of(threadId)).toEqual([]);

  // The agent's CLI: watch prints what the first read saw, unwatch what is left.
  const boite = async (...args: string[]) => {
    let out = '';
    const code = await runCli(args, { out: text => { out += text; }, err: text => { out += text; }, cwd: harness!.dataDir,
      env: { [AGENT_ENV.threadId]: threadId, [AGENT_ENV.coreUrl]: harness!.url, [AGENT_ENV.token]: harness!.core.agents.tokenFor(threadId) } });
    return { code, out };
  };
  expect(await boite('pr', 'watch', URL)).toEqual({ code: 0, out: expect.stringContaining(`watching #7 ${URL}: head aaaaaaa; 1 checks, 1 running, 0 failed`) });
  await expect(owner.call('threads.unwatchPullRequest', { threadId, url: '#9' })).rejects.toThrow('does not watch #9');
  expect(await boite('pr', 'unwatch', '7')).toEqual({ code: 0, out: expect.stringContaining('no pull request watched') });

  // An agent watches its own thread; a paired phone may stop a watch, not start one.
  const agent = await connect(harness!.url, harness!.core.agents.tokenFor(threadId), { client: { name: 'boite-cli', version: 'test' } });
  const { grant } = await owner.call('pairing.grant', {});
  const phone = await connect(harness!.url, '', { grant });
  try {
    await agent.call('threads.watchPullRequest', { threadId });
    await expect(phone.call('threads.watchPullRequest', { threadId })).rejects.toThrow('owner');
    expect(await phone.call('threads.unwatchPullRequest', { threadId })).toEqual([]);
  } finally { agent.close(); phone.close(); }

  await owner.call('threads.watchPullRequest', { threadId });
  await owner.call('threads.archive', { threadId });
  expect(harness!.core.pullRequestWatches.of(threadId)).toEqual([]);
  expect(harness!.core.journal.getSetting(`pr-watches:${threadId}`)).toBeUndefined();

  // A merged pull request has nothing to watch.
  await owner.call('threads.archive', { threadId, archived: false });
  github.state = 'MERGED';
  await expect(owner.call('threads.watchPullRequest', { threadId })).rejects.toThrow('is merged');
});

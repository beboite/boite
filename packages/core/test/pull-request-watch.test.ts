import { afterEach, expect, spyOn, test } from 'bun:test';
import { AGENT_ENV, DEFAULT_DELEGATION_CONFIG, type ThreadId } from '@boite/contracts';
import { runCli, watchStatus } from '../src/cli.ts';
import { connect } from '../src/client.ts';
import { Core } from '../src/core.ts';
import { Retirements } from '../src/delegation/retirement.ts';
import { PullRequestWatches } from '../src/pull-request-watch.ts';
import { evaluate, initialMemory, mergeChanges, parseDetail, parseRemarks, stillTrue, wakeMessage, type Remark, type WatchDetail } from '../src/pull-request-watch-read.ts';
import { parseProtection, parseRules, withRequired } from '../src/pull-request-required.ts';
import { echoThread, startTestCore, waitFor, type TestCore } from './harness.ts';
import { thrown } from './settle.ts';

const URL = 'https://github.com/example/repo/pull/7';
let harness: TestCore | undefined;
afterEach(async () => { await harness?.stop(); harness = undefined; });

// --- What a read decides ----------------------------------------------------

/** A CI job, or with `context` a commit status such as CodeRabbit's (`status` is then its state). */
type Run = { name: string; status?: string; conclusion?: string; required?: boolean; startedAt?: string; completedAt?: string; workflow?: string; context?: boolean };
const checkRun = (run: Run) => run.context ? { __typename: 'StatusContext', context: run.name, state: run.status ?? 'SUCCESS', targetUrl: 'https://coderabbit.ai', createdAt: run.completedAt ?? '2026-10-15T10:05:00Z', isRequired: run.required ?? false } : ({ __typename: 'CheckRun', name: run.name, status: run.status ?? 'COMPLETED', conclusion: run.conclusion ?? 'SUCCESS',
  detailsUrl: `https://github.com/example/repo/actions/runs/1#${run.name}`, startedAt: run.startedAt ?? '2026-10-15T10:00:00Z', completedAt: run.completedAt ?? '2026-10-15T10:05:00Z',
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

test('remarks count when someone else wrote them, once each, a bot rewriting one is not news, and a conflict or falling behind is told once', () => {
  const memory = initialMemory(since);
  const old = remark('1', 'reviewer', '2026-10-15T08:00:00Z');
  const mine = remark('2', 'meetsu', '2026-10-15T09:30:00Z');
  const bot = remark('3', 'coderabbitai[bot]', '2026-10-15T09:30:00Z');
  const human = remark('4', 'reviewer', '2026-10-15T09:31:00Z');
  const first = evaluate(memory, detail([]), [old, mine, bot, human]);
  expect(first.changes).toEqual([{ kind: 'remarks', remarks: [expect.objectContaining({ id: 'comment:3' }), expect.objectContaining({ id: 'comment:4' })] }]);
  expect(evaluate(first.next, detail([]), [old, mine, bot, human]).changes).toEqual([]);
  // A bot rewriting its comment in place and a person fixing a typo are no news.
  const edited = { ...bot, body: 'reworded', editedAt: '2026-10-15T09:40:00Z' };
  const fixed = { ...human, editedAt: null };
  const second = evaluate(first.next, detail([]), [old, mine, edited, fixed]);
  expect(second.changes).toEqual([]);
  expect(second.next.remarksThrough).toBe('2026-10-15T09:40:00.000Z');
  // The edit time comes from a bot's `updated_at` only.
  const page = parseRemarks('comment', JSON.stringify([
    { id: 9, user: { login: 'coderabbitai[bot]', type: 'Bot' }, body: 'x', created_at: '2026-10-15T09:00:00Z', updated_at: '2026-10-15T09:10:00Z', html_url: URL },
    { id: 10, user: { login: 'reviewer', type: 'User' }, body: 'y', created_at: '2026-10-15T09:00:00Z', updated_at: '2026-10-15T09:10:00Z', html_url: URL },
  ]));
  expect(page.remarks.map(entry => entry.editedAt)).toEqual(['2026-10-15T09:10:00Z', null]);
  expect(page.full).toBe(false);
  expect(parseRemarks('review-comment', JSON.stringify([
    { id: 4303360301, user: { login: 'coderabbitai[bot]', type: 'Bot' }, body: 'finding', path: 'a.ts', created_at: '2026-10-15T09:00:00Z', updated_at: '2026-10-15T09:00:00Z', html_url: URL },
    { id: 4303402494, in_reply_to_id: 4303360301, user: { login: 'coderabbitai[bot]', type: 'Bot' }, body: 'thanks', path: 'a.ts', created_at: '2026-10-15T09:01:00Z', updated_at: '2026-10-15T09:01:00Z', html_url: URL },
  ])).remarks.map(entry => entry.reply)).toEqual([false, true]);
  // Conflicts: told once, kept while GitHub still computes, cleared by a clean answer.
  const conflict = evaluate(memory, { ...detail([]), mergeable: 'CONFLICTING' }, null);
  expect(conflict.changes).toEqual([{ kind: 'conflict', base: 'main' }]);
  expect(evaluate(conflict.next, { ...detail([]), mergeable: 'UNKNOWN' }, null).next.conflicting).toBe(true);
  expect(evaluate(conflict.next, { ...detail([]), mergeable: 'CONFLICTING' }, null).changes).toEqual([]);
  // Behind a base that requires branches up to date: told once, kept while GitHub computes, cleared by a clean answer, never while queued.
  expect(parseDetail(detailJson([], { mergeStateStatus: 'BEHIND' })).behind).toBe(true);
  expect(parseDetail(detailJson([], { mergeStateStatus: 'UNKNOWN' })).behind).toBeNull();
  const behind = evaluate(memory, { ...detail([]), behind: true }, null);
  expect(behind.changes).toEqual([{ kind: 'behind', base: 'main' }]);
  expect(evaluate(behind.next, { ...detail([]), behind: null }, null).next.behind).toBe(true);
  expect(evaluate(behind.next, { ...detail([]), behind: true }, null).changes).toEqual([]);
  expect(evaluate(evaluate(behind.next, { ...detail([]), behind: false }, null).next, { ...detail([]), behind: true }, null).changes).toEqual([{ kind: 'behind', base: 'main' }]);
  expect(evaluate(memory, { ...detail([]), behind: true, queue: 1 }, null).changes).toEqual([]);
  // A warning still held when the branch is updated or queued is not told.
  const queued = evaluate(behind.next, { ...detail([]), behind: true, queue: 1 }, null).next;
  expect(stillTrue(behind.changes, queued)).toEqual([]);
  expect(stillTrue(behind.changes, evaluate(behind.next, { ...detail([]), behind: false }, null).next)).toEqual([]);
  expect(stillTrue(behind.changes, behind.next)).toEqual(behind.changes);
  expect(wakeMessage([{ number: 7, url: URL, changes: behind.changes }])).toMatchObject({ label: 'Pull request update, #7: behind base' });
});

// Bodies as CodeRabbit and mtsu-patrol posted them on beboite/boite #441, #567 and #583, trimmed.
const QUOTA = '<!-- This is an auto-generated comment: summarize by coderabbit.ai -->\n<!-- This is an auto-generated comment: rate limited by coderabbit.ai -->\n\n> [!WARNING]\n> ## Review limit reached\n> \n> You\'ve used all free OSS reviews for now. Wait for the free limit to reset to keep reviewing this public repository.\n> \n> **Next included review available in 35 minutes.**';
const WALKTHROUGH = '<!-- This is an auto-generated comment: summarize by coderabbit.ai -->\n<!-- review_stack_entry_start -->\n\n<a href="https://app.coderabbit.ai/change-stack/beboite/boite/pull/566"><picture><img alt="Review in Change Stack →" height="32"></picture></a>\n\n<!-- walkthrough_start -->\n\n<details>\n<summary><strong>📝 Walkthrough</strong></summary>\n\nThis pull request adds sleeping for idle browser tabs.';
const CR_REVIEW = (count: number) => `**Actionable comments posted: ${count}**\n\n---\n\n<!-- autofix_checkbox_start -->\n- [ ] <!-- {"checkboxId":"4b0d0e0a"} --> 🪄 Fix comments: Fix CodeRabbit comments on this PR\n<!-- autofix_checkbox_end -->`;
const CR_OUTSIDE = '**Actionable comments posted: 0**\n\n> [!CAUTION]\n> Some comments are outside the diff and can’t be posted inline due to GitHub limitations.\n> \n> **⚠️ Outside diff range comments (1)**';
const CR_INLINE = '**🎯 Functional Correctness** | **🟡 Minor** | **⚡ Quick win**\n\n**Pass the kept pause origin to `stop`.**\n\nThe comment on Line 242 says that saving other settings of a paused team keeps the recorded pause origin.';
const CR_REPLY = '@klNuno Thanks for the fix. The supplied code passes both `pause.by` and `pause.at` from `configure` to `stop`, which forwards them to `pause`.\n\nThe reported regression test covers the original failure path.\n\n---\n\nIf you found this review helpful, would you consider giving us a shout-out on X?';
const CR_WITHDRAW = '@klNuno, you’re right. I withdraw this finding. Thanks for clarifying the pause contract.\n\n`adopt` records an already-started turn as the step’s attempt. It does not start or authorize a turn.';
const CR_CONCEDE = '@klNuno You’re right about the retry, but the fix is still incomplete: the cancellation handler does not release its lock.';
const CR_PUSHBACK = '@klNuno Thanks for the update, but the fix is incomplete: `stop` still drops the recorded origin when the team has live work.';
const PATROL_REVIEW = '<!-- mtsu-patrol:297ca19b-7b01-4632-8bc8-075409846b6b -->\n\n**Actionable comments posted: 0**\n\n<details>\n<summary>Outside diff range comments (1)</summary>\n\n`L90-L104`: **Missing letter marks landed, pending letter never flashes**';
const PATROL_SUMMARY = (posted: boolean, head: string) => `<!-- mtsu-patrol:summary -->\n<!-- mtsu-patrol:9017fed0 -->\n\nThis pull request makes a discussion opened on a missing letter land at the end.\n\n${posted ? '**Comments posted**: no critical or major finding.\n\n1 minor in [the review](https://github.com/beboite/boite/pull/441#pullrequestreview-5485468072).' : '**No comments posted**: the reviewers raised no finding.'}\n\n<details>\n<summary>Review details</summary>\n\n- Compared commits: \`e7b2b8c\` to \`${head}\`\n\n</details>`;

test('a bot wakes the agent for findings only: quota notices, summaries, empty counts and in-place rewrites stay quiet', () => {
  const at = '2026-10-15T09:30:00Z', later = '2026-10-15T09:50:00Z';
  const told = (remarks: Remark[], memory = initialMemory(since)) => {
    const result = evaluate(memory, detail([]), remarks);
    return { ids: result.changes.flatMap(change => change.kind === 'remarks' ? change.remarks.map(entry => entry.id) : []), next: result.next };
  };
  const rabbit = 'coderabbitai[bot]', patrol = 'mtsu-patrol[bot]';
  const kept = [
    remark('10', rabbit, at, { kind: 'review', id: 'review:10', body: CR_REVIEW(4), state: 'COMMENTED' }),
    remark('11', rabbit, at, { kind: 'review', id: 'review:11', body: CR_OUTSIDE, state: 'COMMENTED' }),
    remark('12', patrol, at, { kind: 'review', id: 'review:12', body: PATROL_REVIEW, state: 'CHANGES_REQUESTED' }),
    remark('13', rabbit, at, { kind: 'review-comment', id: 'review-comment:13', body: CR_INLINE, path: 'packages/core/src/delegation.ts' }),
    remark('14', rabbit, at, { kind: 'review-comment', id: 'review-comment:14', body: CR_PUSHBACK, path: 'packages/core/src/delegation.ts', reply: true }),
    remark('15', patrol, at, { body: PATROL_SUMMARY(true, '7723c1b') }),
    remark('16', 'dependabot[bot]', at, { body: 'Looks like rustls is up-to-date now, so this is no longer needed.' }),
    remark('17', 'reviewer', at, { kind: 'review', id: 'review:17', body: '', state: 'APPROVED' }),
    // A finding about rate limits is a finding, inline or in a comment that is not a notice heading.
    remark('18', rabbit, at, { kind: 'review-comment', id: 'review-comment:18', body: '**🎯 Functional Correctness** | **🟡 Minor**\n\n## Rate limit exceeded is retried forever\n\n`rateLimited` matches "rate limit exceeded" and never gives up.', path: 'packages/core/src/pull-request-watch.ts' }),
    remark('19', 'dependabot[bot]', at, { body: 'GitHub answered "rate limit exceeded" while fetching the changelog; the update is still opened.' }),
    // Conceding a point then turning against the fix keeps the thread open.
    remark('27', rabbit, at, { kind: 'review-comment', id: 'review-comment:27', body: CR_CONCEDE, path: 'packages/core/src/delegation.ts', reply: true }),
  ];
  const dropped = [
    remark('20', rabbit, at, { body: QUOTA }),
    remark('21', rabbit, at, { body: WALKTHROUGH }),
    remark('22', rabbit, at, { kind: 'review', id: 'review:22', body: CR_REVIEW(0), state: 'COMMENTED' }),
    remark('23', rabbit, at, { kind: 'review', id: 'review:23', body: '', state: 'APPROVED' }),
    remark('24', patrol, at, { body: PATROL_SUMMARY(false, '66df392') }),
    remark('25', rabbit, at, { kind: 'review-comment', id: 'review-comment:25', body: CR_REPLY, path: 'packages/core/src/delegation.ts', reply: true }),
    remark('26', rabbit, at, { kind: 'review-comment', id: 'review-comment:26', body: CR_WITHDRAW, path: 'packages/core/src/workflows.ts', reply: true }),
  ];
  const first = told([...kept, ...dropped]);
  expect(first.ids).toEqual(kept.map(entry => entry.id));

  // The walkthrough rewritten into the quota notice and back, the inline finding marked addressed: all quiet.
  const rewritten = [
    { ...dropped[1]!, body: QUOTA, editedAt: '2026-10-15T09:40:00Z' },
    { ...kept[3]!, body: `${CR_INLINE}\n\n✅ Addressed in commit ca0bf65`, editedAt: '2026-10-15T09:41:00Z' },
    { ...kept[5]!, body: PATROL_SUMMARY(false, '9a1b2c3'), editedAt: '2026-10-15T09:42:00Z' },
  ];
  const second = told(rewritten, first.next);
  expect(second.ids).toEqual([]);
  expect(told([{ ...dropped[1]!, body: WALKTHROUGH, editedAt: later }], second.next).ids).toEqual([]);
  // The summary rewritten for a new head that again names findings is news, once.
  const head = { ...kept[5]!, body: PATROL_SUMMARY(true, 'd4e5f6a'), editedAt: later };
  const third = told([head], second.next);
  expect(third.ids).toEqual(['comment:15']);
  // Read again with only its markup moved (a later reread at the same second): no news.
  expect(told([{ ...head, body: head.body.replace('<!-- mtsu-patrol:9017fed0 -->', '<!-- mtsu-patrol:00000000 -->') }], { ...third.next, remarkIds: [] }).ids).toEqual([]);
  // A bot's new comment that is only a notice stays quiet; a person's always counts.
  expect(told([remark('30', rabbit, later, { body: '> [!WARNING]\n> ## Rate limit exceeded\n> Please wait 12 minutes.' }), remark('31', 'reviewer', later)], first.next).ids).toEqual(['comment:31']);
  // Watches saved before bodies were kept read on.
  const saved = structuredClone(first.next);
  delete saved.bodies;
  expect(told([remark('32', 'reviewer', later)], saved).ids).toEqual(['comment:32']);
});

test('CI wakes on its first failure and on its verdict, not on each check that finishes', () => {
  const head = 'a'.repeat(40);
  const title = { name: 'PR title', workflow: 'pr title', required: true };
  const job = (name: string, more: Partial<Run> = {}) => ({ name, workflow: 'ci', ...more });
  const running = { status: 'IN_PROGRESS', conclusion: '' };
  // "CI required" needs every other job: it starts once they all ended.
  const gate = (more: Partial<Run> = {}) => job('CI required', { required: true, startedAt: '2026-10-15T10:06:00Z', completedAt: '2026-10-15T10:06:10Z', ...more });
  const rabbit = { name: 'CodeRabbit', context: true, status: 'PENDING' };
  let memory = initialMemory(since);
  const step = (runs: Run[]) => { const result = evaluate(memory, detail(runs), null); memory = result.next; return result.changes; };
  // beboite/boite requires "PR title", done in seconds, and "CI required", which exists only once every job finished.
  expect(step([title, job('Core tests', running), job('Build UI', running), rabbit])).toEqual([]);
  expect(step([title, job('Core tests'), job('Build UI', running), rabbit])).toEqual([]);
  expect(step([title, job('Core tests'), job('Build UI'), gate(running), rabbit])).toEqual([]);
  expect(step([title, job('Core tests'), job('Build UI'), gate(), rabbit])).toEqual([{ kind: 'passed', head, count: 2, required: true }]);
  // CodeRabbit's status settling, a title edit rerunning "PR title": no second "passed".
  expect(step([title, job('Core tests'), job('Build UI'), gate(), { ...rabbit, status: 'SUCCESS' }])).toEqual([]);
  expect(step([{ ...title, ...running }, job('Core tests'), job('Build UI'), gate()])).toEqual([]);
  expect(step([title, job('Core tests'), job('Build UI'), gate()])).toEqual([]);

  // A new head: the first failure wakes at once, the next ones wait for the jobs to settle.
  memory = { ...memory, head: 'old' };
  const failedNames = (changes: ReturnType<typeof step>) => changes.flatMap(change => change.kind === 'failed' ? change.checks.map(check => check.name) : []);
  expect(failedNames(step([title, job('Core tests', { conclusion: 'FAILURE' }), job('Build UI', running), job('E2E', running)]))).toEqual(['ci / Core tests']);
  expect(step([title, job('Core tests', { conclusion: 'FAILURE' }), job('Build UI', { conclusion: 'FAILURE' }), job('E2E', running)])).toEqual([]);
  expect(failedNames(step([title, job('Core tests', { conclusion: 'FAILURE' }), job('Build UI', { conclusion: 'FAILURE' }), job('E2E'), gate({ conclusion: 'FAILURE' })])))
    .toEqual(['ci / Build UI', 'ci / CI required']);
  // The required gate failing alone after a job already did says nothing new.
  memory = { ...memory, head: 'older' };
  expect(step([title, job('Core tests', { conclusion: 'FAILURE' }), job('E2E', running)])).toHaveLength(1);
  expect(step([title, job('Core tests', { conclusion: 'FAILURE' }), job('E2E'), gate({ conclusion: 'FAILURE' })])).toEqual([]);
  // A required job of its own failing after another job did is news: it ran beside it, it does not sum it up.
  memory = { ...memory, head: 'oldest' };
  expect(failedNames(step([title, job('lint', { conclusion: 'FAILURE' }), job('security', { required: true, ...running })]))).toEqual(['ci / lint']);
  expect(failedNames(step([title, job('lint', { conclusion: 'FAILURE' }), job('security', { required: true, conclusion: 'FAILURE', completedAt: '2026-10-15T10:07:00Z' })]))).toEqual(['ci / security']);
  memory = { ...memory, head: 'older' };
  step([title, job('Core tests', { conclusion: 'FAILURE' }), job('E2E'), gate({ conclusion: 'FAILURE' })]);
  // Rerun after the fix.
  step([title, job('Core tests', running), job('Build UI', running), job('E2E'), gate(running)]);
  // Rerun and passing: the verdict is news again after a failure.
  expect(step([title, job('Core tests', running), job('Build UI', running), job('E2E'), gate(running)])).toEqual([]);
  expect(step([title, job('Core tests'), job('Build UI'), job('E2E'), gate()])).toEqual([{ kind: 'passed', head, count: 2, required: true }]);

  // Where nothing is required: one "passed" per head, a check joining later is no news, a commit status pending for good holds nothing.
  memory = initialMemory(since);
  expect(step([job('test'), rabbit])).toEqual([{ kind: 'passed', head, count: 1, required: false }]);
  expect(step([job('test'), job('label'), rabbit])).toEqual([]);
  // Commit statuses alone are the CI.
  memory = initialMemory(since);
  expect(step([{ name: 'jenkins', context: true, status: 'PENDING' }])).toEqual([]);
  expect(step([{ name: 'jenkins', context: true, status: 'SUCCESS' }])).toEqual([{ kind: 'passed', head, count: 1, required: false }]);
});

test('the base branch names what it requires through its rulesets and its classic protection, reported or not', () => {
  expect(parseRules(JSON.stringify([{ type: 'deletion' }, { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'CI required', integration_id: 15368 }, { context: 'PR title' }] } }]))).toEqual(['CI required', 'PR title']);
  expect(parseRules('[]')).toEqual([]);
  expect(parseProtection(JSON.stringify({ protection: { enabled: true, required_status_checks: { enforcement_level: 'everyone', contexts: ['lint'], checks: [{ context: 'build', app_id: null }] } } }))).toEqual(['lint', 'build']);
  expect(parseProtection(JSON.stringify({ protection: { enabled: false, required_status_checks: { enforcement_level: 'off', contexts: [], checks: [] } } }))).toEqual([]);
  // A check run matches by its own name, its workflow aside; a context with no check yet waits as GitHub's "Expected".
  const checks = withRequired(detail([{ name: 'CI required' }, { name: 'test' }]), ['CI required', 'PR title']).checks;
  expect(checks.map(({ name, status, required, conclusion }) => ({ name, status, required, conclusion }))).toEqual([
    { name: 'CI / CI required', status: 'passed', required: true, conclusion: 'SUCCESS' },
    { name: 'CI / test', status: 'passed', required: false, conclusion: 'SUCCESS' },
    { name: 'PR title', status: 'pending', required: true, conclusion: 'EXPECTED' },
  ]);
  expect(evaluate(initialMemory(since), withRequired(detail([{ name: 'CI required' }]), ['CI required', 'PR title']), null).changes).toEqual([]);
});

test('a draft passes on the required checks it reports, without waiting for one it never reports', () => {
  // beboite/boite's draft run names its planning job apart, so a draft never satisfies the ruleset (docs/ci.md#draft-pull-requests).
  const required = ['Plan and repository checks', 'Build UI'];
  const draft = parseDetail(detailJson([{ name: 'Plan and repository checks (draft)' }, { name: 'Build UI' }], { isDraft: true }));
  expect(draft.draft).toBe(true);
  expect(withRequired(draft, required).checks.map(({ name, required }) => ({ name, required }))).toEqual([
    { name: 'CI / Plan and repository checks (draft)', required: false },
    { name: 'CI / Build UI', required: true },
  ]);
  expect(evaluate(initialMemory(since), withRequired(draft, required), null).changes).toEqual([{ kind: 'passed', head: 'a'.repeat(40), count: 1, required: true }]);
  // Once ready, the required name the full run has not created yet waits as GitHub's "Expected".
  const ready = parseDetail(detailJson([{ name: 'Plan and repository checks (draft)' }, { name: 'Build UI' }]));
  expect(ready.draft).toBe(false);
  expect(withRequired(ready, required).checks.at(-1)).toMatchObject({ name: 'Plan and repository checks', status: 'pending', conclusion: 'EXPECTED' });
  expect(evaluate(initialMemory(since), withRequired(ready, required), null).changes).toEqual([]);
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
  // Out of the queue a moment before GitHub shows the merge: the merge is the news.
  expect(mergeChanges([{ kind: 'dequeued', base: 'main' }], [{ kind: 'closed', state: 'MERGED', by: 'maintainer' }])).toEqual([{ kind: 'closed', state: 'MERGED', by: 'maintainer' }]);
});

// --- The loop, against a scripted gh ----------------------------------------

interface FakeGitHub {
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  mergeable: string;
  /** GitHub's merge state, absent where the test does not need it. */
  mergeState?: string;
  head: string;
  /** Its place in the merge queue, null out of it. */
  queue: number | null;
  /** The state only the detail read gives, as when GitHub merges between the fingerprint and the detail. */
  detailState?: 'MERGED' | 'CLOSED';
  runs: Run[];
  comments: unknown[];
  reviews: unknown[];
  inline: unknown[];
  updatedAt: string;
  /** Who merged or closed it. */
  closedBy: string;
  /** Thrown instead of answering, once per call while set. */
  failure: string | null;
  /** Thrown by the next closer query only, then cleared. */
  closerFailure: string | null;
  /** The contexts the base branch's rulesets and its classic protection require. */
  rules: string[];
  protection: string[];
  /** Thrown by the reads of what the base branch requires while set. */
  rulesFailure: string | null;
  calls: string[];
}

function fakeGitHub(): FakeGitHub {
  return { state: 'OPEN', mergeable: 'MERGEABLE', head: 'a'.repeat(40), queue: null, runs: [{ name: 'test', status: 'IN_PROGRESS', conclusion: '' }], comments: [], reviews: [], inline: [], updatedAt: '2026-10-15T09:00:00Z', closedBy: 'meetsu', failure: null, closerFailure: null, rules: [], protection: [], rulesFailure: null, calls: [] };
}

/** What `gh` prints for each call a watch makes. */
async function answer(github: FakeGitHub, args: string[]): Promise<string> {
  const query = args.find(arg => arg.startsWith('query='));
  const path = args.at(-1)!;
  github.calls.push(query ? (query.includes('mergedBy') ? 'closer' : query.includes('viewer') ? 'detail' : 'fingerprint') : path.replace(/^repos\/example\/repo\//, ''));
  if (github.failure) throw new Error(github.failure);
  if (query?.includes('mergedBy')) {
    const failure = github.closerFailure;
    github.closerFailure = null;
    if (failure) throw new Error(failure);
    const by = { login: github.closedBy };
    const state = github.detailState ?? github.state;
    return JSON.stringify({ data: { viewer: { login: 'meetsu' }, repository: { pullRequest: { state, mergedBy: state === 'MERGED' ? by : null,
      timelineItems: { nodes: state === 'CLOSED' ? [{ actor: by }] : [] } } } } });
  }
  const mergeQueueEntry = github.queue === null ? null : { position: github.queue };
  if (query?.includes('viewer')) return detailJson(github.runs, { state: github.detailState ?? github.state, mergeable: github.mergeable, mergeStateStatus: github.mergeState, headRefOid: github.head, mergeQueueEntry });
  if (query) {
    const counts = new Map<string, number>();
    for (const run of github.runs) { const key = run.status && run.status !== 'COMPLETED' ? run.status : run.conclusion ?? 'SUCCESS'; counts.set(key, (counts.get(key) ?? 0) + 1); }
    return JSON.stringify({ data: { repository: { pullRequest: { state: github.state, mergeable: github.mergeable, mergeStateStatus: github.mergeState, headRefOid: github.head, updatedAt: github.updatedAt, mergeQueueEntry,
      comments: { totalCount: github.comments.length, nodes: [] }, reviews: { totalCount: github.reviews.length, nodes: [] }, reviewThreads: { totalCount: 0 },
      commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { checkRunCountsByState: [...counts].map(([state, count]) => ({ state, count })), statusContextCountsByState: [] } } } }] } } } } });
  }
  if (/^repos\/example\/repo\/(?:rules\/)?branches\//.test(path)) {
    if (github.rulesFailure) throw new Error(github.rulesFailure);
    if (path.includes('rules/')) return JSON.stringify(github.rules.length ? [{ type: 'deletion' }, { type: 'required_status_checks', parameters: { required_status_checks: github.rules.map(context => ({ context, integration_id: 15368 })) } }] : []);
    return JSON.stringify({ name: 'main', protected: true, protection: { enabled: github.protection.length > 0,
      required_status_checks: { enforcement_level: github.protection.length ? 'non_admins' : 'off', contexts: github.protection, checks: github.protection.map(context => ({ context, app_id: null })) } } });
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
  // The user's request that opened the pull request.
  await owner.call('turns.start', { threadId, prompt: 'open the pull request' });
  await settled(threadId);
  const watch = await owner.call('threads.watchPullRequest', { threadId });
  expect(watch).toMatchObject({ url: URL, number: 7, paused: null, seen: { head: 'aaaaaaa', checks: { total: 1, running: 1, failed: 0 }, conflicting: false } });
  expect(harness!.core.threads.list({}).find(thread => thread.id === threadId)?.pullRequestWatches).toHaveLength(1);
  // A check still runs: the idle row keeps counting from the user's request, like a monitor.
  const summary = () => harness!.core.threads.list({}).find(thread => thread.id === threadId)!;
  expect(summary().requestSince).toBeNumber();
  // The pass the watch arms at 0 ms may land before the answer reaches the
  // client; nothing moved, so it reads only the fingerprint.
  expect(github.calls.slice(0, 7)).toEqual(['fingerprint', 'detail', 'rules/branches/main?per_page=100', 'branches/main', 'issues/7/comments?per_page=100&page=1', 'pulls/7/reviews?per_page=100&page=1', 'pulls/7/comments?per_page=100&page=1']);
  expect(github.calls.slice(7).every(call => call === 'fingerprint')).toBe(true);

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
  // Every check settled: the agent has its answer and the row stops counting.
  expect(summary().requestSince).toBeNull();
  github.mergeable = 'CONFLICTING';
  await drive();
  await settled(threadId);
  expect(wakeText(threadId, wakes(threadId)[2]!.id)).toContain('The branch now conflicts with main.');
  // Resolved, then behind a base that requires it up to date: told, and shown by what the watch saw.
  github.mergeable = 'MERGEABLE';
  github.mergeState = 'BEHIND';
  await drive();
  await settled(threadId);
  expect(wakeText(threadId, wakes(threadId)[3]!.id)).toContain('The branch is behind main');
  expect(watchStatus(harness!.core.pullRequestWatches.of(threadId)[0]!)).toContain('behind main');

  // The agent's own merge ends the watch without a wake.
  github.state = 'MERGED';
  await drive();
  expect(github.calls).toContain('closer');
  expect(harness!.core.pullRequestWatches.of(threadId)).toEqual([]);
  expect(harness!.core.journal.getSetting(`pr-watches:${threadId}`)).toBeUndefined();
  expect(wakes(threadId)).toHaveLength(4);
});

test('a check the base branch requires holds "passed" back until it reported', async () => {
  const { owner, threadId, github, watches, drive } = await watchedThread();
  // beboite/boite's ruleset requires "PR title", done in seconds, and "CI required", created only once every other job ended.
  github.rules = ['PR title', 'CI required'];
  const title = { name: 'PR title', workflow: 'pr title', required: true };
  github.runs = [{ ...title, status: 'IN_PROGRESS', conclusion: '' }];
  await owner.call('threads.watchPullRequest', { threadId });
  github.runs = [title];
  await drive();
  await settled(threadId);
  expect(wakes(threadId)).toHaveLength(0);
  expect(watches.of(threadId)[0]!.seen?.checks).toEqual({ total: 2, running: 1, failed: 0 });
  github.runs = [title, { name: 'CI required', required: true }];
  await drive();
  await settled(threadId);
  expect(wakes(threadId)).toHaveLength(1);
  expect(wakeText(threadId, wakes(threadId)[0]!.id)).toContain('All 2 required checks passed on aaaaaaa.');
  // Read once per repository and base while it is fresh, the classic protection beside the rulesets.
  expect(github.calls.filter(call => call.includes('branches/'))).toEqual(['rules/branches/main?per_page=100', 'branches/main']);

});

test('a failed read of what the base branch requires ends nothing and pauses nothing', async () => {
  const { owner, threadId, github, watches, drive } = await watchedThread();
  github.rules = ['test', 'CI required'];
  github.rulesFailure = 'gh: Server Error (HTTP 502)';
  await owner.call('threads.watchPullRequest', { threadId });
  github.runs = [{ name: 'test', required: true }];
  await drive();
  await settled(threadId);
  // It goes on with what the checks say of themselves.
  expect(watches.of(threadId)[0]).toMatchObject({ paused: null, seen: { checks: { total: 1, running: 0, failed: 0 } } });
  expect(wakeText(threadId, wakes(threadId)[0]!.id)).toContain('All 1 required check passed on aaaaaaa.');
});

test('rules that expire or failed are read again while the fingerprint stands still, against the checks already read', async () => {
  const { owner, threadId, github, watches, drive } = await watchedThread();
  // "old" is required, then the ruleset swaps it for C, which already passed: nothing on the pull request moves.
  github.rules = ['A', 'old'];
  github.runs = [{ name: 'A', required: true }, { name: 'C' }];
  await owner.call('threads.watchPullRequest', { threadId });
  github.rules = ['A', 'C'];
  github.calls = [];
  const now = Date.now();
  const driveAt = async (minutes: number) => {
    const clock = spyOn(Date, 'now').mockReturnValue(now + minutes * 60_000);
    try { await drive(); } finally { clock.mockRestore(); }
  };
  await driveAt(11);
  await settled(threadId);
  expect(github.calls.filter(call => call !== 'fingerprint')).toEqual(['rules/branches/main?per_page=100', 'branches/main']);
  expect(wakeText(threadId, wakes(threadId)[0]!.id)).toContain('All 2 required checks passed on aaaaaaa.');

  // A failed read is tried again after two minutes, not after the half-hour reread.
  github.rulesFailure = 'gh: Server Error (HTTP 502)';
  await driveAt(22);
  github.rulesFailure = null;
  github.rules = ['A', 'C', 'B'];
  github.calls = [];
  await driveAt(25);
  expect(github.calls.filter(call => call !== 'fingerprint')).toEqual(['rules/branches/main?per_page=100', 'branches/main']);
  expect(watches.of(threadId)[0]!.seen?.checks).toEqual({ total: 3, running: 1, failed: 0 });
});

test('a check the rules stop requiring stops counting as required, even on the checks already read', async () => {
  const { owner, threadId, github, drive } = await watchedThread();
  github.rules = ['A', 'B'];
  github.runs = [{ name: 'A', required: true }, { name: 'B', conclusion: 'FAILURE', required: true }];
  await owner.call('threads.watchPullRequest', { threadId });
  // B leaves the ruleset; nothing on the pull request moves.
  github.rules = ['A'];
  const clock = spyOn(Date, 'now').mockReturnValue(Date.now() + 11 * 60_000);
  try { await drive(); } finally { clock.mockRestore(); }
  await settled(threadId);
  expect(wakeText(threadId, wakes(threadId)[0]!.id)).toContain('All 1 required check passed on aaaaaaa.');
});

/**
 * Runs `fn` with the clock stopped at `at`. A rate limit pauses for two
 * intervals from the read that met it; a test that looks at the pause in real
 * time sees it end on a runner slower than the interval.
 */
async function pinned<T>(at: number, fn: () => Promise<T>): Promise<T> {
  const clock = spyOn(Date, 'now').mockReturnValue(at);
  try { return await fn(); } finally { clock.mockRestore(); }
}

test('a rate limit on the rules pauses every read like any other', async () => {
  const { owner, threadId, github, watches } = await watchedThread({ intervalMs: 60_000, coalesceMs: 0 });
  github.rulesFailure = 'gh: API rate limit exceeded for user ID 1. (HTTP 403)';
  const start = Date.now();
  await owner.call('threads.watchPullRequest', { threadId });
  await pinned(start, async () => {
    expect(watches.of(threadId)[0]!.paused).toMatchObject({ reason: 'rate-limit' });
    github.calls = [];
    await watches.pass();
    expect(github.calls).toEqual([]);
  });
});

test('a merge or a close by someone else is told with what still waited, a failed closer read included, then the watch ends', async () => {
  const { owner, threadId, github, watches, drive } = await watchedThread();
  await owner.call('threads.watchPullRequest', { threadId });
  await owner.call('turns.start', { threadId, prompt: 'wait [sleep:600]' });
  for (let i = 0; i < 100 && harness!.core.journal.getThread(threadId)?.status !== 'running'; i++) await Bun.sleep(10);
  github.comments = [comment(1, 'reviewer', later())];
  github.updatedAt = '2026-10-15T10:00:00Z';
  await drive();
  github.state = 'MERGED';
  github.closedBy = 'maintainer';
  // GitHub fails to name the closer once: the watch backs off like any failed read and asks again.
  github.closerFailure = 'error connecting to api.github.com';
  github.calls = [];
  await drive();
  expect(github.calls.filter(call => call === 'closer')).toHaveLength(2);
  // Told nothing yet, read no more, and the watch stays until it is told.
  github.calls = [];
  await drive();
  expect(github.calls).toEqual([]);
  expect(watches.of(threadId)).toHaveLength(1);
  await settled(threadId);
  await drive();
  await settled(threadId);
  expect(wakes(threadId)).toHaveLength(1);
  const text = wakeText(threadId, wakes(threadId)[0]!.id);
  expect(text).toContain('reviewer: "comment 1"');
  expect(text).toContain('maintainer merged the pull request; its watch ended.');
  expect(watches.of(threadId)).toEqual([]);
  expect(harness!.core.journal.getSetting(`pr-watches:${threadId}`)).toBeUndefined();
  expect(harness!.core.linkedPullRequests.saved(threadId)[0]?.state).toBe('MERGED');
});

test('a pull request in the merge queue keeps its watch waiting, and leaving the queue unmerged wakes the agent', async () => {
  const { owner, threadId, github, watches, drive } = await watchedThread();
  await owner.call('turns.start', { threadId, prompt: 'merge it when green' });
  await settled(threadId);
  github.runs = [{ name: 'test' }];
  await owner.call('threads.watchPullRequest', { threadId });
  const summary = () => harness!.core.threads.list({}).find(thread => thread.id === threadId)!;
  // Its head checks passed: nothing left to wait on.
  expect(summary().requestSince).toBeNull();
  // Queued: its merge group's checks run where the head's do not show them, so the agent still waits.
  github.queue = 2;
  await drive();
  expect(watches.of(threadId)[0]!.seen?.queue).toEqual({ position: 2 });
  expect(summary().requestSince).toBeNumber();
  github.queue = 1;
  await drive();
  expect(watches.of(threadId)[0]!.seen?.queue).toEqual({ position: 1 });
  expect(wakes(threadId)).toHaveLength(0);
  // Its merge group failed: out of the queue, still open.
  github.queue = null;
  await drive();
  await settled(threadId);
  expect(wakes(threadId)).toHaveLength(1);
  expect(wakeText(threadId, wakes(threadId)[0]!.id)).toContain('It left the merge queue of main without merging');
  expect(summary().requestSince).toBeNull();
  // Queued again and merged between the fingerprint, still open, and the detail read: the merge is the news, not the queue.
  github.queue = 1;
  await drive();
  github.queue = null;
  github.detailState = 'MERGED';
  github.closedBy = 'maintainer';
  await drive();
  await settled(threadId);
  expect(wakes(threadId)).toHaveLength(2);
  const text = wakeText(threadId, wakes(threadId)[1]!.id);
  expect(text).toContain('maintainer merged the pull request; its watch ended.');
  expect(text).not.toContain('merge queue');
  expect(watches.of(threadId)).toEqual([]);
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
  const { owner, threadId, github, watches } = await watchedThread({ intervalMs: 60_000, coalesceMs: 0 });
  await owner.call('threads.watchPullRequest', { threadId });
  // The first read is no later than this: each step below sets the clock from it.
  const read = Date.now();
  github.failure = 'gh: API rate limit exceeded for user ID 1. (HTTP 403)';
  // A minute on, the next read meets the rate limit: it pauses for two minutes.
  await pinned(read + 60_000, async () => {
    await watches.pass();
    expect(watches.of(threadId)[0]!.paused).toMatchObject({ reason: 'rate-limit' });
    github.failure = null;
    github.calls = [];
    await watches.pass();
    expect(github.calls).toEqual([]);
  });
  // Reads resume once the pause passed.
  await pinned(read + 180_000, async () => {
    await watches.pass();
    expect(github.calls).toEqual(['fingerprint']);
    expect(watches.of(threadId)[0]!.paused).toBeNull();
  });

  github.failure = 'error connecting to api.github.com';
  await pinned(read + 240_000, async () => {
    await watches.pass();
    expect(watches.of(threadId)[0]!.paused).toMatchObject({ reason: 'unreachable', message: 'error connecting to api.github.com' });
  });

  // A new store over the same journal (a restarted core) picks the watch up, with what it was told.
  const listeners = (harness!.core.bus as unknown as { listeners: Set<unknown> }).listeners;
  const heard = listeners.size;
  const restarted = new PullRequestWatches(harness!.core, (_thread, args) => answer(github, args), { intervalMs: 0, coalesceMs: 0 });
  // It reads the watch two seconds after it started, at the latest from now.
  const built = Date.now();
  try {
    github.failure = null;
    expect(restarted.of(threadId)).toEqual([expect.objectContaining({ url: URL, seen: expect.objectContaining({ head: 'aaaaaaa' }) })]);
    await pinned(built + 2_000, () => restarted.pass());
    expect(restarted.of(threadId)[0]!.paused).toBeNull();
  } finally { await restarted.close(); }
  // A closed store hears nothing more and reads nothing more.
  expect(listeners.size).toBe(heard);
  github.calls = [];
  await restarted.pass();
  expect(github.calls).toEqual([]);
});

test('Stop ends every watch of the thread, and the refusals name what is wrong', async () => {
  const { owner, threadId, github } = await watchedThread();
  expect(await thrown(owner.call('threads.watchPullRequest', { threadId, url: '8' }))).toThrow('no linked pull request is #8');
  expect(await thrown(owner.call('threads.watchPullRequest', { threadId, url: 'https://gitlab.example/a/b/pull/1' }))).toThrow('host');
  await owner.call('threads.watchPullRequest', { threadId });
  // The loop rests a second between its own passes even when a read is due at once:
  // re-arming at 0 ms kept a Windows event loop from reaching anything else.
  const before = github.calls.length;
  await Bun.sleep(300);
  expect(github.calls.length - before).toBeLessThanOrEqual(1);
  expect(await thrown(owner.call('threads.unwatchPullRequest', { threadId, url: '#9' }))).toThrow('does not watch #9');
  expect((await owner.call('turns.stop', { threadId })).stopped).toBe(true);
  expect(harness!.core.pullRequestWatches.of(threadId)).toEqual([]);
});

test('the agent\'s CLI watches and unwatches, printing what the first read saw', async () => {
  const { threadId } = await watchedThread();
  const boite = async (...args: string[]) => {
    let out = '';
    const code = await runCli(args, { out: text => { out += text; }, err: text => { out += text; }, cwd: harness!.dataDir,
      env: { [AGENT_ENV.threadId]: threadId, [AGENT_ENV.coreUrl]: harness!.url, [AGENT_ENV.token]: harness!.core.agents.tokenFor(threadId) } });
    return { code, out };
  };
  expect(await boite('pr', 'watch', URL)).toEqual({ code: 0, out: expect.stringContaining(`watching #7 ${URL}: head aaaaaaa; 1 checks, 1 running, 0 failed`) });
  expect(await boite('pr', 'unwatch', '7')).toEqual({ code: 0, out: expect.stringContaining('no pull request watched') });
});

test('an agent watches its own thread; a paired phone may stop a watch, never start one', async () => {
  const { owner, threadId } = await watchedThread();
  const agent = await connect(harness!.url, harness!.core.agents.tokenFor(threadId), { client: { name: 'boite-cli', version: 'test' } });
  const { grant } = await owner.call('pairing.grant', {});
  const phone = await connect(harness!.url, '', { grant });
  try {
    await agent.call('threads.watchPullRequest', { threadId });
    expect(await thrown(phone.call('threads.watchPullRequest', { threadId }))).toThrow('owner');
    expect(await phone.call('threads.unwatchPullRequest', { threadId })).toEqual([]);
  } finally { agent.close(); phone.close(); }
});

/** A parent with delegation on and a delegated agent that has the pull request linked; the agent's own token watches it. */
async function watchingChild(setup: Awaited<ReturnType<typeof watchedThread>>, requestId: string) {
  const { owner, threadId } = setup;
  const parent = harness!.core.threads.require(threadId);
  await owner.call('delegation.configure', { threadId, config: { ...DEFAULT_DELEGATION_CONFIG, enabled: true, profiles: [{ id: 'worker', name: 'Worker', providerId: parent.providerId, accountId: parent.accountId, model: parent.model!, effort: null }] } });
  // The child watches during its turn, as `boite pr watch` does: a child that finished without one is put away.
  const child = (await owner.call('delegation.spawn', { threadId, profileId: 'worker', task: 'Open the pull request and see it to green [sleep:300]', requestId })).thread.id as ThreadId;
  harness!.core.journal.setSetting(`linked-pull-requests:${child}`, harness!.core.journal.getSetting(`linked-pull-requests:${threadId}`));
  const agent = await connect(harness!.url, harness!.core.agents.tokenFor(child), { client: { name: 'boite-cli', version: 'test' } });
  try { await agent.call('threads.watchPullRequest', { threadId: child }); } finally { agent.close(); }
  expect(harness!.core.journal.listTurns(child).some(turn => turn.status === 'running' || turn.status === 'queued')).toBe(true);
  await settled(child);
  return child;
}

test('a delegated agent watches its pull request: the wake is its turn, its answer goes to the parent, and its stop ends the watch', async () => {
  const setup = await watchedThread();
  const { owner, threadId, github, drive, watches } = setup;
  const child = await watchingChild(setup, 'first');
  const sibling = await watchingChild(setup, 'second');
  expect(watches.of(child)).toHaveLength(1);

  github.runs = [{ name: 'test', conclusion: 'FAILURE' }];
  github.updatedAt = '2026-10-15T09:31:00Z';
  await drive();
  await settled(child);
  expect(wakes(child)).toHaveLength(1);
  expect(wakeText(child, wakes(child)[0]!.id)).toContain('Checks failed on aaaaaaa');
  // What the wake turn answers comes back to the parent like any result of the subagent.
  const result = () => harness!.core.journal.db.query('SELECT 1 FROM delegation_messages WHERE sender_id = ? AND recipient_id = ? AND request_id = ?').get(child, threadId, `result:${wakes(child)[0]!.id}`);
  await waitFor(() => result() !== null);

  // The parent stopping this subagent ends its watch, not its sibling's.
  await owner.call('delegation.stop', { threadId, agentId: child });
  expect(watches.of(child)).toEqual([]);
  expect(harness!.core.journal.getSetting(`pr-watches:${child}`)).toBeUndefined();
  expect(watches.of(sibling)).toHaveLength(1);
  // Its parent archived, the subagent watches nothing either.
  await owner.call('threads.archive', { threadId });
  expect(watches.of(sibling)).toEqual([]);
});

test('a persistent agent takes its next work and keeps a subagent that still watches its pull request until the watch ends', async () => {
  const setup = await watchedThread();
  const { threadId, watches } = setup;
  const child = await watchingChild(setup, 'episode');
  const idle = (await setup.owner.call('delegation.spawn', { threadId, profileId: 'worker', task: 'Read the logs', requestId: 'idle' })).thread.id as ThreadId;
  await settled(idle);
  await waitFor(() => (harness!.core.journal.db.query("SELECT COUNT(*) AS n FROM delegation_messages WHERE recipient_id = ? AND status = 'delivered'").get(threadId) as { n: number }).n >= 2);
  await settled(threadId);
  const delegation = harness!.core.delegation;
  const archived = (id: ThreadId) => harness!.core.journal.getThread(id)?.archived;
  // The resident runtime starts each work item through beginEpisode: the fresh work runs, the settled subagent retires, the watching one stays.
  const accepted = delegation.beginEpisode(threadId, 'next-work-item', delegation.config(threadId));
  expect({ accepted, idle: archived(idle), child: archived(child), watches: watches.of(child).length }).toEqual({ accepted: true, idle: true, child: false, watches: 1 });
  // Its watch over, it retires too.
  watches.unwatch(child);
  await waitFor(() => archived(child) === true);
});

for (const ending of ['merged by someone else', 'closed by someone else', 'a failed turn']) {
  test(`a subagent a past episode left watching delivers its last result before it retires: ${ending}`, async () => {
    const setup = await watchedThread();
    const { owner, threadId, github, drive, watches } = setup;
    const child = await watchingChild(setup, 'episode');
    await waitFor(() => harness!.core.journal.db.query("SELECT 1 FROM delegation_messages WHERE sender_id = ? AND recipient_id = ? AND status = 'delivered'").get(child, threadId) !== null);
    await settled(threadId);
    expect(harness!.core.delegation.beginEpisode(threadId, 'next-work-item', harness!.core.delegation.config(threadId))).toBe(true);
    const before = harness!.core.journal.listTurns(child).map(turn => turn.id);
    if (ending === 'a failed turn') await owner.call('turns.start', { threadId: child, prompt: '[error]' });
    else {
      github.state = ending.startsWith('merged') ? 'MERGED' : 'CLOSED';
      github.closedBy = 'someone-else';
      await drive();
    }
    await waitFor(() => harness!.core.journal.getThread(child)?.archived === true);
    expect(watches.of(child)).toEqual([]);
    const last = harness!.core.journal.listTurns(child).find(turn => !before.includes(turn.id))!;
    expect(harness!.core.journal.db.query('SELECT status FROM delegation_messages WHERE sender_id = ? AND request_id = ?').get(child, `result:${last.id}`)).toEqual({ status: 'delivered' });
  });
}

test('a restart between a retiring subagent\'s last delivery and its archive retires it on start', async () => {
  const child = await retiringOnDisk();
  const restarted = new Core({ dataDir: harness!.dataDir, token: harness!.token });
  try {
    expect(restarted.threads.require(child).archived).toBe(true);
    expect(restarted.journal.getSetting(`delegation-retiring:${child}`)).toBeUndefined();
  } finally { await restarted.close(); }
});

test('a retirement that throws on start is logged and the core still starts', async () => {
  const child = await retiringOnDisk();
  const retire = spyOn(Retirements.prototype, 'check').mockImplementation(() => { throw new Error('journal busy'); });
  let restarted: Core;
  try { restarted = new Core({ dataDir: harness!.dataDir, token: harness!.token }); } finally { retire.mockRestore(); }
  try {
    expect(restarted.threads.require(child).archived).toBe(false);
    expect((await restarted.logs.query({ threadId: child, level: 'warn' })).some(record => record.event === 'delegation.retire_failed' && record.message.includes('journal busy'))).toBe(true);
  } finally { await restarted.close(); }
});

/** A retiring subagent whose watch ended on disk, its core gone down before the archive followed. */
async function retiringOnDisk(): Promise<ThreadId> {
  const setup = await watchedThread();
  const { threadId } = setup;
  const child = await watchingChild(setup, 'episode');
  await waitFor(() => harness!.core.journal.db.query("SELECT 1 FROM delegation_messages WHERE sender_id = ? AND recipient_id = ? AND status = 'delivered'").get(child, threadId) !== null);
  await settled(threadId);
  expect(harness!.core.delegation.beginEpisode(threadId, 'next-work-item', harness!.core.delegation.config(threadId))).toBe(true);
  harness!.core.journal.deleteSetting(`pr-watches:${child}`);
  await harness!.core.close();
  return child;
}

test('the parent\'s Stop ends its subagents\' watches, and a workflow step still cannot watch', async () => {
  const setup = await watchedThread();
  const { owner, threadId, watches } = setup;
  const child = await watchingChild(setup, 'first');
  expect(watches.of(child)).toHaveLength(1);
  await owner.call('turns.stop', { threadId });
  expect(watches.of(child)).toEqual([]);
  // A child the core runs for a plan answers it once: no watch to wake it again.
  spyOn(harness!.core.delegation, 'delegated').mockReturnValue(false);
  expect(await thrown(owner.call('threads.watchPullRequest', { threadId: child }))).toThrow('a workflow step or a reviewer cannot watch');
});

test('archive ends the watches and their saved state, and a merged pull request has nothing to watch', async () => {
  const { owner, threadId, github } = await watchedThread();
  await owner.call('threads.watchPullRequest', { threadId });
  expect(harness!.core.journal.getSetting(`pr-watches:${threadId}`)).toHaveLength(1);
  await owner.call('threads.archive', { threadId });
  expect(harness!.core.pullRequestWatches.of(threadId)).toEqual([]);
  expect(harness!.core.journal.getSetting(`pr-watches:${threadId}`)).toBeUndefined();
  await owner.call('threads.archive', { threadId, archived: false });
  github.state = 'MERGED';
  expect(await thrown(owner.call('threads.watchPullRequest', { threadId }))).toThrow('is merged');
});

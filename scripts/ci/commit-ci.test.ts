import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type CiRun, decide, NO_RUN_GRACE_MS } from './commit-ci.ts';

const sha = 'a'.repeat(40);
const options = { sha, dryRun: false };
const fresh = { elapsedMs: 0 };

function run(fields: Partial<CiRun> = {}): CiRun {
  return {
    id: 10, head_sha: sha, head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success',
    run_attempt: 1, html_url: 'https://github.com/mtsu-dev/boite/actions/runs/10', ...fields,
  };
}

test('a green push run of the commit lets the nightly publish', () => {
  expect(decide([run({ head_branch: null }), run()], options, fresh)).toMatchObject({ action: 'pass' });
  expect(decide([run({ head_branch: null })], options, fresh)).toMatchObject({ action: 'wait' });
});

test('the nightly waits for a run in progress, and for one GitHub has not created yet', () => {
  expect(decide([run({ status: 'in_progress', conclusion: null })], options, fresh)).toMatchObject({ action: 'wait' });
  expect(decide([], options, { elapsedMs: NO_RUN_GRACE_MS - 1 })).toMatchObject({ action: 'wait' });
  expect(decide([], options, { elapsedMs: NO_RUN_GRACE_MS })).toMatchObject({ action: 'fail', message: expect.stringContaining('no ci run on main') });
});

test('only main or its merge queue on this exact commit counts', () => {
  const others = [run({ head_sha: 'b'.repeat(40) }), run({ event: 'pull_request', head_branch: 'feature' }), run({ head_branch: 'feature' })];
  expect(decide(others, options, { elapsedMs: NO_RUN_GRACE_MS })).toMatchObject({ action: 'fail' });
  // A dry run on a branch accepts that branch's pull request run.
  expect(decide([run({ event: 'pull_request', head_branch: 'feature' })], { sha, dryRun: true }, fresh)).toMatchObject({ action: 'pass' });
});

test('a failed run gets its failed jobs rerun once, then decides', () => {
  const failed = run({ conclusion: 'failure' });
  const retried = { elapsedMs: 0, retriedAttempt: 1, retriedRunId: failed.id };
  expect(decide([failed], options, fresh)).toMatchObject({ action: 'rerun', run: failed });
  // Until GitHub starts the new attempt, the old failure is not the answer.
  expect(decide([failed], options, retried)).toMatchObject({ action: 'wait' });
  expect(decide([run({ run_attempt: 2, status: 'queued', conclusion: null })], options, retried)).toMatchObject({ action: 'wait' });
  expect(decide([run({ run_attempt: 2 })], options, retried)).toMatchObject({ action: 'pass' });
  expect(decide([run({ run_attempt: 2, conclusion: 'failure' })], options, retried))
    .toMatchObject({ action: 'fail', message: expect.stringContaining('ended failure (attempt 2)') });
  const manual = run({ id: 11, event: 'workflow_dispatch', conclusion: 'failure' });
  expect(decide([failed, manual], options, retried)).toMatchObject({ action: 'fail', run: manual });
});

test('a cancelled run, or any failure in a dry run, fails without a rerun', () => {
  expect(decide([run({ conclusion: 'cancelled' })], options, fresh)).toMatchObject({ action: 'fail', message: expect.stringContaining('ended cancelled') });
  expect(decide([run({ conclusion: 'failure', event: 'pull_request' })], { sha, dryRun: true }, fresh)).toMatchObject({ action: 'fail' });
});

test('a green candidate passes among failed or cancelled runs', () => {
  const runs = [run({ id: 10, conclusion: 'failure' }), run({ id: 12 }), run({ id: 11, conclusion: 'cancelled' })];
  expect(decide(runs, options, fresh)).toMatchObject({ action: 'pass', run: { id: 12 } });
});

test('push startup_failure plus merge_group success passes on the queue run', () => {
  const queue = run({ id: 9, event: 'merge_group', head_branch: 'gh-readonly-queue/main/pr-723' });
  expect(decide([run({ conclusion: 'startup_failure' }), queue], options, fresh))
    .toMatchObject({ action: 'pass', run: queue, message: expect.stringContaining('merge_group') });
});

test('without a push run, workflow_dispatch success on main passes', () => {
  const dispatch = run({ event: 'workflow_dispatch' });
  expect(decide([dispatch], options, fresh)).toMatchObject({ action: 'pass', run: dispatch });
});

test('runs on another SHA, including another merge_group, wait then fail after the grace', () => {
  const others = [run({ head_sha: 'b'.repeat(40) }), run({ head_sha: 'c'.repeat(40), event: 'merge_group', head_branch: 'gh-readonly-queue/main/pr-724' })];
  expect(decide(others, options, fresh)).toMatchObject({ action: 'wait' });
  expect(decide(others, options, { elapsedMs: NO_RUN_GRACE_MS })).toMatchObject({ action: 'fail' });
  expect(decide([run({ event: 'merge_group', head_branch: 'gh-readonly-queue/other/pr-724' })], options, fresh)).toMatchObject({ action: 'wait' });
});

test('push failure plus merge_group in progress waits instead of rerunning', () => {
  const queue = run({ id: 9, event: 'merge_group', head_branch: 'gh-readonly-queue/main/pr-723', status: 'in_progress', conclusion: null });
  expect(decide([run({ conclusion: 'failure' }), queue], options, fresh)).toMatchObject({ action: 'wait', run: queue });
});

test('both push and merge_group failed reruns the newest once then fails', () => {
  const queue = run({ id: 11, event: 'merge_group', head_branch: 'gh-readonly-queue/main/pr-723', conclusion: 'failure' });
  const push = run({ conclusion: 'failure' });
  expect(decide([push, queue], options, fresh)).toMatchObject({ action: 'rerun', run: queue });
  expect(decide([push, queue], options, { elapsedMs: 0, retriedAttempt: 1, retriedRunId: queue.id })).toMatchObject({ action: 'wait' });
  expect(decide([push, { ...queue, run_attempt: 2 }], options, { elapsedMs: 0, retriedAttempt: 1, retriedRunId: queue.id })).toMatchObject({ action: 'fail', run: { id: 11 } });
});

test('an older success passes even while a newer run is pending or waiting to rerun', () => {
  const passed = run({ id: 9 });
  expect(decide([passed, run({ status: 'queued', conclusion: null })], options, fresh)).toMatchObject({ action: 'pass', run: passed });
  expect(decide([passed, run({ conclusion: 'failure' })], options, { elapsedMs: 0, retriedAttempt: 1 })).toMatchObject({ action: 'pass', run: passed });
});

// Nightly 39226757576 started on 30287eef at 08:59:49 UTC; its pending main run
// was replaced 12 s later, then two more pushes replaced theirs before
// 9c974e65's run passed. The night was lost on `ended cancelled`.
const superseded = (sha: string, id: number, fields: Partial<CiRun> = {}) =>
  run({ id, head_sha: sha, conclusion: 'cancelled', html_url: `https://github.com/mtsu-dev/boite/actions/runs/${id}`, ...fields });
const night = '30287eeffb74c73a938c8049dba3ca8ac1b5d799';
const green = '9c974e65'.padEnd(40, '0');
const nightRuns = [
  superseded(night, 39226575960),
  superseded('65b57cf4'.padEnd(40, '0'), 39226779197),
  superseded('28bc9cbd'.padEnd(40, '0'), 39226817876),
  run({ id: 39226850351, head_sha: green, status: 'in_progress', conclusion: null }),
];
const following = { sha: night, dryRun: false, follow: true };

test('a run replaced while pending hands the verdict to the newest main run, and the nightly builds that commit', () => {
  expect(decide(nightRuns, following, fresh)).toMatchObject({ action: 'follow', run: { id: 39226850351, head_sha: green } });
  expect(decide(nightRuns, following, { elapsedMs: 0, sha: green })).toMatchObject({ action: 'wait' });
  const passed = nightRuns.map((each) => each.head_sha === green ? { ...each, status: 'completed', conclusion: 'success' } : each);
  expect(decide(passed, following, { elapsedMs: 0, sha: green })).toMatchObject({ action: 'pass', run: { head_sha: green } });
});

test('a cancelled head with no newer run falls back to the newest older green commit only', () => {
  const older = 'c'.repeat(40);
  const runs = [superseded(sha, 20), run({ id: 19, head_sha: older }), run({ id: 18, head_sha: 'd'.repeat(40) })];
  expect(decide(runs, { sha, dryRun: false, follow: true }, fresh)).toMatchObject({ action: 'follow', run: { head_sha: older } });
  // An older failure is no verdict on anything newer: the night fails as before.
  const red = [superseded(sha, 20), run({ id: 19, head_sha: older, conclusion: 'failure' })];
  expect(decide(red, { sha, dryRun: false, follow: true }, fresh)).toMatchObject({ action: 'fail', message: expect.stringContaining('ended cancelled') });
});

test('without follow, as app.yml deploys its own checkout, or in a dry run, a cancelled run still fails', () => {
  expect(decide(nightRuns, { sha: night, dryRun: false }, fresh)).toMatchObject({ action: 'fail', message: expect.stringContaining('ended cancelled') });
  const branch = nightRuns.map((each) => ({ ...each, event: 'pull_request', head_branch: 'feature' }));
  expect(decide(branch, { sha: night, dryRun: true, follow: true }, fresh)).toMatchObject({ action: 'fail' });
});

/** Runs the gate as the nightly does, against a fake API answering `runs`, and returns its exit code and step output. */
async function gate(runs: CiRun[], started: string) {
  const requests: URL[] = [];
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: (request) => {
    const url = new URL(request.url);
    requests.push(url);
    const matches = runs.filter((run) => ['head_sha', 'branch', 'event'].every((key) =>
      !url.searchParams.has(key) || url.searchParams.get(key) === run[key === 'branch' ? 'head_branch' : key as 'head_sha' | 'event']));
    return Response.json({ workflow_runs: matches });
  } });
  const dir = mkdtempSync(join(tmpdir(), 'commit-ci-'));
  const output = join(dir, 'output');
  try {
    const { GITHUB_STEP_SUMMARY: _summary, COMMIT_CI_DRY_RUN: _dry, ...env } = process.env;
    const child = Bun.spawn([process.execPath, join(import.meta.dir, 'commit-ci.ts')], {
      env: {
        ...env, GITHUB_API_URL: server.url.origin, GITHUB_REPOSITORY: 'mtsu-dev/boite', GH_TOKEN: 'test',
        GITHUB_SHA: started, COMMIT_CI_FOLLOW: '1', GITHUB_OUTPUT: output,
      },
      stdout: 'pipe', stderr: 'pipe',
    });
    const code = await child.exited;
    return { code, output: Bun.file(output).size ? readFileSync(output, 'utf8') : '', requests, log: await new Response(child.stdout).text() };
  } finally {
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the gate hands the nightly the commit it passed, its own or the one it followed', async () => {
  expect(await gate([run({ head_branch: null }), run()], sha)).toMatchObject({ code: 0, output: `sha=${sha}
` });
  const passed = nightRuns.map((each) => each.head_sha === green ? { ...each, status: 'completed', conclusion: 'success' } : each);
  expect(await gate(passed, night)).toMatchObject({ code: 0, output: `sha=${green}
` });
});

test('the nightly fetches every event for its exact SHA even when following main', async () => {
  const result = await gate([run()], sha);
  expect(result.code).toBe(0);
  expect(result.requests.some((url) => url.searchParams.get('head_sha') === sha && !url.searchParams.has('event') && !url.searchParams.has('branch'))).toBe(true);
});

test('the nightly accepts and logs the queue run when the push failed to start', async () => {
  const queue = run({ id: 9, event: 'merge_group', head_branch: 'gh-readonly-queue/main/pr-723' });
  const result = await gate([run({ conclusion: 'startup_failure' }), queue], sha);
  expect(result).toMatchObject({ code: 0, output: `sha=${sha}\n` });
  expect(result.log).toContain(`${queue.html_url} (merge_group) passed on ${sha}`);
});

test('the nightly accepts a manual run on main when no push run exists', async () => {
  expect(await gate([run({ event: 'workflow_dispatch' })], sha)).toMatchObject({ code: 0, output: `sha=${sha}\n` });
});

import { expect, test } from 'bun:test';
import { type CiRun, decide, NO_RUN_GRACE_MS } from './commit-ci.ts';

const sha = 'a'.repeat(40);
const options = { sha, dryRun: false };
const fresh = { elapsedMs: 0 };

function run(fields: Partial<CiRun> = {}): CiRun {
  return {
    id: 10, head_sha: sha, head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success',
    run_attempt: 1, html_url: 'https://github.com/beboite/boite/actions/runs/10', ...fields,
  };
}

test('a green push run of the commit lets the nightly publish', () => {
  expect(decide([run()], options, fresh)).toMatchObject({ action: 'pass' });
});

test('the nightly waits for a run in progress, and for one GitHub has not created yet', () => {
  expect(decide([run({ status: 'in_progress', conclusion: null })], options, fresh)).toMatchObject({ action: 'wait' });
  expect(decide([], options, { elapsedMs: NO_RUN_GRACE_MS - 1 })).toMatchObject({ action: 'wait' });
  expect(decide([], options, { elapsedMs: NO_RUN_GRACE_MS })).toMatchObject({ action: 'fail', message: expect.stringContaining('no ci run on main') });
});

test('only the push to main of this exact commit counts', () => {
  const others = [run({ head_sha: 'b'.repeat(40) }), run({ event: 'pull_request', head_branch: 'feature' }), run({ head_branch: 'feature' })];
  expect(decide(others, options, { elapsedMs: NO_RUN_GRACE_MS })).toMatchObject({ action: 'fail' });
  // A dry run on a branch accepts that branch's pull request run.
  expect(decide([run({ event: 'pull_request', head_branch: 'feature' })], { sha, dryRun: true }, fresh)).toMatchObject({ action: 'pass' });
});

test('a failed run gets its failed jobs rerun once, then decides', () => {
  const failed = run({ conclusion: 'failure' });
  expect(decide([failed], options, fresh)).toMatchObject({ action: 'rerun', run: failed });
  // Until GitHub starts the new attempt, the old failure is not the answer.
  expect(decide([failed], options, { elapsedMs: 0, retriedAttempt: 1 })).toMatchObject({ action: 'wait' });
  expect(decide([run({ run_attempt: 2, status: 'queued', conclusion: null })], options, { elapsedMs: 0, retriedAttempt: 1 })).toMatchObject({ action: 'wait' });
  expect(decide([run({ run_attempt: 2 })], options, { elapsedMs: 0, retriedAttempt: 1 })).toMatchObject({ action: 'pass' });
  expect(decide([run({ run_attempt: 2, conclusion: 'failure' })], options, { elapsedMs: 0, retriedAttempt: 1 }))
    .toMatchObject({ action: 'fail', message: expect.stringContaining('ended failure (attempt 2)') });
});

test('a cancelled run, or any failure in a dry run, fails without a rerun', () => {
  expect(decide([run({ conclusion: 'cancelled' })], options, fresh)).toMatchObject({ action: 'fail', message: expect.stringContaining('ended cancelled') });
  expect(decide([run({ conclusion: 'failure', event: 'pull_request' })], { sha, dryRun: true }, fresh)).toMatchObject({ action: 'fail' });
});

test('the newest run of the commit decides, not an older one', () => {
  const runs = [run({ id: 10, conclusion: 'failure' }), run({ id: 12 }), run({ id: 11, conclusion: 'cancelled' })];
  expect(decide(runs, options, fresh)).toMatchObject({ action: 'pass', run: { id: 12 } });
});

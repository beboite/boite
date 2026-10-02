import { afterEach, expect, test } from 'bun:test';
import { PullRequestReviews } from '../src/pull-request-review.ts';
import { connect } from '../src/client.ts';
import { echoThread, startTestCore, type TestCore } from './harness.ts';
let harness: TestCore | undefined;
afterEach(async () => { await harness?.stop(); harness = undefined; });
const url = 'https://github.com/example/repo/pull/1';

test('reviews combine discussions and inline feedback, reject unsafe URLs and expose bounded file pages', async () => {
  const calls: string[][] = [];
  const service = new PullRequestReviews(async (_thread, args) => {
    calls.push(args);
    if (args[0] === 'pr') return JSON.stringify({ url, title: 'Change', body: 'Description', state: 'OPEN', headRefName: 'feature', baseRefName: 'main',
      comments: [{ author: { login: 'alice' }, body: 'Discussion', url, createdAt: '2026-01-01' }], reviews: [],
      statusCheckRollup: [{ name: 'tests', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'javascript:alert(1)' }] });
    if (args.at(-1)?.includes('/comments?')) return JSON.stringify([{ user: { login: 'bob' }, body: 'Inline', url: 'https://api.github.com/repos/example/repo/pulls/comments/12', html_url: url + '#discussion_r12', path: 'src/a.ts', line: 4, created_at: '2026-01-02' }]);
    return JSON.stringify([{ filename: 'a.ts', status: 'modified', additions: 1, deletions: 1, patch: 'x'.repeat(100001) }, { filename: 'image.png', status: 'added', additions: 0, deletions: 0 }]);
  });
  const review = await service.review('t', url);
  expect(review.comments.map(c => c.body)).toEqual(['Discussion', 'Inline']);
  expect(review.comments[1]).toMatchObject({ path: 'src/a.ts', line: 4, url: url + '#discussion_r12' });
  expect(review.checks[0]).toEqual({ name: 'tests', state: 'FAILURE', url: '' });
  await service.review('t', url); expect(calls.length).toBe(2);
  const files = await service.files('t', url, 2);
  expect(files.truncated).toBe(true); expect(files.files[0]!.patch!.length).toBe(100000); expect(files.files[1]!.patch).toBeNull();
  expect(calls.at(-1)?.at(-1)).toBe('repos/example/repo/pulls/1/files?per_page=30&page=2');
  expect(() => service.files('t', url, 0)).toThrow('page');
  expect(() => service.review('t', 'https://evil.example/a/b/pull/1')).toThrow('host');
});

test('paired phones cannot turn review reads into arbitrary GitHub queries', async () => {
  harness = await startTestCore();
  const owner = await harness.connect(), { threadId } = await echoThread(harness, owner);
  const { grant } = await owner.call('pairing.grant', {}), phone = await connect(harness.url, '', { grant });
  try {
    await expect(phone.call('threads.pullRequestReview', { threadId, url })).rejects.toThrow('link this');
    await expect(phone.call('threads.pullRequestFiles', { threadId, url, page: 1 })).rejects.toThrow('link this');
    await expect(phone.call('threads.linkPullRequest', { threadId, url })).rejects.toThrow('owner');
  } finally { phone.close(); owner.close(); }
});

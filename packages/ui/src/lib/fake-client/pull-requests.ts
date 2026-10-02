import { orderPullRequests, pullRequestAddress, type LinkedPullRequest } from '@boite/contracts';
import type { FakeContext, FakeMethods } from './context';
import { refusal } from './shared';

export function pullRequestMethods(ctx: FakeContext): Pick<FakeMethods, 'threads.pullRequests' | 'threads.linkPullRequest' | 'threads.unlinkPullRequest' | 'threads.pullRequestReview' | 'threads.pullRequestFiles'> {
  const lists = new Map<string, LinkedPullRequest[]>();
  const read = (id: string) => { ctx.thread(id); return lists.get(id) ?? []; };
  const linked = (id: string, url: string) => {
    const match = read(id).find(pr => pr.url.toLowerCase() === pullRequestAddress(url).url.toLowerCase());
    if (!match) throw refusal('link this pull request to the conversation before reading its review');
    return match;
  };
  const save = (id: string, prs: LinkedPullRequest[]) => {
    const ordered = orderPullRequests(prs); lists.set(id, ordered);
    ctx.emitToThread(id, 'threads.pullRequestsChanged', { threadId: id, pullRequests: structuredClone(ordered) });
    return structuredClone(ordered);
  };
  return {
    'threads.pullRequestReview': async ({ threadId, url }) => {
      const pr = linked(threadId, url);
      return { url: pr.url, title: pr.title, body: 'Preview review for the in-memory client.', state: pr.state, head: pr.head, base: pr.base, checkedAt: Date.now(), truncated: false,
        checks: [{ name: 'UI tests', state: 'SUCCESS', url: pr.url }], comments: [{ author: 'reviewer', body: 'Check the layout on a phone.', at: new Date().toISOString(), url: pr.url }], reviews: [] };
    },
    'threads.pullRequestFiles': async ({ threadId, url, page }) => {
      linked(threadId, url);
      if (!Number.isSafeInteger(page) || page < 1 || page > 100) throw refusal('pull request files page must be between 1 and 100');
      return { page, hasMore: false, truncated: false, files: page === 1 ? [{ path: 'src/preview.ts', status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-const width = 720;\n+const width = 390;' }] : [] };
    },
    'threads.pullRequests': async ({ threadId }) => structuredClone(read(threadId)),
    'threads.linkPullRequest': async ({ threadId, url }) => {
      const list = read(threadId), address = pullRequestAddress(url);
      if (ctx.thread(threadId).archived) throw refusal('linkPullRequest needs an active conversation');
      if (address.host !== 'github.com') throw refusal('pull request host must be github.com');
      if (list.some(pr => pr.url.toLowerCase() === address.url.toLowerCase())) return structuredClone(list);
      if (list.length >= 20) throw refusal('a conversation can link at most 20 pull requests');
      return save(threadId, [...list, { ...address, title: `Pull request ${address.number}`, state: 'OPEN', draft: false,
        head: `feature-${address.number}`, base: 'main', headRepository: address.repository, checkedAt: Date.now() }]);
    },
    'threads.unlinkPullRequest': async ({ threadId, url }) => save(threadId, read(threadId).filter(pr => pr.url.toLowerCase() !== pullRequestAddress(url).url.toLowerCase())),
  };
}

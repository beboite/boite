import { orderPullRequests, pullRequestAddress, type LinkedPullRequest, type PullRequestWatch } from '@boite/contracts';
import type { FakeContext, FakeMethods } from './context';
import { refusal, toSummary } from './shared';
import { sweepMergedPrFixtures } from './merged-pr-archive';

type Methods = Pick<FakeMethods, 'threads.pullRequest' | 'threads.pullRequests' | 'threads.linkPullRequest' | 'threads.unlinkPullRequest' | 'threads.pullRequestReview' | 'threads.pullRequestFiles' | 'threads.watchPullRequest' | 'threads.unwatchPullRequest'>;

export function pullRequestMethods(ctx: FakeContext): Methods {
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
  /** As the core: the watches ride on the thread's row, so every change is a `thread.updated`. */
  const setWatches = (id: string, watches: PullRequestWatch[]) => {
    const thread = ctx.thread(id);
    thread.pullRequestWatches = watches;
    ctx.emit('thread.updated', structuredClone(toSummary(thread)));
    return structuredClone(watches);
  };
  /** A linked URL or number, else the only linked one; a new URL is linked first. */
  const target = async (id: string, input: string | undefined): Promise<LinkedPullRequest> => {
    const list = read(id);
    const number = input === undefined ? null : /^#?(\d+)$/.exec(input.trim())?.[1];
    if (input === undefined) {
      if (list.length === 1) return list[0]!;
      throw refusal(list.length ? 'this conversation links several pull requests; name the one to watch' : 'this conversation has no linked pull request: run boite pr link <url> first, or name its URL');
    }
    if (number) {
      const match = list.find(pr => pr.number === Number(number));
      if (!match) throw refusal(`no linked pull request is #${number}; name its URL to link and watch it`);
      return match;
    }
    const url = pullRequestAddress(input).url;
    return list.find(pr => pr.url.toLowerCase() === url.toLowerCase()) ?? (await methods['threads.linkPullRequest']({ threadId: id, url })).find(pr => pr.url.toLowerCase() === url.toLowerCase())!;
  };
  const methods: Methods = {
    'threads.pullRequest': async ({ threadId }) => {
      const list = read(threadId), linked = list.findLast(pr => pr.state === 'OPEN') ?? list.at(-1);
      const thread = ctx.thread(threadId);
      const fixture = ctx.mergedPrFixtures.get(threadId);
      const candidate = fixture?.candidates.find(pr => pr.linked || (!pr.fork && pr.branch === fixture.branch));
      const merged = candidate ? { number: candidate.number, url: candidate.url, state: 'MERGED' as const } : null;
      const discovered = thread.branch && thread.branch !== 'HEAD' ? thread.pullRequest ?? merged : null;
      const pr = linked?.state === 'OPEN' ? linked : discovered?.state === 'OPEN' ? discovered : linked ?? discovered;
      if (pr?.state === 'MERGED') await sweepMergedPrFixtures(ctx, threadId);
      return pr ? { number: pr.number, url: pr.url, state: pr.state } : null;
    },
    'threads.watchPullRequest': async ({ threadId, url }) => {
      const thread = ctx.thread(threadId);
      if (thread.archived) throw refusal('watching a pull request needs an active conversation');
      if (thread.parentThreadId) throw refusal('a delegated agent cannot watch a pull request: its result goes to its parent, which can watch it');
      const pr = await target(threadId, url);
      if (pr.state !== 'OPEN') throw refusal(`pull request #${pr.number} is ${pr.state.toLowerCase()}; there is nothing to watch`);
      const watches = thread.pullRequestWatches ?? [];
      const held = watches.find(watch => watch.url === pr.url);
      if (held) return structuredClone(held);
      if (watches.length >= 10) throw refusal('a conversation can watch at most 10 pull requests');
      const now = Date.now();
      const watch: PullRequestWatch = { url: pr.url, repository: pr.repository, number: pr.number, since: now, paused: null,
        seen: { checkedAt: now, head: 'a1b2c3d', base: pr.base, checks: { total: 4, running: 2, failed: 0 }, conflicting: false } };
      setWatches(threadId, [...watches, watch]);
      return structuredClone(watch);
    },
    'threads.unwatchPullRequest': async ({ threadId, url }) => {
      const watches = ctx.thread(threadId).pullRequestWatches ?? [];
      if (url === undefined) return setWatches(threadId, []);
      const number = /^#?(\d+)$/.exec(url.trim())?.[1];
      const match = number ? watches.find(watch => watch.number === Number(number)) : watches.find(watch => watch.url.toLowerCase() === pullRequestAddress(url).url.toLowerCase());
      if (!match) throw refusal(`this conversation does not watch ${url}`);
      return setWatches(threadId, watches.filter(watch => watch !== match));
    },
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
  return methods;
}

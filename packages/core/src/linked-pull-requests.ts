import { orderPullRequests, pullRequestAddress, type LinkedPullRequest } from '@boite/contracts';
import type { Core } from './core.ts';
import { messageOf, refused } from './errors.ts';

const PREFIX = 'linked-pull-requests:';
const LIMIT = 20;

/** Explicit links belong to the conversation, including when its checkout moves. */
export class LinkedPullRequests {
  private queues = new Map<string, Promise<unknown>>();
  private refreshed = new Map<string, number>();
  constructor(private core: Core, private fetch: (threadId: string, url: string) => Promise<LinkedPullRequest>) {}

  private stored(threadId: string): LinkedPullRequest[] {
    this.core.threads.require(threadId);
    return (this.core.journal.getSetting(PREFIX + threadId) as LinkedPullRequest[] | undefined) ?? [];
  }
  requireLink(threadId: string, input: string): string {
    const { url } = pullRequestAddress(input);
    if (!this.stored(threadId).some(pr => pr.url.toLowerCase() === url.toLowerCase())) throw refused('link this pull request to the conversation before reading its review');
    return url;
  }
  private save(threadId: string, list: LinkedPullRequest[]): LinkedPullRequest[] {
    this.core.threads.require(threadId); // Do not resurrect a deleted conversation after a lookup.
    const ordered = orderPullRequests(list);
    this.core.journal.setSetting(PREFIX + threadId, ordered);
    this.core.bus.emit('threads.pullRequestsChanged', { threadId, pullRequests: ordered });
    return ordered;
  }
  private serialize(threadId: string, run: () => Promise<LinkedPullRequest[]>): Promise<LinkedPullRequest[]> {
    const next = (this.queues.get(threadId) ?? Promise.resolve()).catch(() => {}).then(run);
    this.queues.set(threadId, next);
    void next.finally(() => { if (this.queues.get(threadId) === next) this.queues.delete(threadId); }).catch(() => {});
    return next;
  }
  list(threadId: string, refresh = false): Promise<LinkedPullRequest[]> {
    return this.serialize(threadId, async () => {
      const list = this.stored(threadId);
      if (!list.length || (!refresh && Date.now() - (this.refreshed.get(threadId) ?? 0) < 60_000)) return list;
      this.refreshed.set(threadId, Date.now());
      if (this.refreshed.size > 500) this.refreshed.delete(this.refreshed.keys().next().value!);
      const updated = await Promise.all(list.map(async pr => {
        try { return await this.fetch(threadId, pr.url); }
        catch (error) { return { ...pr, error: messageOf(error).slice(0, 500) }; }
      }));
      return this.save(threadId, updated);
    });
  }
  link(threadId: string, input: string): Promise<LinkedPullRequest[]> {
    return this.serialize(threadId, async () => {
      const thread = this.core.threads.require(threadId);
      if (thread.archived) throw refused('linkPullRequest needs an active conversation');
      const { url } = pullRequestAddress(input);
      const list = this.stored(threadId), key = url.toLowerCase();
      if (list.some(pr => pr.url.toLowerCase() === key)) return list;
      if (list.length >= LIMIT) throw refused(`a conversation can link at most ${LIMIT} pull requests`);
      const pr = await this.fetch(threadId, url);
      if (this.core.threads.require(threadId).archived) throw refused('the conversation was archived during the lookup');
      return this.save(threadId, [...list, pr]);
    });
  }
  unlink(threadId: string, input: string): Promise<LinkedPullRequest[]> {
    return this.serialize(threadId, async () => {
      const { url } = pullRequestAddress(input);
      return this.save(threadId, this.stored(threadId).filter(pr => pr.url.toLowerCase() !== url.toLowerCase()));
    });
  }
}

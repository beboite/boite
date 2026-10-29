import { orderPullRequests, pullRequestAddress, type LinkedPullRequest } from '@boite/contracts';
import type { Core } from './core.ts';
import type { Journal } from './journal.ts';
import { messageOf, refused } from './errors.ts';

const PREFIX = 'linked-pull-requests:';
const LIMIT = 20;

/** Every URL the conversation linked, as stored: a new link changes it. */
export function linkedPullRequestSignature(journal: Journal, threadId: string): string {
  const stored = journal.getSetting(PREFIX + threadId);
  return Array.isArray(stored) ? stored.map(entry => { const pr = entry as LinkedPullRequest; return `${pr?.url ?? ''}:${pr?.state ?? ''}`; }).join('\n') : '';
}

/**
 * The conversation's linked PR URLs in one GitHub repository (`host/owner/name`),
 * newest link first. Bad stored entries are skipped, never trusted.
 */
export function linkedPullRequestUrls(journal: Journal, threadId: string, repository: string): string[] {
  const stored = journal.getSetting(PREFIX + threadId);
  if (!Array.isArray(stored)) return [];
  const urls: string[] = [];
  for (const entry of [...stored].reverse()) {
    try {
      const address = pullRequestAddress((entry as { url?: unknown } | null)?.url as string);
      if (`${address.host}/${address.repository}`.toLowerCase() === repository.toLowerCase() && !urls.includes(address.url)) urls.push(address.url);
    } catch { /* A malformed entry names no PR. */ }
  }
  return urls;
}

/** Where an open pull request's head lives: `host/owner/name`, lowercase, and the branch there. */
export interface LinkedHead {
  repository: string;
  branch: string;
}

/**
 * The heads of the open PRs that live conversations linked, as last read
 * from GitHub. Archived and deleted conversations claim nothing. A head whose
 * repository GitHub no longer names (a deleted fork) stands for the base
 * repository: the claim stays on the side of keeping.
 */
export function openLinkedHeads(journal: Journal): LinkedHead[] {
  const rows = journal.db.query(`SELECT settings.value AS value FROM settings JOIN threads ON settings.key = '${PREFIX}' || threads.id
    WHERE threads.archived = 0 AND threads.id NOT IN (SELECT thread_id FROM thread_deletions)`).all() as { value: string }[];
  const heads: LinkedHead[] = [];
  for (const { value } of rows) {
    let stored: unknown;
    try { stored = JSON.parse(value); } catch { continue; }
    if (!Array.isArray(stored)) continue;
    for (const entry of stored as Partial<LinkedPullRequest>[]) {
      if (entry?.state !== 'OPEN' || typeof entry.head !== 'string' || entry.head.length === 0) continue;
      let address: ReturnType<typeof pullRequestAddress>;
      try { address = pullRequestAddress(entry.url as string); } catch { continue; }
      const owner = typeof entry.headRepository === 'string' && entry.headRepository.length > 0 ? entry.headRepository : address.repository;
      heads.push({ repository: `${address.host}/${owner}`.toLowerCase(), branch: entry.head });
    }
  }
  return heads;
}

/**
 * Whether one of `heads` is this local branch: the same name in a repository
 * the checkout fetches from (`remotes`, as `host/owner/name`). Null remotes,
 * a checkout whose remotes could not be read, keep every head of that name.
 */
export function claimsBranch(heads: readonly LinkedHead[], branch: string, remotes: ReadonlySet<string> | null): boolean {
  return heads.some(head => head.branch === branch && (remotes === null || remotes.has(head.repository)));
}

/** Explicit links belong to the conversation, including when its checkout moves. */
export class LinkedPullRequests {
  private queues = new Map<string, Promise<unknown>>();
  private refreshed = new Map<string, number>();
  constructor(private core: Core, private fetch: (threadId: string, url: string, refresh?: boolean) => Promise<LinkedPullRequest>) {}

  private stored(threadId: string): LinkedPullRequest[] {
    this.core.threads.require(threadId);
    return (this.core.journal.getSetting(PREFIX + threadId) as LinkedPullRequest[] | undefined) ?? [];
  }
  /** The links as saved, without asking GitHub. */
  saved(threadId: string): LinkedPullRequest[] { return this.stored(threadId); }
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
      if (!list.length || (!refresh && Date.now() - (this.refreshed.get(threadId) ?? 0) < 15_000)) return list;
      // A merged pull request stays merged: only the user's refresh reads it
      // again. A closed one can reopen, so it is read like an open one.
      const stale = (pr: LinkedPullRequest) => refresh || pr.state !== 'MERGED' || pr.error !== undefined;
      if (!list.some(stale)) return list;
      this.refreshed.set(threadId, Date.now());
      if (this.refreshed.size > 500) this.refreshed.delete(this.refreshed.keys().next().value!);
      const updated = await Promise.all(list.map(async pr => {
        if (!stale(pr)) return pr;
        try { return await this.fetch(threadId, pr.url, refresh); }
        catch (error) { return { ...pr, error: messageOf(error).slice(0, 500) }; }
      }));
      return this.save(threadId, updated);
    });
  }
  /** A watch already read this state from GitHub. All surfaces share that answer. */
  observe(threadId: string, url: string, state: LinkedPullRequest['state'], head?: Pick<LinkedPullRequest, 'head' | 'headRepository'>): Promise<LinkedPullRequest[]> {
    return this.serialize(threadId, async () => {
      const list = this.stored(threadId);
      const key = url.toLowerCase();
      // A head GitHub renamed moves the branch the link claims; an empty answer changes nothing.
      const moved = (pr: LinkedPullRequest) => (head?.head ? pr.head !== head.head : false) || (head?.headRepository ? pr.headRepository !== head.headRepository : false);
      if (!list.some(pr => pr.url.toLowerCase() === key && (pr.state !== state || pr.error || moved(pr)))) return list;
      return this.save(threadId, list.map(pr => {
        if (pr.url.toLowerCase() !== key) return pr;
        const { error: _error, ...known } = pr;
        return { ...known, state, ...(head?.head ? { head: head.head } : {}), ...(head?.headRepository ? { headRepository: head.headRepository } : {}), checkedAt: Date.now() };
      }));
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

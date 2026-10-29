export interface LinkedPullRequest {
  url: string;
  repository: string;
  number: number;
  title: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  draft: boolean;
  head: string;
  base: string;
  headRepository: string;
  checkedAt: number;
  error?: string;
}
export interface PullRequestsRpcMethods {
  'threads.pullRequestReview': { params: { threadId: string; url: string }; result: PullRequestReview };
  'threads.pullRequestFiles': { params: { threadId: string; url: string; page: number }; result: PullRequestFiles };
  'threads.pullRequests': { params: { threadId: string; refresh?: boolean }; result: LinkedPullRequest[] };
  'threads.linkPullRequest': { params: { threadId: string; url: string }; result: LinkedPullRequest[] };
  'threads.unlinkPullRequest': { params: { threadId: string; url: string }; result: LinkedPullRequest[] };
  /**
   * Watches a pull request for the thread's agent: Boite reads it on GitHub
   * and wakes the agent when it needs a look. `url` is a linked pull request's
   * URL or number, or a new URL to link first; omitted, the thread's only
   * linked pull request. Answers with what the first read saw.
   */
  'threads.watchPullRequest': { params: { threadId: string; url?: string }; result: PullRequestWatch };
  /** Stops one watch (`url`: its URL or number), or every watch of the thread. Answers with those left. */
  'threads.unwatchPullRequest': { params: { threadId: string; url?: string }; result: PullRequestWatch[] };
}

/**
 * A pull request a thread's agent asked Boite to watch (`boite pr watch`).
 * The core reads it about once a minute and wakes the agent with one message
 * when a check fails, the required checks all passed, a review or a comment
 * landed, or the branch started to conflict. It ends on merge or close, on
 * Stop, on archive and on unwatch, and survives a core restart.
 */
export interface PullRequestWatch {
  url: string;
  repository: string;
  number: number;
  /** When the watch started. */
  since: number;
  /** What the last answer from GitHub showed; null before the first one. */
  seen: PullRequestWatchSeen | null;
  /**
   * Why the last read got no answer and when the next one is tried: GitHub's
   * rate limit, or GitHub or `gh` out of reach. The watch keeps going. Null
   * once GitHub answers again.
   */
  paused: { reason: 'rate-limit' | 'unreachable'; until: number; message: string } | null;
}
/**
 * A watch its agent still waits on: GitHub not read yet, checks still
 * running, or the pull request in the merge queue, whose checks run on its
 * own merge group. Once they settle the agent has its answer, and the turn it
 * ended on is finished work even though the watch stays to catch a review or
 * a conflict.
 */
export function pullRequestWatchWaits(watch: PullRequestWatch): boolean {
  return watch.seen === null || watch.seen.checks.running > 0 || Boolean(watch.seen.queue);
}
export interface PullRequestWatchSeen {
  checkedAt: number;
  /** The head commit, abbreviated. */
  head: string;
  base: string;
  checks: { total: number; running: number; failed: number };
  conflicting: boolean;
  /** Behind a base that requires branches up to date; absent from what a core older than it saw. */
  behind?: boolean;
  /**
   * Its entry in the base branch's merge queue: 1 is next to merge. Null out
   * of the queue; absent from what a core older than it saw.
   */
  queue?: { position: number } | null;
}
export interface PullRequestComment { author: string; body: string; url: string; at: string; path?: string; line?: number; state?: string }
export interface PullRequestCheck { name: string; state: string; url: string }
export interface PullRequestReview {
  url: string; title: string; body: string; state: string; head: string; base: string; checkedAt: number;
  checks: PullRequestCheck[]; comments: PullRequestComment[]; reviews: PullRequestComment[]; truncated: boolean;
}
export interface PullRequestFile { path: string; previousPath?: string; status: string; additions: number; deletions: number; patch: string | null }
export interface PullRequestFiles { files: PullRequestFile[]; page: number; hasMore: boolean; truncated: boolean }
export interface PullRequestsRpcEvents {
  'threads.pullRequestsChanged': { threadId: string; pullRequests: LinkedPullRequest[] };
}

/** Exact PR URLs only. A link never provides credentials, a port or CLI flags. */
export function pullRequestAddress(input: string): { url: string; host: string; repository: string; number: number } {
  if (typeof input !== 'string' || input.length > 2048) throw new Error('pull request url must be an HTTPS GitHub pull request URL');
  const match = /^https:\/\/([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)\/?(?:[?#]\S*)?$/i.exec(input.trim());
  if (!match || [match[2], match[3]].some(part => part === '.' || part === '..') || !Number.isSafeInteger(Number(match[4])))
    throw new Error('pull request url must be https://host/owner/repository/pull/number');
  const host = match[1]!.toLowerCase(), repository = `${match[2]}/${match[3]}`;
  return { url: `https://${host}/${repository}/pull/${match[4]}`, host, repository, number: Number(match[4]) };
}

/** A base branch depends only on a head in the same repository, never a fork's identically named branch. */
export function pullRequestParent(pr: LinkedPullRequest, all: LinkedPullRequest[]): LinkedPullRequest | undefined {
  const candidates = all.filter(parent => parent.url !== pr.url && parent.head === pr.base &&
    parent.headRepository.toLowerCase() === pr.repository.toLowerCase() && pullRequestAddress(parent.url).host === pullRequestAddress(pr.url).host);
  return candidates.length === 1 ? candidates[0] : undefined;
}

export function orderPullRequests(all: LinkedPullRequest[]): LinkedPullRequest[] {
  const ordered: LinkedPullRequest[] = [], visited = new Set<string>(), visiting = new Set<string>();
  const visit = (pr: LinkedPullRequest): void => {
    if (visited.has(pr.url) || visiting.has(pr.url)) return;
    visiting.add(pr.url);
    const parent = pullRequestParent(pr, all);
    if (parent) visit(parent);
    visiting.delete(pr.url); visited.add(pr.url); ordered.push(pr);
  };
  all.forEach(visit);
  return ordered;
}

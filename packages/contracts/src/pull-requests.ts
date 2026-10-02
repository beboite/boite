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

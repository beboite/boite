import { pullRequestAddress, type LinkedPullRequest, type ThreadSummary } from '@boite/contracts';
import type { Core } from './core.ts';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve } from 'node:path';
import { messageOf, refused } from './errors.ts';
import { linkedPullRequestUrls } from './linked-pull-requests.ts';
import { GIT_PROBE_TIMEOUT_MS, hasGitMarker } from './projects.ts';
import { PullRequestReviews } from './pull-request-review.ts';

type PullRequest = ThreadSummary['pullRequest'];
/** What a merge proof reads of a thread. The worktree cleanup also asks for a worktree whose thread was deleted. */
export type CheckoutOwner = Pick<ThreadSummary, 'id' | 'cwd' | 'branch' | 'projectId'>;

export function hasGitHubRemote(remotes: string, host = process.env.GH_HOST ?? 'github.com'): boolean {
  return remotes.split('\n').some(line => {
    const url = line.trim().split(/\s+/)[1];
    if (!url) return false;
    let remoteHost = '';
    try { remoteHost = new URL(url).hostname; }
    catch { /* Git also accepts SCP-style remotes. */ }
    if (!remoteHost) remoteHost = url.match(/^(?:[^@/\s]+@)?([^:/\s]+):/)?.[1] ?? '';
    return remoteHost.toLowerCase() === host.toLowerCase();
  });
}

function pullRequestArray(text: string): unknown[] {
  const values: unknown = JSON.parse(text);
  if (!Array.isArray(values)) throw new Error('gh output must be a pull request array');
  return values;
}

function toPullRequest(value: unknown): NonNullable<PullRequest> {
  const item = value as Record<string, unknown> | null | undefined;
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('gh output must contain a pull request object');
  if (
    !Number.isInteger(item.number) ||
    Number(item.number) < 1 ||
    typeof item.url !== 'string' ||
    !['OPEN', 'CLOSED', 'MERGED'].includes(String(item.state))
  )
    throw new Error('gh output must contain number, url and state');
  const url = new URL(item.url);
  if (url.protocol !== 'https:' || url.username || url.password)
    throw new Error('pull request url must use HTTPS without credentials');
  return { number: Number(item.number), url: url.href, state: item.state as 'OPEN' | 'CLOSED' | 'MERGED' };
}

export function parsePullRequests(text: string): PullRequest {
  const values = pullRequestArray(text);
  return values.length === 0 ? null : toPullRequest(values[0]);
}

type PullRequestList = {
  /** The newest pull request of each head branch, as gh lists them newest first. */
  byHead: Map<string, NonNullable<PullRequest>>;
  /** Every pull request gh returned for each head branch, as gh wrote them: merge proofs read them. */
  heads: Map<string, unknown[]>;
  /** Each pull request as gh wrote it, by lowercase URL. */
  urls: Map<string, unknown>;
  /** How many pull requests gh returned, before two of one branch collapse into one entry. */
  count: number;
};

/** A repository's pull requests by head branch, and how many gh returned. */
export function parsePullRequestList(text: string): PullRequestList {
  const values = pullRequestArray(text);
  const byHead = new Map<string, NonNullable<PullRequest>>();
  const heads = new Map<string, unknown[]>();
  const urls = new Map<string, unknown>();
  for (const value of values) {
    const head = (value as { headRefName?: unknown } | null)?.headRefName;
    if (typeof head !== 'string' || head.length === 0) throw new Error('gh output must name each pull request\'s headRefName');
    const pr = toPullRequest(value);
    if (!byHead.has(head)) byHead.set(head, pr);
    const all = heads.get(head);
    if (all) all.push(value); else heads.set(head, [value]);
    urls.set(pr.url.toLowerCase(), value);
  }
  return { byHead, heads, urls, count: values.length };
}

/**
 * The branch a linked worktree has checked out, read from its own HEAD file
 * without a Git process; null on a detached HEAD.
 */
async function checkoutBranch(root: string): Promise<string | null> {
  const marker = join(root, '.git');
  const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(await readFile(marker, 'utf8'))?.[1];
  if (!pointer) throw new Error(`${marker} must contain a gitdir path`);
  const head = await readFile(resolve(root, pointer, 'HEAD'), 'utf8');
  return /^ref: refs\/heads\/(.+)\s*$/m.exec(head)?.[1]?.trim() ?? null;
}

/** Only a merged pull request can prove anything: the others need no checkout read. */
function mergedEvidence(value: unknown): boolean {
  return (value as { state?: unknown } | null)?.state === 'MERGED';
}

/** Fetch identity wins over push URLs; origin identifies the checkout when upstream is also configured. */
function discoveryRepository(remotes: string): string | null {
  const fetches = remotes.split('\n').filter(line => /\(fetch\)\s*$/.test(line));
  const origin = fetches.find(line => /^origin\s/.test(line));
  return origin ? githubRepository(origin) : githubRepository(fetches.join('\n'));
}

function localCandidates(values: unknown[]): unknown[] {
  // Branch names are not unique across forks. Fork PRs need an explicit conversation link.
  return values.filter(value => (value as { isCrossRepository?: unknown })?.isCrossRepository !== true);
}

function displayCandidate(values: unknown[]): PullRequest {
  const candidates = localCandidates(values).map(toPullRequest);
  return candidates.find(pr => pr.state === 'OPEN') ?? candidates[0] ?? null;
}

/**
 * The repository a checkout belongs to: its common git directory. Every
 * `git worktree add` checkout has a `.git` file of its own, and each of those
 * files leads to the same common directory.
 */
export function repositoryOf(root: string): string {
  let gitDir = join(root, '.git');
  try {
    if (statSync(gitDir).isFile()) {
      const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(gitDir, 'utf8'))?.[1];
      if (pointer) {
        gitDir = resolve(root, pointer);
        const common = join(gitDir, 'commondir');
        if (existsSync(common)) gitDir = resolve(gitDir, readFileSync(common, 'utf8').trim());
      }
    }
  } catch { /* An unreadable pointer leaves the checkout standing for itself. */ }
  // The real path, so a checkout reached through a link or a Windows short
  // name (`RUNNER~1`) keys like the pointer git wrote in long form.
  let key = normalize(gitDir);
  try { key = realpathSync.native(key); } catch { /* A missing .git keys by its spelling. */ }
  return process.platform === 'win32' ? key.toLowerCase() : key;
}

/** The action proof is deliberately separate from the sidebar's three display fields. */
export interface MergedPrProof {
  repository: string;
  checkoutRepository: string;
  /** The checkout's own branch when proved, null on a detached HEAD. The PR head may have another name. */
  branch: string | null;
  sha: string;
  number: number;
  url: string;
  mergedAt: string;
}

/** A remote URL's `host` and `owner/name`, HTTPS or SCP-style; null when it names neither. */
function remoteIdentity(raw: string): { host: string; path: string } | null {
  let hostname = '', path = '';
  try { const url = new URL(raw); hostname = url.hostname; path = url.pathname; }
  catch { const match = /^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/.exec(raw); if (match) { hostname = match[1]!; path = match[2]!; } }
  if (!hostname) return null;
  return { host: hostname.toLowerCase(), path: path.replace(/^\//, '').replace(/\/+$/, '').replace(/\.git$/, '').replace(/\/+$/, '') };
}

export function githubRepository(remotes: string, host = process.env.GH_HOST ?? 'github.com'): string | null {
  const identities = new Set<string>();
  for (const line of remotes.split('\n')) {
    const raw = line.trim().split(/\s+/)[1];
    const remote = raw ? remoteIdentity(raw) : null;
    if (remote === null || remote.host !== host.toLowerCase()) continue;
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(remote.path)) return null;
    identities.add(`${remote.host}/${remote.path.toLowerCase()}`);
  }
  return identities.size === 1 ? [...identities][0]! : null;
}

/** Every repository `git remote -v` fetches from, as `host/owner/name` in lowercase, whatever the host. */
export function fetchedRepositories(remotes: string): Set<string> {
  const repositories = new Set<string>();
  for (const line of remotes.split('\n')) {
    if (!/\(fetch\)\s*$/.test(line)) continue;
    const raw = line.trim().split(/\s+/)[1];
    const remote = raw ? remoteIdentity(raw) : null;
    if (remote !== null && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(remote.path)) repositories.add(`${remote.host}/${remote.path}`.toLowerCase());
  }
  return repositories;
}

/**
 * A merged PR whose head commit is the checkout's clean tip. A PR found by
 * branch name must also have that name; a PR the conversation linked names
 * itself, so the agent may have pushed the tip under another branch name.
 */
export function parseMergedPrProof(text: string, expected: Omit<MergedPrProof, 'number' | 'url' | 'mergedAt'>, linked = false): MergedPrProof | null {
  const values = pullRequestArray(text);
  // Reusing a branch, or finding a fork, never selects an arbitrary newest PR.
  if (values.length !== 1) return null;
  const item = values[0] as Record<string, unknown>;
  const pr = toPullRequest(item);
  if (pr.state !== 'MERGED' || item.isCrossRepository !== false || (!linked && item.headRefName !== expected.branch) || typeof item.headRefName !== 'string' || item.headRefOid !== expected.sha || typeof item.mergedAt !== 'string' || !Number.isFinite(Date.parse(item.mergedAt))) return null;
  const [host, owner, name] = expected.repository.split('/');
  const repository = item.headRepository as { name?: unknown } | null;
  const repositoryOwner = item.headRepositoryOwner as { login?: unknown } | null;
  const url = new URL(pr.url);
  if (url.search || url.hash) return null;
  if (repository?.name?.toString().toLowerCase() !== name || repositoryOwner?.login?.toString().toLowerCase() !== owner || url.hostname.toLowerCase() !== host || url.pathname.toLowerCase() !== `/${owner}/${name}/pull/${pr.number}`) return null;
  return { ...expected, number: pr.number, url: pr.url, mergedAt: item.mergedAt };
}

/** Pull requests one `gh pr list` call brings back for a repository. */
export const LIST_LIMIT = 200;
const LIST_TTL_MS = 15_000;
/** A failed read is kept this long, whatever the success TTL of its cache. */
const FAILURE_TTL_MS = LIST_TTL_MS;
const PROOF_TTL_MS = 60_000;
const PROOF_FIELDS = 'number,url,state,headRefName,headRefOid,headRepository,headRepositoryOwner,isCrossRepository,mergedAt';
const DETAIL_FIELDS = `${PROOF_FIELDS},title,isDraft,baseRefName`;
/** A repository's remotes rarely change: they are read once per five minutes. */
const REMOTES_TTL_MS = 5 * 60_000;
const TIMEOUT_MS = 10_000;

/** One read shared by its concurrent callers; it stops once every caller that can cancel did. */
type Shared<T> = { until: number; value: Promise<T>; controller: AbortController; consumers: number; settled: boolean; kept: boolean };
interface WaitingLookup { admit(): void; cancel(): void }

export interface PullRequestOptions {
  /** Tests shorten the existing ten-second process deadline. */
  timeoutMs?: number;
  /** Exceeding this bound rejects evidence, never parses a truncated response. */
  maxOutputBytes?: number;
}

/** gh is not installed, or not signed in: nothing a background lookup can fix. */
function unavailable(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  const message = messageOf(error);
  return code === 'ENOENT' || /not found in \$?PATH|gh auth login|not logged in/i.test(message);
}

/**
 * The pull request of each thread's branch, answered from one `gh pr list` per
 * repository: forty threads in one checkout, or in forty worktrees of it,
 * make one gh call, not forty. Every process runs two at a time at most, and
 * stops after ten seconds. Results and failures are kept fifteen seconds; `refresh`
 * drops what is kept for that repository, tries a missing gh again and
 * reports why gh cannot answer.
 */
export class PullRequests {
  #proofs = new Map<string, Shared<MergedPrProof | null>>();
  readonly reviews = new PullRequestReviews((threadId, args) => { const thread = this.core.threads.require(threadId); return this.#run(thread, thread.cwd, 'gh', args); });
  /** `git remote -v` as git wrote it, per repository: badges and merge proofs both read it. */
  #remotes = new Map<string, Shared<string>>();
  #lists = new Map<string, Shared<PullRequestList>>();
  #branches = new Map<string, Shared<PullRequest>>();
  #details = new Map<string, Shared<Record<string, unknown>>>();
  /** Automatic discovery pauses for a minute after gh is missing or signed out. */
  #ghUnavailableUntil = 0;
  #running = 0;
  #queue: WaitingLookup[] = [];
  #sequence = 0;
  readonly #timeoutMs: number;
  readonly #maxOutputBytes: number;
  constructor(private core: Core, options: PullRequestOptions = {}) {
    this.#timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
    this.#maxOutputBytes = options.maxOutputBytes ?? 8 * 1024 * 1024;
  }

  /**
   * A `gh` call for a pull request watch, in the thread's folder when it is
   * still there (a removed worktree leaves it gone; `gh api` needs none), under
   * the same two-at-a-time queue and deadline as every lookup here.
   */
  gh(threadId: string, args: string[]): Promise<string> {
    const thread = this.core.threads.require(threadId);
    return this.#run(thread, existsSync(thread.cwd) ? thread.cwd : this.core.dataDir, 'gh', args);
  }

  async detail(threadId: string, input: string, refresh = false): Promise<LinkedPullRequest> {
    const address = pullRequestAddress(input);
    const host = (process.env.GH_HOST ?? 'github.com').toLowerCase();
    if (address.host !== host) throw refused(`pull request host must be ${host}`);
    const value = await this.#detail(this.core.threads.require(threadId), address.url, refresh);
    const basic = toPullRequest(value);
    if (pullRequestAddress(basic.url).url.toLowerCase() !== address.url.toLowerCase()) throw refused('gh returned a different pull request URL');
    if (typeof value.title !== 'string' || typeof value.headRefName !== 'string' || typeof value.baseRefName !== 'string') throw refused('gh returned incomplete pull request metadata');
    const repository = value.headRepository as { name?: string } | null;
    const owner = value.headRepositoryOwner as { login?: string } | null;
    return { ...address, title: value.title.slice(0, 500), state: basic.state, draft: value.isDraft === true,
      head: value.headRefName.slice(0, 500), base: value.baseRefName.slice(0, 500),
      headRepository: owner?.login && repository?.name ? `${owner.login}/${repository.name}` : '', checkedAt: Date.now() };
  }

  #detail(thread: Pick<ThreadSummary, 'id' | 'cwd'>, url: string, refresh = false, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (refresh) this.#details.delete(url.toLowerCase());
    return this.#shared(this.#details, url.toLowerCase(), LIST_TTL_MS, async ownerSignal => {
      const raw = await this.#run(thread, existsSync(thread.cwd) ? thread.cwd : this.core.dataDir, 'gh', ['pr', 'view', url, '--json', DETAIL_FIELDS], ownerSignal);
      if (raw.length > 64 * 1024) throw refused('pull request metadata exceeds 64 KB');
      const value = JSON.parse(raw) as Record<string, unknown>;
      if (pullRequestAddress(toPullRequest(value).url).url.toLowerCase() !== url.toLowerCase()) throw refused('gh returned a different pull request URL');
      return value;
    }, signal);
  }

  read(threadId: string, refresh = false): Promise<PullRequest> {
    const thread = this.core.threads.require(threadId);
    return this.#read(thread, refresh).then(pr => {
      if (pr?.state === 'MERGED') this.core.mergedPrArchive.observe(threadId);
      return pr;
    }).catch((error: unknown) => {
      throw refused(`pull request for ${thread.cwd}: ${messageOf(error)}`);
    });
  }

  /**
   * The checkout's branch and tip when nothing is uncommitted or untracked.
   * Agents often leave the conversation's starting branch for one named after
   * the fix, so the branch is read from the checkout, not from the thread.
   * Fresh checkout checks use the same bounded process queue as display lookups.
   */
  async cleanCheckout(thread: CheckoutOwner, sha?: string, signal?: AbortSignal): Promise<{ branch: string | null; sha: string } | null> {
    if (!thread.branch || thread.branch === 'HEAD') return null;
    const status = await this.#run(thread, thread.cwd, 'git', ['status', '--porcelain=v2', '--branch', '-z'], signal);
    const records = status.split('\0').filter(Boolean);
    const branch = records.find(record => record.startsWith('# branch.head '))?.slice(14);
    const tip = records.find(record => record.startsWith('# branch.oid '))?.slice(13);
    if (!branch || !tip || !/^[a-f0-9]{40,64}$/.test(tip) || (sha && tip !== sha) || !records.every(record => record.startsWith('# '))) return null;
    return { branch: branch === '(detached)' ? null : branch, sha: tip };
  }

  async validateMergedCheckout(thread: CheckoutOwner, proof: MergedPrProof, signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted();
    if (repositoryOf(thread.cwd) !== proof.checkoutRepository || discoveryRepository(await this.#run(thread, thread.cwd, 'git', ['remote', '-v'], signal)) !== proof.repository) return false;
    return (await this.cleanCheckout(thread, proof.sha, signal))?.branch === proof.branch;
  }

  /**
   * The cheapest evidence comes first. The repository's remotes and its one
   * pull request list are shared with the sidebar's badges, so a thread whose
   * branch has no merged pull request costs no process of its own. The
   * checkout's status walk runs only when a merged pull request could match.
   */
  async proveMerged(thread: CheckoutOwner, signal?: AbortSignal): Promise<MergedPrProof | null> {
    signal?.throwIfAborted();
    const project = thread.projectId === null ? null : this.core.journal.getProject(thread.projectId);
    if (!project || resolve(thread.cwd) === resolve(project.path) || !thread.branch || thread.branch === 'HEAD') return null;
    // An alias of the project's shared checkout still has a shared HEAD.
    if (realpathSync.native(thread.cwd) === realpathSync.native(project.path) || !statSync(join(thread.cwd, '.git')).isFile()) return null;
    if (!await hasGitMarker(thread.cwd) || !await hasGitMarker(project.path)) return null;
    signal?.throwIfAborted();
    const checkoutRepository = repositoryOf(thread.cwd);
    if (checkoutRepository !== repositoryOf(project.path) || Date.now() < this.#ghUnavailableUntil) return null;
    const repository = discoveryRepository(await this.#remote(thread, thread.cwd, checkoutRepository, signal));
    if (!repository || Date.now() < this.#ghUnavailableUntil) return null;
    const head = await checkoutBranch(thread.cwd);
    let tip: { branch: string | null; sha: string } | null | undefined;
    const checkout = async () => tip === undefined ? (tip = await this.cleanCheckout(thread, undefined, signal)) : tip;
    // `boite pr link` is how an agent names its PR: it holds even when the agent
    // pushed the tip under a branch name the checkout does not have.
    let linkedProof: MergedPrProof | null = null;
    for (const url of linkedPullRequestUrls(this.core.journal, thread.id, repository)) {
      try {
        // A repository list is a discovery hint, never negative evidence about a known URL.
        const value = await this.#gh(false, () => this.#detail(thread, url, false, signal));
        if (!value) return null;
        if (value.state === 'OPEN') return null;
        if (!mergedEvidence(value)) continue;
        const clean = await checkout();
        if (!clean) return null;
        const proof = parseMergedPrProof(JSON.stringify([value]), { repository, checkoutRepository, branch: clean.branch, sha: clean.sha }, true);
        linkedProof ??= proof;
        if (Date.now() < this.#ghUnavailableUntil) return null;
      } catch (error) {
        // A deleted link can be skipped. A failed read cannot prove its work finished.
        signal?.throwIfAborted();
        if (!/no pull requests found|could not resolve to a PullRequest\b/i.test(messageOf(error))) return null;
      }
    }
    if (!head) return linkedProof;
    const list = await this.#gh(false, () => this.#list(thread, thread.cwd, checkoutRepository, repository, signal));
    if (list === null) return null;
    const complete = list.count < LIST_LIMIT;
    const listed = localCandidates(list.heads.get(head) ?? []);
    // A reused checkout can have new work even when its last linked PR merged.
    if (listed.some(value => toPullRequest(value).state === 'OPEN')) return null;
    if (linkedProof && complete) return linkedProof;
    // A branch reused by two pull requests proves nothing; a newest one that is
    // not merged means the branch has no single merged pull request either.
    if (complete && (listed.length !== 1 || !mergedEvidence(listed[0]))) return null;
    if (!linkedProof && listed.length && !listed.some(mergedEvidence)) return null;
    const clean = await checkout();
    if (!clean?.branch) return null;
    const expected = { repository, checkoutRepository, branch: clean.branch, sha: clean.sha };
    if (complete) return parseMergedPrProof(JSON.stringify(listed), expected);
    // A full page may hold only the newest pull request of a reused branch.
    const branch = clean.branch;
    return this.#gh(false, () => this.#shared(this.#proofs, `${checkoutRepository}\n${repository}\n${branch}\n${clean.sha}\n${linkedProof?.url ?? ''}`, PROOF_TTL_MS, async ownerSignal => {
      const values = pullRequestArray(await this.#run(thread, thread.cwd, 'gh', ['pr', 'list', '--repo', repository, '--head', branch, '--state', 'all', '--limit', String(LIST_LIMIT), '--json', PROOF_FIELDS], ownerSignal));
      // Filtering foreign forks cannot turn a truncated page into complete evidence.
      if (values.length >= LIST_LIMIT) return null;
      const local = localCandidates(values);
      if (local.some(value => toPullRequest(value).state === 'OPEN')) return null;
      return linkedProof ?? parseMergedPrProof(JSON.stringify(local), expected);
    }, signal));
  }

  /** `git remote -v`, read once per repository every five minutes. */
  #remote(thread: Pick<ThreadSummary, 'id'>, cwd: string, repository: string, signal?: AbortSignal): Promise<string> {
    return this.#shared(this.#remotes, repository, REMOTES_TTL_MS, ownerSignal => this.#run(thread, cwd, 'git', ['remote', '-v'], ownerSignal), signal);
  }

  /** The repository's newest pull requests, read once per fifteen seconds for badges and merge proofs alike. */
  #list(thread: Pick<ThreadSummary, 'id'>, cwd: string, repository: string, target: string, signal?: AbortSignal): Promise<PullRequestList> {
    return this.#shared(this.#lists, `${repository}\n${target}`, LIST_TTL_MS, async ownerSignal => {
      const list = parsePullRequestList(await this.#run(thread, cwd, 'gh', ['pr', 'list', '--repo', target, '--state', 'all', '--limit', String(LIST_LIMIT), '--json', PROOF_FIELDS], ownerSignal));
      const prefix = `https://${target}/pull/`;
      if (![...list.urls.keys()].every(url => url.startsWith(prefix))) throw refused(`gh pull request URLs must belong to ${target}`);
      return list;
    }, signal);
  }

  async #read(thread: ThreadSummary, refresh: boolean): Promise<PullRequest> {
    // Explicit links belong to the conversation even after its branch or checkout disappears.
    const links = await this.core.linkedPullRequests.list(thread.id, refresh);
    const linked = links.findLast(pr => pr.state === 'OPEN') ?? links.at(-1);
    if (refresh && linked?.error) throw refused(linked.error);
    const known = linked ? { number: linked.number, url: linked.url, state: linked.state } : null;
    if (known?.state === 'OPEN') return known;
    try {
      const found = await this.#discover(thread, refresh);
      return found?.state === 'OPEN' ? found : known ?? found;
    } catch (error) {
      if (known && !refresh) return known;
      throw error;
    }
  }

  async #discover(thread: ThreadSummary, refresh: boolean): Promise<PullRequest> {
    // A shared checkout's current branch belongs to no particular thread.
    // Only a branch associated with this thread can identify its pull request.
    let branch = thread.branch;
    if (!branch || branch === 'HEAD') return null;
    // Off the event loop and under one deadline: a folder on a share whose
    // host is gone answers nothing for 21 s.
    const deadline = Date.now() + GIT_PROBE_TIMEOUT_MS;
    let root = thread.cwd;
    for (;;) {
      const found = await hasGitMarker(root, Math.max(0, deadline - Date.now()));
      if (found === null) return null;
      if (found) break;
      const parent = dirname(root);
      if (parent === root) return null;
      root = parent;
    }
    // An agent can rename or switch its private worktree branch without changing
    // the recorded starting branch. Read its own HEAD, without a Git process per row.
    if (statSync(join(root, '.git')).isFile()) {
      branch = await checkoutBranch(root);
      if (!branch) return null;
    }
    // Kept per repository: the worktrees of one repository share what is kept.
    const repository = repositoryOf(root);
    if (refresh) {
      this.#ghUnavailableUntil = 0;
      this.#remotes.delete(repository);
      for (const key of this.#lists.keys()) if (key.startsWith(`${repository}\n`)) this.#lists.delete(key);
      for (const key of this.#branches.keys()) if (key.startsWith(`${repository}\n`)) this.#branches.delete(key);
    }
    // Forgejo, GitLab and local repositories have no GitHub PR to query.
    const target = discoveryRepository(await this.#remote(thread, root, repository));
    if (!target || Date.now() < this.#ghUnavailableUntil) return null;
    const list = await this.#gh(refresh, () => this.#list(thread, root, repository, target));
    if (list === null) return null;
    const found = displayCandidate(list.heads.get(branch) ?? []);
    // A full page may have left an older pull request out: that branch alone is asked for.
    if (found || list.count < LIST_LIMIT) return found;
    return this.#gh(refresh, () => this.#shared(this.#branches, `${repository}\n${target}\n${branch}`, LIST_TTL_MS, async ownerSignal => {
      const raw = await this.#run(thread, root, 'gh', ['pr', 'list', '--repo', target, '--head', branch, '--state', 'all', '--limit', String(LIST_LIMIT), '--json', PROOF_FIELDS], ownerSignal);
      const values = pullRequestArray(raw);
      const found = displayCandidate(values);
      if (found && !found.url.toLowerCase().startsWith(`https://${target}/pull/`)) throw refused(`gh pull request URLs must belong to ${target}`);
      return found;
    }));
  }

  /**
   * A gh call, or null once gh turned out missing or signed out. A user's
   * refresh gets the reason instead: it is the only place to learn it.
   */
  async #gh<T>(refresh: boolean, call: () => Promise<T>): Promise<T | null> {
    try {
      return await call();
    } catch (error) {
      if (!unavailable(error)) throw error;
      this.#ghUnavailableUntil = Date.now() + 60_000;
      if (refresh) throw error;
      return null;
    }
  }

  /**
   * One load per key while it is fresh, shared by every concurrent caller.
   * A failure is kept fifteen seconds at most, so one transient error does not
   * hide a repository for its whole TTL. The load stops when every caller
   * that passed a signal canceled before it settled; a caller without a
   * signal keeps it alive.
   */
  #shared<T>(cache: Map<string, Shared<T>>, key: string, ttl: number, load: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    let entry = cache.get(key);
    if (!entry || entry.until <= Date.now()) {
      const controller = new AbortController();
      entry = { until: Date.now() + ttl, controller, consumers: 0, settled: false, kept: false, value: load(controller.signal) };
      const held = entry;
      void held.value.then(() => { held.settled = true; }, () => {
        held.settled = true;
        held.until = Math.min(held.until, Date.now() + FAILURE_TTL_MS);
      });
      cache.set(key, held);
      if (cache.size > 500) cache.delete(cache.keys().next().value!);
    }
    const held = entry;
    if (!signal) { held.kept = true; return held.value; }
    held.consumers++;
    return new Promise((resolve, reject) => {
      let finished = false;
      const finish = (): boolean => {
        if (finished) return false;
        finished = true;
        signal.removeEventListener('abort', canceled);
        held.consumers--;
        return true;
      };
      const canceled = (): void => {
        if (!finish()) return;
        if (!held.consumers && !held.settled && !held.kept) {
          held.controller.abort();
          if (cache.get(key) === held) cache.delete(key);
        }
        reject(new Error('pull request lookup canceled'));
      };
      signal.addEventListener('abort', canceled, { once: true });
      held.value.then(value => { if (finish()) resolve(value); }, error => { if (finish()) reject(error); });
      if (signal.aborted) canceled();
    });
  }

  async #acquire(signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    if (this.#running < 2) this.#running++;
    else await new Promise<void>((resolve, reject) => {
      const waiting: WaitingLookup = {
        admit: () => { signal?.removeEventListener('abort', waiting.cancel); resolve(); },
        cancel: () => {
          const index = this.#queue.indexOf(waiting);
          if (index < 0) return;
          this.#queue.splice(index, 1);
          signal?.removeEventListener('abort', waiting.cancel);
          reject(new Error('pull request lookup canceled'));
        },
      };
      this.#queue.push(waiting);
      signal?.addEventListener('abort', waiting.cancel, { once: true });
    });
    return () => {
      const next = this.#queue.shift();
      if (next) next.admit();
      else this.#running--;
    };
  }

  async #run(thread: Pick<ThreadSummary, 'id'>, cwd: string, command: string, args: string[], signal?: AbortSignal): Promise<string> {
    const release = await this.#acquire(signal);
    const scope = `pull-request:${thread.id}:${++this.#sequence}`;
    try {
      signal?.throwIfAborted();
      const spawned = this.core.procs.spawn(scope, command, args, {
        cwd,
        // A lookup never writes the index back: the worktree cleanup reads its date as the last time an agent used git there.
        env: { GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }
      });
      const controller = new AbortController();
      const canceled = (): void => { controller.abort(new Error('pull request lookup canceled')); };
      signal?.addEventListener('abort', canceled, { once: true });
      const timeout = setTimeout(() => controller.abort(new Error(`${command} pull request lookup timed out after ${this.#timeoutMs / 1000} seconds`)), this.#timeoutMs);
      let stop!: () => void;
      const aborted = new Promise<never>((_resolve, reject) => {
        stop = () => {
          try { this.core.procs.killTree(scope); } catch { /* Settlement does not depend on native cleanup succeeding. */ }
          reject(controller.signal.reason);
        };
        controller.signal.addEventListener('abort', stop, { once: true });
      });
      if (signal?.aborted) canceled();
      try {
        const [stdout, stderr, code] = await Promise.race([Promise.all([
          readOutput(spawned.proc.stdout, this.#maxOutputBytes, `${command} stdout`, controller.signal),
          readOutput(spawned.proc.stderr, this.#maxOutputBytes, `${command} stderr`, controller.signal),
          spawned.exited,
        ]), aborted]);
        if (code !== 0) throw new Error(stderr.trim() || `${command} exited with ${code}`);
        return stdout;
      } catch (error) {
        controller.abort(error);
        throw error;
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', canceled);
        controller.signal.removeEventListener('abort', stop);
      }
    } finally {
      release();
    }
  }
}

async function readOutput(stream: ReadableStream<Uint8Array>, limit: number, field: string, signal: AbortSignal): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let complete = false;
  const canceled = (): void => {
    // Cancel only this lookup's read end. Its source's cleanup may itself be
    // delayed, so neither cancellation nor release waits on that promise.
    void reader.cancel(signal.reason).catch(() => undefined);
    reader.releaseLock();
  };
  signal.addEventListener('abort', canceled, { once: true });
  try {
    if (signal.aborted) canceled();
    signal.throwIfAborted();
    for (;;) {
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) { complete = true; return Buffer.concat(chunks, bytes).toString('utf8'); }
      bytes += value.byteLength;
      if (bytes > limit) throw new Error(`${field} exceeded ${limit} bytes; expected bounded pull request evidence`);
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener('abort', canceled);
    if (!complete) void reader.cancel(signal.reason).catch(() => undefined);
    reader.releaseLock();
  }
}

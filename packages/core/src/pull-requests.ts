import type { ThreadSummary } from '@boite/contracts';
import type { Core } from './core.ts';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { messageOf, refused } from './errors.ts';

type PullRequest = ThreadSummary['pullRequest'];

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

/** A repository's pull requests by head branch, the newest first when a branch has several, as gh lists them. */
export function parsePullRequestList(text: string): Map<string, NonNullable<PullRequest>> {
  const out = new Map<string, NonNullable<PullRequest>>();
  for (const value of pullRequestArray(text)) {
    const head = (value as { headRefName?: unknown } | null)?.headRefName;
    if (typeof head !== 'string' || head.length === 0) throw new Error('gh output must name each pull request\'s headRefName');
    if (!out.has(head)) out.set(head, toPullRequest(value));
  }
  return out;
}

/** Pull requests one `gh pr list` call brings back for a repository. */
export const LIST_LIMIT = 200;
const LIST_TTL_MS = 60_000;
/** A repository's remotes rarely change: they are read once per five minutes. */
const REMOTES_TTL_MS = 5 * 60_000;
const TIMEOUT_MS = 10_000;

type Cached<T> = { until: number; value: Promise<T> };

/** gh is not installed, or not signed in: nothing a background lookup can fix. */
function unavailable(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  const message = messageOf(error);
  return code === 'ENOENT' || /not found in \$?PATH|gh auth login|not logged in/i.test(message);
}

/**
 * The pull request of each thread's branch, answered from one `gh pr list` per
 * repository: forty threads of one checkout make one gh call, not forty.
 * Every process runs two at a time at most, and stops after ten seconds.
 * Results and failures are kept a minute; `refresh` drops what is kept for
 * that repository and tries a missing gh again.
 */
export class PullRequests {
  #remotes = new Map<string, Cached<boolean>>();
  #lists = new Map<string, Cached<Map<string, NonNullable<PullRequest>>>>();
  #heads = new Map<string, Cached<string>>();
  #branches = new Map<string, Cached<PullRequest>>();
  /** Why gh cannot answer, once it said so; automatic lookups then spawn nothing. */
  #ghUnavailable: string | null = null;
  #running = 0;
  #queue: (() => void)[] = [];
  constructor(private core: Core) {}

  read(threadId: string, refresh = false): Promise<PullRequest> {
    const thread = this.core.threads.require(threadId);
    return this.#read(thread, refresh).catch((error: unknown) => {
      throw refused(`pull request for ${thread.cwd}: ${messageOf(error)}`);
    });
  }

  async #read(thread: ThreadSummary, refresh: boolean): Promise<PullRequest> {
    let root = thread.cwd;
    while (!existsSync(join(root, '.git'))) {
      const parent = dirname(root);
      if (parent === root) return null;
      root = parent;
    }
    if (refresh) {
      this.#ghUnavailable = null;
      this.#remotes.delete(root);
      this.#lists.delete(root);
      this.#heads.delete(thread.cwd);
      for (const key of this.#branches.keys()) if (key.startsWith(`${root}\n`)) this.#branches.delete(key);
    }
    // Forgejo, GitLab and local repositories have no GitHub PR to query.
    const github = await this.#cached(this.#remotes, root, REMOTES_TTL_MS, async () => hasGitHubRemote(await this.#run(thread, root, 'git', ['remote', '-v'])));
    if (!github) return null;
    const branch = thread.branch ?? (await this.#cached(this.#heads, thread.cwd, LIST_TTL_MS, async () => (await this.#run(thread, thread.cwd, 'git', ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()));
    if (branch === 'HEAD') return null;
    if (this.#ghUnavailable !== null) return null;
    const list = await this.#gh(() => this.#cached(this.#lists, root, LIST_TTL_MS, async () => parsePullRequestList(
      await this.#run(thread, root, 'gh', ['pr', 'list', '--state', 'all', '--limit', String(LIST_LIMIT), '--json', 'headRefName,number,url,state']),
    )));
    if (list === null) return null;
    const found = list.get(branch);
    // A full page may have left an older pull request out: that branch alone is asked for.
    if (found !== undefined || list.size < LIST_LIMIT) return found ?? null;
    return this.#gh(() => this.#cached(this.#branches, `${root}\n${branch}`, LIST_TTL_MS, async () => parsePullRequests(
      await this.#run(thread, root, 'gh', ['pr', 'list', '--head', branch, '--state', 'all', '--limit', '1', '--json', 'number,url,state']),
    )));
  }

  /** A gh call, or null once gh turned out missing or signed out. */
  async #gh<T>(call: () => Promise<T>): Promise<T | null> {
    try {
      return await call();
    } catch (error) {
      if (!unavailable(error)) throw error;
      this.#ghUnavailable = messageOf(error);
      return null;
    }
  }

  #cached<T>(cache: Map<string, Cached<T>>, key: string, ttl: number, load: () => Promise<T>): Promise<T> {
    const held = cache.get(key);
    if (held && held.until > Date.now()) return held.value;
    const value = load();
    cache.set(key, { until: Date.now() + ttl, value });
    if (cache.size > 500) cache.delete(cache.keys().next().value!);
    return value;
  }

  async #run(thread: ThreadSummary, cwd: string, command: string, args: string[]): Promise<string> {
    if (this.#running >= 2) await new Promise<void>((resolve) => this.#queue.push(resolve));
    else this.#running++;
    const scope = `pull-request:${thread.id}`;
    try {
      const spawned = this.core.procs.spawn(scope, command, args, {
        cwd,
        env: { GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' }
      });
      let expired = false;
      const timeout = setTimeout(() => {
        expired = true;
        this.core.procs.killTree(scope);
      }, TIMEOUT_MS);
      try {
        const [stdout, stderr, code] = await Promise.all([
          new Response(spawned.proc.stdout).text(),
          new Response(spawned.proc.stderr).text(),
          spawned.exited
        ]);
        if (expired) throw new Error(`${command} pull request lookup timed out after 10 seconds`);
        if (code !== 0) throw new Error(stderr.trim() || `${command} exited with ${code}`);
        return stdout;
      } finally {
        clearTimeout(timeout);
      }
    } finally {
      const next = this.#queue.shift();
      if (next) next();
      else this.#running--;
    }
  }
}

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
    let remoteHost: string;
    try { remoteHost = new URL(url).hostname; }
    catch { remoteHost = url.match(/^(?:[^@/\s]+@)?([^:/\s]+):/)?.[1] ?? ''; }
    return remoteHost.toLowerCase() === host.toLowerCase();
  });
}

export function parsePullRequests(text: string): PullRequest {
  const values: unknown = JSON.parse(text);
  if (!Array.isArray(values)) throw new Error('gh output must be a pull request array');
  if (values.length === 0) return null;
  const item = values[0] as Record<string, unknown> | undefined;
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

/** Two reads at most, coalesced and cached per thread, including failures. */
export class PullRequests {
  #cache = new Map<string, { until: number; result: Promise<PullRequest> }>();
  #running = 0;
  #queue: (() => void)[] = [];
  constructor(private core: Core) {}
  read(threadId: string): Promise<PullRequest> {
    const thread = this.core.threads.require(threadId);
    const existing = this.#cache.get(threadId);
    if (existing && existing.until > Date.now()) return existing.result;
    const result = this.#read(thread);
    this.#cache.set(threadId, { until: Date.now() + 60_000, result });
    if (this.#cache.size > 500) this.#cache.delete(this.#cache.keys().next().value!);
    return result;
  }
  async #read(thread: ThreadSummary): Promise<PullRequest> {
    if (this.#running >= 2) await new Promise<void>((resolve) => this.#queue.push(resolve));
    else this.#running++;
    try {
      let folder = thread.cwd;
      while (!existsSync(join(folder, '.git'))) {
        const parent = dirname(folder);
        if (parent === folder) return null;
        folder = parent;
      }
      // Forgejo, GitLab and local repositories have no GitHub PR to query.
      if (!hasGitHubRemote(await this.#run(thread, 'git', ['remote', '-v']))) return null;
      const branch = thread.branch ?? (await this.#run(thread, 'git', ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
      if (branch === 'HEAD') return null;
      return parsePullRequests(
        await this.#run(thread, 'gh', [
          'pr',
          'list',
          '--head',
          branch,
          '--state',
          'all',
          '--limit',
          '1',
          '--json',
          'number,url,state'
        ])
      );
    } catch (error) {
      throw refused(`pull request for ${thread.cwd}: ${messageOf(error)}`);
    } finally {
      const next = this.#queue.shift();
      if (next) next();
      else this.#running--;
    }
  }

  async #run(thread: ThreadSummary, command: string, args: string[]): Promise<string> {
    const scope = `pull-request:${thread.id}`;
    const spawned = this.core.procs.spawn(scope, command, args, {
      cwd: thread.cwd,
      env: { GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' }
    });
    let expired = false;
    const timeout = setTimeout(() => {
      expired = true;
      this.core.procs.killTree(scope);
    }, 10_000);
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
  }
}

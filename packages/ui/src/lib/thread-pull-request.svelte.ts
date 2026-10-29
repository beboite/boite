import { untrack } from 'svelte';
import { threadActive, type LinkedPullRequest, type ThreadSummary } from '@boite/contracts';
import type { Store } from './store.svelte';
import { errorText } from './errors';
import { strings } from './strings';
import { knownPullRequest, lookupPullRequest, PULL_REQUEST_POLL_MS, rememberPullRequest, watchPullRequests, WORKING_PULL_REQUEST_POLL_MS } from './pull-request';

type PullRequest = ThreadSummary['pullRequest'];
const summary = (pr: NonNullable<PullRequest>): NonNullable<PullRequest> => ({ number: pr.number, url: pr.url, state: pr.state });
const selected = (links: LinkedPullRequest[]): PullRequest => {
  const pr = links.findLast(pr => pr.state === 'OPEN') ?? links.at(-1);
  return pr ? summary(pr) : null;
};

/** One checkout's badge lifecycle, shared by desktop cards and phone rows. */
export function trackThreadPullRequest(input: () => { owner: Store; thread: ThreadSummary; hidden?: boolean }) {
  let value = $state<PullRequest>(null);
  let loading = $state(false);
  let revision = 0;
  let linkSignature: string | undefined;
  let links: LinkedPullRequest[] = [];
  let recheck = false;

  async function refresh(manual = false) {
    const { owner, thread, hidden } = input();
    const client = owner.client;
    if (!client || loading || (!manual && (hidden || owner.connection !== 'ready' || document.hidden))) return;
    const requestedRevision = revision;
    const checkout = JSON.stringify([thread.cwd, thread.branch]);
    const key = owner.threadKey(thread.id) + checkout;
    recheck = false;
    loading = true;
    try {
      const result = await lookupPullRequest(client, thread.id, manual, checkout);
      if (requestedRevision !== revision || recheck) return;
      let next = result.supported ? result.pullRequest : null;
      // A merge cannot reopen. A watch event wins over an older cached answer,
      // including URLs whose owner/repository casing differs from GitHub's.
      const merged = next && links.find(pr => pr.state === 'MERGED' && pr.url.toLowerCase() === next?.url.toLowerCase());
      if (merged) next = summary(merged);
      rememberPullRequest(key, next);
      value = next;
      if (!result.supported && manual) owner.error = strings.errors.pullRequestUnsupported;
    } catch (error) {
      if (requestedRevision === revision && manual) owner.error = errorText(error);
    } finally {
      if (requestedRevision === revision) {
        loading = false;
        // Unlink must wait for the previous deduplicated lookup to settle.
        if (recheck) void refresh();
      }
    }
  }

  $effect(() => {
    const { owner, thread, hidden } = input();
    const identity = { client: owner.client, id: thread.id, cwd: thread.cwd, branch: thread.branch };
    const ready = owner.connection === 'ready' && !hidden;
    const key = owner.threadKey(identity.id) + JSON.stringify([identity.cwd, identity.branch]);
    untrack(() => {
      value = knownPullRequest(key);
      loading = false;
      links = [];
      linkSignature = undefined;
      recheck = false;
      if (ready && identity.client) void refresh();
    });
    return () => { revision++; };
  });
  $effect(() => {
    const { owner, thread, hidden } = input();
    const client = owner.client;
    if (!client || owner.connection !== 'ready' || hidden) return;
    return watchPullRequests(client, () => void refresh(), threadActive(thread.status) ? WORKING_PULL_REQUEST_POLL_MS : PULL_REQUEST_POLL_MS);
  });
  $effect(() => {
    const { owner, thread, hidden } = input();
    const client = owner.client;
    const threadId = thread.id;
    if (!client || hidden) return;
    return client.on('threads.pullRequestsChanged', event => {
      if (event.threadId !== threadId) return;
      const signature = JSON.stringify(event.pullRequests.map(pr => [pr.url.toLowerCase(), pr.state]));
      // list refreshes also emit events. Identical state must not invalidate
      // every RPC that goes on to discover a new automatic PR.
      if (signature === linkSignature) return;
      linkSignature = signature;
      links = event.pullRequests;
      value = selected(links);
      rememberPullRequest(owner.threadKey(threadId) + JSON.stringify([thread.cwd, thread.branch]), value);
      // An event can remove just one of several links. Wait for the old
      // deduplicated lookup, then read the current membership once more.
      if (loading) recheck = true;
      else if (!links.length) void refresh();
    });
  });
  $effect(() => {
    const status = input().thread.status;
    untrack(() => { void status; void refresh(); });
  });
  return { get value() { return value; }, get loading() { return loading; }, refresh };
}

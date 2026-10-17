import { RpcErrorCode, type ThreadId, type ThreadSummary } from '@boite/contracts';
import { RpcFailure, type Client } from './client';

type Lookup = { supported: false } | { supported: true; pullRequest: ThreadSummary['pullRequest'] };
// Probe once per connection, including when several sidebar rows mount together.
const support = new WeakMap<Client, Promise<boolean>>();
interface Lookups {
  active: number;
  waiting: (() => void)[];
  pending: Map<string, Promise<Lookup>>;
}
const lookups = new WeakMap<Client, Lookups>();
const MAX_LOOKUPS = 4;

/**
 * The last answer for each checkout of each thread, kept for the page's life. A
 * card that mounts again, or whose machine reconnects, draws it at once and
 * asks again behind it, rather than dropping its line until the core answers.
 */
const known = new Map<string, ThreadSummary['pullRequest']>();

export function knownPullRequest(key: string): ThreadSummary['pullRequest'] {
  return known.get(key) ?? null;
}

export function rememberPullRequest(key: string, pullRequest: ThreadSummary['pullRequest']): void {
  known.delete(key);
  if (pullRequest) known.set(key, pullRequest);
  while (known.size > 500) known.delete(known.keys().next().value!);
}

/**
 * How often the sidebar asks again about a thread at rest. Above the core's 15 s
 * cache of a repository's pull requests, so each round runs `gh` at most once
 * per repository.
 */
export const PULL_REQUEST_POLL_MS = 60_000;
/** A thread at work can open its pull request any moment: it keeps the core's own cadence. */
export const WORKING_PULL_REQUEST_POLL_MS = 15_000;

interface Poller {
  every: number;
  watchers: Set<() => void>;
  timer?: ReturnType<typeof setTimeout>;
  /** When the last round ran, or when the first card mounted and looked up on its own. */
  last: number;
}
/** One timer per connection and cadence, whatever the number of cards on screen. */
const pollers = new Map<Client, Map<number, Poller>>();
let listening = false;

function schedule(poller: Poller): void {
  if (poller.timer !== undefined || document.hidden || !poller.watchers.size) return;
  poller.timer = setTimeout(() => round(poller), Math.max(0, poller.last + poller.every - Date.now()));
}

function round(poller: Poller): void {
  poller.timer = undefined;
  if (document.hidden) return;
  poller.last = Date.now();
  for (const watcher of [...poller.watchers]) watcher();
  schedule(poller);
}

/** A hidden page asks nothing; back in view, it asks once for every card if a round is due, then resumes the cadence. */
function visibilityChanged(): void {
  for (const lanes of pollers.values()) {
    for (const poller of lanes.values()) {
      if (document.hidden) { clearTimeout(poller.timer); poller.timer = undefined; }
      else if (poller.timer === undefined) {
        if (Date.now() - poller.last >= poller.every) round(poller);
        else schedule(poller);
      }
    }
  }
}

/**
 * Asks `poll` again every round of this connection's shared timer for that
 * cadence, until the returned function is called. The card looks up on its own
 * when it mounts.
 */
export function watchPullRequests(client: Client, poll: () => void, every = PULL_REQUEST_POLL_MS): () => void {
  if (!listening) { document.addEventListener('visibilitychange', visibilityChanged); listening = true; }
  let lanes = pollers.get(client);
  if (!lanes) { lanes = new Map(); pollers.set(client, lanes); }
  let poller = lanes.get(every);
  if (!poller) { poller = { every, watchers: new Set(), last: Date.now() }; lanes.set(every, poller); }
  const own = poller, ownLanes = lanes;
  own.watchers.add(poll);
  schedule(own);
  return () => {
    own.watchers.delete(poll);
    if (own.watchers.size) return;
    clearTimeout(own.timer);
    if (ownLanes.get(every) === own) ownLanes.delete(every);
    if (!ownLanes.size && pollers.get(client) === ownLanes) pollers.delete(client);
  };
}

export function resetPullRequestSupport(client: Client): void {
  support.delete(client);
}

/** `refresh` is a user's own request: the core reads the repository again instead of answering from what it kept. */
export async function lookupPullRequest(client: Client, threadId: ThreadId, refresh = false, checkout = ''): Promise<Lookup> {
  let state = lookups.get(client);
  if (!state) {
    state = { active: 0, waiting: [], pending: new Map() };
    lookups.set(client, state);
  }
  // A moved thread must not share an outstanding read for its previous checkout.
  const key = JSON.stringify([threadId, refresh, checkout]);
  const pending = state.pending.get(key);
  if (pending) return pending;
  // A sidebar remount shares its lookup; metadata leaves room for interactive RPCs.
  const request = limitedLookup(state, refresh, () => readPullRequest(client, threadId, refresh))
    .finally(() => state.pending.delete(key));
  state.pending.set(key, request);
  return request;
}

async function limitedLookup(state: Lookups, refresh: boolean, read: () => Promise<Lookup>): Promise<Lookup> {
  if (state.active < MAX_LOOKUPS) state.active++;
  else await new Promise<void>(resolve => {
    // An explicit refresh goes ahead of the background sidebar backlog.
    if (refresh) state.waiting.unshift(resolve);
    else state.waiting.push(resolve);
  });
  try { return await read(); }
  finally {
    const next = state.waiting.shift();
    if (next) next(); // Transfer the slot directly, so a new call cannot steal it.
    else state.active--;
  }
}

async function readPullRequest(client: Client, threadId: ThreadId, refresh: boolean): Promise<Lookup> {
  const known = support.get(client);
  if (known && !(await known)) return { supported: false };
  const request = client.call('threads.pullRequest', refresh ? { threadId, refresh } : { threadId });
  if (!known) {
    support.set(client, request.then(() => true, (error: unknown) => {
      if (error instanceof RpcFailure && error.code === RpcErrorCode.MethodNotFound) return false;
      support.delete(client);
      return true;
    }));
  }
  try {
    return { supported: true, pullRequest: await request };
  } catch (error) {
    if (error instanceof RpcFailure && error.code === RpcErrorCode.MethodNotFound) {
      support.set(client, Promise.resolve(false));
      return { supported: false };
    }
    throw error;
  }
}

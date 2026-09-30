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

export function resetPullRequestSupport(client: Client): void {
  support.delete(client);
}

/** `refresh` is a user's own request: the core reads the repository again instead of answering from what it kept. */
export async function lookupPullRequest(client: Client, threadId: ThreadId, refresh = false): Promise<Lookup> {
  let state = lookups.get(client);
  if (!state) {
    state = { active: 0, waiting: [], pending: new Map() };
    lookups.set(client, state);
  }
  const key = `${threadId}|${refresh}`;
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

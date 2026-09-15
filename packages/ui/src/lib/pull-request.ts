import { RpcErrorCode, type ThreadId, type ThreadSummary } from '@boite/contracts';
import { RpcFailure, type Client } from './client';

type Lookup = { supported: false } | { supported: true; pullRequest: ThreadSummary['pullRequest'] };
// Probe once per connection, including when several sidebar rows mount together.
const support = new WeakMap<Client, Promise<boolean>>();

export function resetPullRequestSupport(client: Client): void {
  support.delete(client);
}

export async function lookupPullRequest(client: Client, threadId: ThreadId): Promise<Lookup> {
  const known = support.get(client);
  if (known && !(await known)) return { supported: false };
  const request = client.call('threads.pullRequest', { threadId });
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

import type { Store } from './store.svelte';

type Client = NonNullable<Store['client']>;

/**
 * Subscriptions held for a thread nobody opens, as a sign-in card on the
 * Agents page needs to show that thread's browser. The core keeps one
 * subscription per connection and thread, not a count: several cards on one
 * thread share it, and only the last to leave lets it go.
 */
const held = new WeakMap<Client, Map<string, { count: number; ready: Promise<unknown> }>>();

/**
 * Subscribes `client` to `threadId` unless a holder already did. The returned
 * release runs once; the last one unsubscribes, after the subscription
 * landed, unless `keep` says the thread is wanted elsewhere (open in the chat).
 */
export function holdThread(client: Client, threadId: string, keep: () => boolean): { ready: Promise<unknown>; release: () => void } {
  let threads = held.get(client);
  if (!threads) held.set(client, (threads = new Map()));
  let entry = threads.get(threadId);
  if (!entry) {
    const fresh = { count: 0, ready: client.call('threads.subscribe', { threadId }) };
    // A refused subscription is not shared: the next holder asks again.
    fresh.ready.catch(() => { if (threads.get(threadId) === fresh) threads.delete(threadId); });
    threads.set(threadId, (entry = fresh));
  }
  entry.count += 1;
  const mine = entry;
  let released = false;
  return {
    ready: mine.ready,
    release: () => {
      if (released) return;
      released = true;
      mine.count -= 1;
      if (mine.count > 0) return;
      threads.delete(threadId);
      void mine.ready.then(
        () => { if (!keep() && threads.get(threadId) === undefined) return client.call('threads.unsubscribe', { threadId }); },
        () => undefined
      ).catch(() => undefined);
    }
  };
}

import { expect, test, vi } from 'vitest';
import { FakeClient } from './fake-client';
import { Store } from './store.svelte';

async function ready(): Promise<{ store: Store; client: FakeClient; asked: () => string[]; pages: (threadId: string) => Record<string, unknown>[]; landed: (threadId: string) => Promise<unknown> }> {
  const client = new FakeClient({ delayMs: 0, delegationDemo: true });
  const store = new Store();
  store.attach(client);
  await store.connect();
  await store.open('t-trace');
  const spy = vi.spyOn(client, 'call');
  const asked = () => spy.mock.calls
    .filter(([method]) => method.startsWith('threads.'))
    .map(([method, params]) => `${method} ${(params as { threadId?: string }).threadId ?? ''}`);
  // The pages the store asked for: its reads carry a limit, the test's own do not.
  const pages = (threadId: string) => spy.mock.calls
    .filter(([method, params]) => method === 'threads.get' && (params as { threadId: string; limit?: number }).threadId === threadId && (params as { limit?: number }).limit !== undefined)
    .map(([, params]) => params as Record<string, unknown>);
  // Settled once the store's last page of the thread answered or failed.
  const landed = (threadId: string) => {
    const index = spy.mock.calls.findLastIndex(([method, params]) => method === 'threads.get' && (params as { threadId: string; limit?: number }).threadId === threadId && (params as { limit?: number }).limit !== undefined);
    return Promise.resolve(spy.mock.results[index]?.value).catch(() => undefined);
  };
  return { store, client, asked, pages, landed };
}

test('the click takes over the press: no second subscribe or page, and what streamed in between is on screen', async () => {
  const { store, client, asked, pages } = await ready();
  try {
    store.preload('t-descriptors');
    await vi.waitFor(() => expect(client.coreSubscribers).toContain('t-descriptors'));
    await client.call('threads.get', { threadId: 't-descriptors' });
    // A turn that streams after the press's page landed and before the click:
    // its events reach the page the click will show, not a thread nobody holds.
    await client.call('turns.start', { threadId: 't-descriptors', prompt: 'while the button is down' });
    await client.settled();
    await store.open('t-descriptors');

    const fresh = await client.call('threads.get', { threadId: 't-descriptors' });
    expect(store.openThread?.id).toBe('t-descriptors');
    expect(store.openThread?.messages.map(message => [message.id, JSON.stringify(message.parts)])).toEqual(fresh.messages.map(message => [message.id, JSON.stringify(message.parts)]));
    expect(store.openThread?.turns.at(-1)?.status).toBe(fresh.turns.at(-1)?.status);
    // One page and one subscription, both from the press. The press neither
    // left the open thread nor marked anything read; the open did, after it.
    expect(pages('t-descriptors')).toHaveLength(1);
    // The fake bundles snapshots like the core: the press subscribes through its page.
    expect(pages('t-descriptors')[0]!.open).toEqual({ requests: false });
    expect(asked()).toContain('threads.unsubscribe t-trace');
    expect(client.coreSubscribers).toEqual(['t-descriptors']);
  } finally { store.detach(); client.close(); }
});

test('a press that never becomes a click gives its subscription back, and never one something else holds', async () => {
  const { store, client, asked, landed, pages } = await ready();
  try {
    const release = store.preload('t-descriptors');
    await vi.waitFor(() => expect(client.coreSubscribers).toContain('t-descriptors'));
    release();
    await vi.waitFor(() => expect(client.coreSubscribers).not.toContain('t-descriptors'));
    expect(store.openThread?.id).toBe('t-trace');

    // The open thread is live already: a press on it asks for nothing.
    const before = asked().length;
    store.preload('t-trace')();
    expect(asked().length).toBe(before);
    expect(client.coreSubscribers).toContain('t-trace');

    // The agent shown in the panel keeps its subscription when a press on it is released.
    await store.loadDelegation('t-trace');
    await store.selectDelegatedAgent('t-team-running');
    const child = store.preload('t-team-running');
    // Released only once its page answered, so a wrong give-back would have been sent by now.
    // The panel's own read subscribes nothing: the one page that opens is the press's.
    expect(pages('t-team-running').filter(page => page.open)).toHaveLength(1);
    await landed('t-team-running');
    child();
    for (let tick = 0; tick < 3; tick++) await new Promise(resolve => setTimeout(resolve, 0));
    expect(asked()).not.toContain('threads.unsubscribe t-team-running');
    expect(client.coreSubscribers).toContain('t-team-running');
  } finally { store.detach(); client.close(); }
});

test('leaving the panel agent for its own thread keeps the subscription the press is about to hand over', async () => {
  const { store, client } = await ready();
  try {
    await store.loadDelegation('t-trace');
    await store.selectDelegatedAgent('t-team-running');
    store.preload('t-team-running');
    await vi.waitFor(() => expect(client.coreSubscribers).toContain('t-team-running'));
    // DelegationSurface's "open thread": the panel lets go of the agent, then the thread opens.
    await store.selectDelegatedAgent(null);
    await store.open('t-team-running');
    expect(store.openThread?.id).toBe('t-team-running');
    expect(client.coreSubscribers).toEqual(['t-team-running']);
  } finally { store.detach(); client.close(); }
});

test('a newer press releases the older one', async () => {
  const { store, client } = await ready();
  try {
    store.preload('t-descriptors');
    await vi.waitFor(() => expect(client.coreSubscribers).toContain('t-descriptors'));
    store.preload('t-scheduler');
    await vi.waitFor(() => expect(client.coreSubscribers).not.toContain('t-descriptors'));
    await store.open('t-scheduler');
    expect(store.error).toBeNull();
    expect(store.openThread?.id).toBe('t-scheduler');
    expect(client.coreSubscribers.sort()).toEqual(['t-scheduler']);
  } finally { store.detach(); client.close(); }
});

test('a press whose page was refused leaves the click to ask again instead of failing', async () => {
  const { store, client, pages } = await ready();
  try {
    // The spy `ready` put on the instance stays: this one answers through the prototype.
    const real = (method: never, params: never) => FakeClient.prototype.call.call(client, method, params);
    let refuse = true;
    vi.spyOn(client, 'call').mockImplementation(((method: string, params: { threadId?: string; limit?: number }) => {
      if (refuse && method === 'threads.get' && params.threadId === 't-descriptors' && params.limit !== undefined) {
        refuse = false;
        return Promise.reject(new Error('link dropped during the press'));
      }
      return real(method as never, params as never);
    }) as typeof client.call);
    store.preload('t-descriptors');
    await vi.waitFor(() => expect(refuse).toBe(false));
    await new Promise(resolve => setTimeout(resolve, 0));
    await store.open('t-descriptors');
    expect(store.error).toBeNull();
    expect(store.openThread?.id).toBe('t-descriptors');
    expect(store.openThread?.messages.length).toBeGreaterThan(0);
    expect(pages('t-descriptors')).toHaveLength(2);
    expect(client.coreSubscribers).toEqual(['t-descriptors']);
  } finally { store.detach(); client.close(); }
});

import { expect, test, vi } from 'vitest';
import { RpcFailure } from './client';
import { FakeClient } from './fake-client';
import { Store } from './store.svelte';

/** Holds every call to `method` (on `threadId` when given) until the test settles it; the rest go to the fake core. */
function hold(client: FakeClient, method: string, threadId?: string) {
  // A second hold reuses the spy; capture its implementation before replacing it.
  const implementation = vi.isMockFunction(client.call)
    ? vi.mocked(client.call).getMockImplementation() ?? client.call
    : client.call;
  const real = implementation.bind(client);
  const held: { params: Record<string, unknown>; resolve: (value: unknown) => void; reject: (error: unknown) => void; real: () => void }[] = [];
  const spy = vi.spyOn(client, 'call').mockImplementation(((name: string, params: Record<string, unknown>) => {
    if (name !== method || (threadId !== undefined && params.threadId !== threadId)) return real(name as never, params as never);
    return new Promise<unknown>((resolve, reject) => {
      held.push({ params, resolve, reject, real: () => { real(name as never, params as never).then(resolve, reject); } });
    });
  }) as typeof client.call);
  return { held, spy };
}

const refused = (): RpcFailure => new RpcFailure({ code: -32000, message: 'refused by the test' });

async function ready(delegationDemo = false): Promise<{ store: Store; client: FakeClient }> {
  const client = new FakeClient({ delayMs: 0, delegationDemo });
  const store = new Store();
  store.attach(client);
  await store.connect();
  return { store, client };
}

test('an archived row leaves the list before the core answers, and a refusal brings it back in place', async () => {
  const { store, client } = await ready();
  try {
    const thread = store.threads.find((t) => t.status === 'idle' && !t.parentThreadId && !t.archived)!;
    const project = thread.projectId!;
    const before = store.threadsOf(project).map((t) => t.id);
    const { held } = hold(client, 'threads.archive');
    const archiving = store.archive(thread.id);
    await vi.waitFor(() => expect(held).toHaveLength(1));
    expect(store.threadsOf(project).map((t) => t.id)).not.toContain(thread.id);
    // A change the core announces before it takes the archive must not show the row again.
    await client.call('threads.update', { threadId: thread.id, title: 'renamed meanwhile' });
    await vi.waitFor(() => expect(store.threads.find((t) => t.id === thread.id)?.title).toBe('renamed meanwhile'));
    expect(store.threadsOf(project).map((t) => t.id)).not.toContain(thread.id);
    held[0]!.reject(refused());
    await archiving;
    expect(store.threadsOf(project).map((t) => t.id)).toEqual(before);
    expect(store.threads.find((t) => t.id === thread.id)?.archived).toBe(false);
    expect(store.error).toContain('refused by the test');
  } finally { store.detach(); client.close(); }
});

test('an archive another client made while ours was out stays hidden when ours is refused', async () => {
  const { store, client } = await ready();
  try {
    const thread = store.threads.find((t) => t.status === 'idle' && !t.parentThreadId && !t.archived)!;
    const { held } = hold(client, 'threads.archive');
    const archiving = store.archive(thread.id);
    await vi.waitFor(() => expect(held).toHaveLength(1));
    // The other client's archive reaches the fake core past the held call, and its event this store.
    await FakeClient.prototype.call.call(client, 'threads.archive', { threadId: thread.id, archived: true });
    held[0]!.reject(refused());
    await archiving;
    expect(store.threadsOf(thread.projectId!).map((t) => t.id)).not.toContain(thread.id);
  } finally { store.detach(); client.close(); }
});

test('a pin shows before the core answers and is taken back on a refusal', async () => {
  const { store, client } = await ready();
  try {
    await store.open('t-trace');
    const { held } = hold(client, 'threads.pin');
    const pinning = store.pin('t-trace', true);
    expect(store.threads.find((t) => t.id === 't-trace')?.pinned).toBe(true);
    expect(store.openThread?.pinned).toBe(true);
    held[0]!.reject(refused());
    await pinning;
    expect(store.threads.find((t) => t.id === 't-trace')?.pinned).toBe(false);
    expect(store.openThread?.pinned).toBe(false);
    expect(store.error).toContain('refused by the test');
  } finally { store.detach(); client.close(); }
});

test('a refused pin goes back to a pin another client made since the last one', async () => {
  const { store, client } = await ready();
  try {
    await store.open('t-trace');
    await store.pin('t-trace', true);
    await FakeClient.prototype.call.call(client, 'threads.pin', { threadId: 't-trace', pinned: false });
    await vi.waitFor(() => expect(store.threads.find((t) => t.id === 't-trace')?.pinned).toBe(false));
    const { held } = hold(client, 'threads.pin');
    const pinning = store.pin('t-trace', true);
    held[0]!.reject(refused());
    await pinning.catch(() => undefined);
    expect(store.threads.find((t) => t.id === 't-trace')?.pinned).toBe(false);
  } finally { store.detach(); client.close(); }
});

test('pin then unpin, both refused in their order, ends where it started', async () => {
  const { store, client } = await ready();
  try {
    await store.open('t-trace');
    const { held } = hold(client, 'threads.pin');
    const pin = store.pin('t-trace', true);
    const unpin = store.pin('t-trace', false);
    expect(store.threads.find((t) => t.id === 't-trace')?.pinned).toBe(false);
    // The core takes them in tap order: the unpin leaves once the pin is answered.
    expect(held).toHaveLength(1);
    held[0]!.reject(refused());
    await pin;
    await vi.waitFor(() => expect(held).toHaveLength(2));
    expect(held[1]!.params).toMatchObject({ pinned: false });
    held[1]!.reject(refused());
    await unpin;
    expect(store.threads.find((t) => t.id === 't-trace')?.pinned).toBe(false);
    expect(store.openThread?.pinned).toBe(false);
  } finally { store.detach(); client.close(); }
});

test('a second answer to a permission while the first is out sends nothing, and a refusal allows another try', async () => {
  const { store, client } = await ready();
  try {
    const { held } = hold(client, 'permissions.answer');
    const first = store.answer('perm-held', 'allow');
    const second = store.answer('perm-held', 'deny');
    expect(held).toHaveLength(1);
    held[0]!.reject(refused());
    expect(await first).toBe(false);
    expect(await second).toBe(false);
    const third = store.answer('perm-held', 'allow');
    expect(held).toHaveLength(2);
    expect(held[1]!.params).toEqual({ requestId: 'perm-held', decision: 'allow' });
    held[1]!.resolve({ ok: true });
    expect(await third).toBe(true);
  } finally { store.detach(); client.close(); }
});

test('a permission answer that lands on a replaced connection gives the card its buttons back', async () => {
  const { store, client } = await ready();
  const next = new FakeClient({ delayMs: 0 });
  try {
    const { held } = hold(client, 'permissions.answer');
    const answered = store.answer('perm-held', 'allow');
    store.attach(next);
    held[0]!.resolve({ ok: true });
    expect(await answered).toBe(false);
  } finally { store.detach(); client.close(); next.close(); }
});

test('picking another agent reads it without waiting for the previous one to be let go', async () => {
  const { store, client } = await ready(true);
  try {
    await store.open('t-trace');
    await store.selectDelegatedAgent('t-team-running');
    const { held, spy } = hold(client, 'threads.unsubscribe');
    await store.selectDelegatedAgent('t-team-done');
    // The read landed while the unsubscribe of the previous agent is still out.
    expect(held.map((call) => call.params.threadId)).toEqual(['t-team-running']);
    expect(store.delegationThread?.id).toBe('t-team-done');
    const sent = spy.mock.calls.map(([method, params]) => `${method} ${(params as { threadId: string }).threadId}`);
    expect(sent).toEqual(['threads.unsubscribe t-team-running', 'threads.subscribe t-team-done', 'threads.get t-team-done']);
    for (const call of held) call.real();
  } finally { store.detach(); client.close(); }
});

test('opening another thread clears the agent selection without waiting on its unsubscribe', async () => {
  const { store, client } = await ready(true);
  try {
    await store.open('t-trace');
    await store.selectDelegatedAgent('t-team-running');
    const { held } = hold(client, 'threads.unsubscribe', 't-team-running');
    await store.open('t-descriptors');
    expect(store.openThread?.id).toBe('t-descriptors');
    expect(store.delegationSelectedAgentId).toBeNull();
    expect(held.map((call) => call.params.threadId)).toEqual(['t-team-running']);
    for (const call of held) call.real();
  } finally { store.detach(); client.close(); }
});

test('clearing the agent selection for an open of that agent keeps its subscription', async () => {
  const { store, client } = await ready(true);
  try {
    await store.open('t-trace');
    await store.selectDelegatedAgent('t-team-running');
    const called = vi.spyOn(client, 'call');
    void store.selectDelegatedAgent(null, 't-team-running');
    await store.open('t-team-running');
    expect(store.openThread?.id).toBe('t-team-running');
    expect(called).not.toHaveBeenCalledWith('threads.unsubscribe', { threadId: 't-team-running' });
  } finally { store.detach(); client.close(); }
});

test('an agent opened while its selection is still subscribing keeps its subscription', async () => {
  const { store, client } = await ready(true);
  try {
    await store.open('t-trace');
    const { held } = hold(client, 'threads.subscribe', 't-team-running');
    const selecting = store.selectDelegatedAgent('t-team-running');
    await vi.waitFor(() => expect(held).toHaveLength(1));
    // The open's own reads stay out too, so its subscription is not yet recorded.
    const reads = hold(client, 'threads.get', 't-team-running');
    void store.selectDelegatedAgent(null, 't-team-running');
    const opening = store.open('t-team-running');
    await vi.waitFor(() => expect(store.openThread?.id).toBe('t-team-running'));
    const sent: string[] = [];
    reads.spy.mockImplementation(((name: string, params: { threadId?: string }) => {
      sent.push(`${name} ${params.threadId}`);
      return FakeClient.prototype.call.call(client, name as never, params as never);
    }) as typeof client.call);
    held[0]!.real();
    await selecting;
    for (const call of [...held.slice(1), ...reads.held]) call.real();
    await opening;
    expect(sent).not.toContain('threads.unsubscribe t-team-running');
  } finally { store.detach(); client.close(); }
});

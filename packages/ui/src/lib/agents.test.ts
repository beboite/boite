import { expect, test, vi } from 'vitest';
import type { AgentEntities } from '@boite/contracts';
import { AgentsView } from './agents.svelte';
import { FakeAgents } from './fake-agents';
import type { Store } from './store.svelte';

test('an invalidation arriving as a snapshot completes still refreshes the view', async () => {
  const snapshot = new FakeAgents(() => {}).snapshot();
  let resolve!: (value: typeof snapshot) => void;
  const first = new Promise<typeof snapshot>(done => { resolve = done; });
  const call = vi.fn().mockReturnValueOnce(first).mockResolvedValue({ ...snapshot, revision: 2 });
  const store = { client: { call, on: () => () => {} } } as unknown as Store;
  const view = new AgentsView(store);
  try {
    const loading = view.refresh();
    resolve({ ...snapshot, revision: 1 });
    queueMicrotask(() => { void view.refresh(); });
    await loading;
    await expect.poll(() => view.snapshot?.revision).toBe(2);
  } finally { view.close(); }
});

test('background updates preserve a mutation error and a changed client gets a new subscription', async () => {
  const snapshot = new FakeAgents(() => {}).snapshot();
  const off = vi.fn();
  const first = { call: vi.fn().mockResolvedValue(snapshot), on: vi.fn(() => off) };
  const second = { call: vi.fn().mockResolvedValue({ ...snapshot, revision: 3 }), on: vi.fn(() => () => {}) };
  const source = { client: first as unknown as Store['client'] };
  const store = source as unknown as Store;
  const view = new AgentsView(store);
  try {
    await view.refresh();
    view.error = 'This change was refused';
    await view.refresh();
    expect(view.error).toBe('This change was refused');
    source.client = second as unknown as Store['client'];
    await view.refresh();
    expect(off).toHaveBeenCalledOnce();
    expect(second.on).toHaveBeenCalledWith('agents.changed', expect.any(Function));
    expect(view.snapshot?.revision).toBe(3);
  } finally { view.close(); }
});

test('older pages and records that left the snapshot window stay in seen, the later revision winning', async () => {
  const base = new FakeAgents(() => {}).snapshot();
  const scope = { kind: 'agent' as const, id: 'agent_1' };
  const message = (id: string, at: number, revision = 1): AgentEntities['message'] => ({ id, revision, createdAt: at, updatedAt: at, scope, senderId: null, text: id, recipientIds: [], replyTo: null, episodeId: id, sourceRunId: null });
  const empty = { messages: [], work: [], memories: [], deliveries: [], runs: [], decisions: [] };
  const call = vi.fn(async (method: string, params: { before?: { id: string } }) => {
    if (method === 'agents.history') {
      expect(params.before?.id).toBe('m2');
      return { ...empty, messages: [message('m1', 1)], more: false };
    }
    return call.mock.calls.filter(([m]) => m === 'agents.snapshot').length === 1
      ? { ...base, messages: [message('m2', 2), message('m3', 3)], more: { ...base.more, message: true } }
      : { ...base, revision: 2, messages: [message('m3', 3, 2), message('m4', 4)], more: { ...base.more, message: true } };
  });
  const view = new AgentsView({ client: { call, on: () => () => {} } } as unknown as Store);
  try {
    await view.refresh();
    expect(view.hasOlder('chat', 'message')).toBe(true);
    await view.loadOlder('chat', { kind: 'message', scopes: [scope] }, view.seen.messages);
    expect(view.hasOlder('chat', 'message')).toBe(false);
    await view.refresh();
    expect(view.seen.messages.map(m => `${m.id}@${m.revision}`)).toEqual(['m1@1', 'm2@1', 'm3@2', 'm4@1']);
    view.fill('chat', { kind: 'message', scopes: [scope] }, view.seen.messages);
    expect(call.mock.calls.filter(([m]) => m === 'agents.history')).toHaveLength(1);
  } finally { view.close(); }
});

test('old unfinished work does not move the work cursor past finished work', async () => {
  const base = new FakeAgents(() => {}).snapshot();
  const scope = { kind: 'agent' as const, id: 'agent_1' };
  const work = (id: string, at: number, status: AgentEntities['work']['status']): AgentEntities['work'] => ({ id, revision: 1, createdAt: at, updatedAt: at, agentId: 'agent_1', scope, taskId: null, taskGeneration: null, messageId: null, episodeId: id, prompt: id, status, error: null, runId: null, notBefore: 0 });
  const call = vi.fn(async (method: string, _params: unknown) => method === 'agents.history'
    ? { messages: [], work: [], memories: [], deliveries: [], runs: [], decisions: [], more: false }
    : { ...base, work: [work('stuck', 1, 'interrupted'), work('w50', 50, 'done'), work('w51', 51, 'done')], more: { ...base.more, work: true } });
  const view = new AgentsView({ client: { call, on: () => () => {} } } as unknown as Store);
  try {
    await view.refresh();
    await view.loadOlder('activity', { kind: 'work', agentId: 'agent_1' }, view.seen.work);
    expect(call.mock.calls.find(([m]) => m === 'agents.history')![1]).toMatchObject({ before: { updatedAt: 50, id: 'w50' } });
  } finally { view.close(); }
});

test('a snapshot that no longer touches kept history restarts that kind and drops a page in flight', async () => {
  const base = new FakeAgents(() => {}).snapshot();
  const scope = { kind: 'agent' as const, id: 'agent_1' };
  const message = (id: string, at: number): AgentEntities['message'] => ({ id, revision: 1, createdAt: at, updatedAt: at, scope, senderId: null, text: id, recipientIds: [], replyTo: null, episodeId: id, sourceRunId: null });
  const empty = { messages: [], work: [], memories: [], deliveries: [], runs: [], decisions: [] };
  let answer!: (page: unknown) => void;
  let snapshots = 0;
  const call = vi.fn((method: string, _params: unknown) => {
    if (method === 'agents.history') return new Promise(done => { answer = done; });
    snapshots++;
    // The second window starts after everything the first one held: 100 messages arrived in between.
    return Promise.resolve(snapshots === 1
      ? { ...base, messages: [message('m1', 1), message('m2', 2)], more: { ...base.more, message: true } }
      : { ...base, revision: 2, messages: [message('m200', 200), message('m201', 201)], more: { ...base.more, message: true } });
  });
  const view = new AgentsView({ client: { call, on: () => () => {} } } as unknown as Store);
  try {
    await view.refresh();
    const loading = view.loadOlder('chat', { kind: 'message', scopes: [scope] }, view.seen.messages);
    await view.refresh();
    expect(view.seen.messages.map(m => m.id)).toEqual(['m200', 'm201']);
    answer({ ...empty, messages: [message('m0', 0)], more: false });
    await loading;
    expect(view.seen.messages.map(m => m.id)).toEqual(['m200', 'm201']);
    expect(view.hasOlder('chat', 'message')).toBe(true);
  } finally { view.close(); }
});

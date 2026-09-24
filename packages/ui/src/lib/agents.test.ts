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

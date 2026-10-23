import { expect, vi } from 'vitest';
import type { AgentsSnapshot } from '@boite/contracts';
import { test } from '../test/fake-client';
import { AgentsView, agentOfThread, agentRows, liveStep, openAgent, previewOf, avatarText } from './agents.svelte';
import { AgentDirectory } from './agent-directory.svelte';
import { setExperiment } from './experiments';
import { FakeAgents } from './fake-agents';
import { openQuestionPage } from './question-page';
import { rightPanel } from './right-panel.svelte';
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
  const view = new AgentsView(source as unknown as Store);
  try {
    // On screen: the view follows `agents.changed`.
    view.start();
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

test('the newest agent open wins over an older one answered last, and a navigation meanwhile drops it', async () => {
  const answers = new Map<string, (value: { threadId: string }) => void>();
  const call = vi.fn((_method: string, params: { agentId: string }) => new Promise(resolve => { answers.set(params.agentId, resolve); }));
  const open = vi.fn(async (_threadId: string) => {});
  const store = { client: { call, on: () => () => {} }, open, navigationGeneration: 0 } as unknown as Store & { navigationGeneration: number };
  const a = openAgent(store, 'a');
  const b = openAgent(store, 'b');
  answers.get('b')!({ threadId: 'thread-b' });
  await b;
  answers.get('a')!({ threadId: 'thread-a' });
  await a;
  expect(open.mock.calls.map(([threadId]) => threadId)).toEqual(['thread-b']);
  // Another thread or page opened while it waited: the agent's thread does not take the screen back.
  const c = openAgent(store, 'c');
  store.navigationGeneration++;
  answers.get('c')!({ threadId: 'thread-c' });
  await c;
  expect(open.mock.calls.map(([threadId]) => threadId)).toEqual(['thread-b']);
});

test('two users of one view keep it listening until the last one leaves', async () => {
  const off = vi.fn();
  const client = { call: vi.fn().mockResolvedValue(new FakeAgents(() => {}).snapshot()), on: vi.fn(() => off) };
  const view = new AgentsView({ client } as unknown as Store);
  view.start();
  view.start();
  await view.refresh();
  view.pause();
  expect(off).not.toHaveBeenCalled();
  view.pause();
  expect(off).toHaveBeenCalledOnce();
  view.close();
});

test('the list puts the agent that spoke last first, leaves archived agents out and reads the live step from the thread row', () => {
  const at = (n: number) => 1_700_000_000_000 + n;
  const profile = (id: string, created: number, status: 'active' | 'archived' = 'active') => ({ id, name: id, domain: '', instructions: '', avatar: '', status, revision: 1, createdAt: at(created), updatedAt: at(created),
    selection: { providerId: 'echo', accountId: 'echo', model: null, effort: null, permissionMode: 'default' as const } });
  const status = (agentId: string, last: number | null, activity: string | null = null) => ({ agentId, threadId: `t-${agentId}`, state: 'idle' as const, activity, problem: null, nextWake: null, unread: 0,
    last: last === null ? null : { text: 'hi', at: at(last) }, today: { turns: 0, wakes: 0, quiet: 0, costUsd: 0 } });
  const snapshot = { profiles: [profile('old', 1), profile('new', 5), profile('gone', 9, 'archived'), profile('quiet', 3)], sessions: [{ id: 's', agentId: 'old', threadId: 't-old', revision: 1, createdAt: 0, updatedAt: 0 }],
    status: [status('old', 10, 'Run the tests'), status('new', null), status('quiet', null)] } as unknown as AgentsSnapshot;
  expect(agentRows(snapshot).map(r => r.profile.id)).toEqual(['old', 'new', 'quiet']);
  expect(agentOfThread(snapshot, 't-old')?.id).toBe('old');
  expect(agentOfThread(snapshot, 't-new')?.id).toBe('new');
  const row = agentRows(snapshot)[0]!;
  expect(liveStep(row.status, null)).toBe('Run the tests');
  expect(liveStep(row.status, { status: 'running', progress: { turnId: 'x', phase: 'tool', detail: 'Read App.svelte', at: 0 } } as never)).toBe('Read App.svelte');
});

test('previews drop markdown and avatars fall back to initials', () => {
  expect(previewOf('**Done**: see [the PR](https://x.test)\n\n```ts\ncode\n```')).toBe('Done: see the PR code');
  expect(avatarText('Mira Scout', '')).toBe('MS');
});

test('the directory counts an agent at work from its own status when this client has its thread row', () => {
  const thread = { id: 't-a', agentSessionId: 's-a', status: 'idle', archived: false, runningSince: null } as never;
  const store = { threads: [thread], client: null } as unknown as Store;
  const directory = new AgentDirectory(store);
  directory.snapshot = { profiles: [{ id: 'a', name: 'A', avatar: '' }], sessions: [{ id: 's-a', agentId: 'a', threadId: 't-a' }],
    status: [{ agentId: 'a', threadId: 't-a', state: 'waiting' }] } as unknown as AgentsSnapshot;
  expect(directory.atWork.map(w => [w.agent.id, w.waiting])).toEqual([['a', true]]);
});

test('an agent opens its own thread on the Agents page, and the thread list comes back to the thread it showed', async ({ ready }) => {
  setExperiment('resident-agents', true);
  try {
    const { store, client } = await ready({ delayMs: 0, agentsDemo: true });
    await store.open('t-trace');
    expect(store.page).toBe('chat');
    const view = AgentsView.of(store);
    await view.refresh();
    const mira = view.snapshot!.profiles.find(p => p.name === 'Mira')!;
    store.showAgents();
    const threadId = (await openAgent(store, mira.id))!;
    expect(store.openThread?.id).toBe(threadId);
    expect(store.page).toBe('agents');
    // Its thread takes the user's messages like any thread: an ordinary turn, answered.
    const turn = await client.call('turns.start', { threadId, prompt: 'hello' });
    await vi.waitFor(() => expect(store.openThread?.turns.find(t => t.id === turn.id)?.status).toBe('done'));
    store.showChat();
    await vi.waitFor(() => expect(store.openThread?.id).toBe('t-trace'));
    expect(store.page).toBe('chat');
  } finally { setExperiment('resident-agents', false); }
});

test('Open on an agent\'s login question shows the page beside its conversation, on the Agents page', async ({ ready }) => {
  setExperiment('resident-agents', true);
  try {
    const { store, client } = await ready({ delayMs: 0, agentsDemo: true });
    const view = AgentsView.of(store);
    await view.refresh();
    const iris = view.snapshot!.profiles.find(p => p.name === 'Iris')!;
    store.showAgents();
    const threadId = (await openAgent(store, iris.id))!;
    await vi.waitFor(() => expect(store.pendingQuestions.some(q => q.threadId === threadId && q.open)).toBe(true));
    const question = store.pendingQuestions.find(q => q.threadId === threadId && q.open)!;
    await openQuestionPage(store, threadId, question.id);
    expect(store.page).toBe('agents');
    expect(store.openThread?.id).toBe(threadId);
    const panel = rightPanel.for(store.threadKey(threadId));
    await vi.waitFor(() => expect(panel.active?.kind).toBe('agent-browser'));
    expect(panel.isOpen).toBe(true);
    expect((await client.call('browser.remoteStatus', { threadId })).tabs).toMatchObject([{ url: 'https://dashboard.example.com/login', active: true }]);
  } finally { setExperiment('resident-agents', false); }
});

import { expect, test, vi } from 'vitest';
import type { AgentEntities, AgentScope, AgentsSnapshot } from '@boite/contracts';
import { AgentsView, agentChats, attentionOf, avatarText, liveThreads, missionPreset, missionsOf, previewOf } from './agents.svelte';
import { AgentDirectory } from './agent-directory.svelte';
import type { ThreadSummary } from '@boite/contracts';
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

/** A small directory: Mira and Atlas, Lin archived, a group whose team folds into it, and a team with no group. */
function directory() {
  const base = new FakeAgents(() => {}).snapshot();
  const record = { revision: 1, createdAt: 1 };
  const profile = (id: string, name: string, updatedAt: number, status: AgentEntities['profile']['status'] = 'active') => ({ ...record, id, updatedAt, name, domain: `${name} domain`, instructions: '', avatar: '', selection: { providerId: 'p', accountId: 'a', model: null, effort: null, permissionMode: 'default' as const }, status, tools: [], accountIntegration: 'provider' as const });
  const snapshot: AgentsSnapshot = {
    ...base,
    profiles: [profile('mira', 'Mira', 10), profile('atlas', 'Atlas', 20), profile('lin', 'Lin', 90, 'archived')],
    groups: [{ ...record, id: 'table', updatedAt: 5, name: 'Ideas table', memberIds: ['mira', 'atlas'], mode: 'round', maxTurns: 6, maxTurnsPerAgent: 2, paused: false }],
    teams: [
      { ...record, id: 'studio', updatedAt: 6, name: 'Studio', description: '', members: [{ agentId: 'mira', responsibility: 'Explore' }], projectIds: [], groupId: 'table', paused: false },
      { ...record, id: 'crew', updatedAt: 4, name: 'Crew', description: '', members: [{ agentId: 'atlas', responsibility: 'Build' }], projectIds: [], groupId: null, paused: false }
    ],
    missions: [
      { ...record, id: 'm-studio', updatedAt: 7, title: 'Studio work', objective: '', expectedResult: '', teamId: 'studio', projectId: null, agentIds: ['mira'], status: 'review', maxTurns: 6, maxDurationMs: 60000, maxTokens: null, resourceIds: [] },
      { ...record, id: 'm-solo', updatedAt: 8, title: 'Solo', objective: '', expectedResult: '', teamId: null, projectId: null, agentIds: ['atlas'], status: 'open', maxTurns: 6, maxDurationMs: 60000, maxTokens: null, resourceIds: [] }
    ],
    tasks: [{ ...record, id: 't1', updatedAt: 7, missionId: 'm-studio', title: 'Check', instructions: '', dependsOn: [], assigneeId: 'mira', status: 'review', generation: 1, leaseUntil: null, workspace: null, result: 'Done' }]
  };
  const message = (id: string, scope: AgentScope, senderId: string | null, at: number): AgentEntities['message'] => ({ ...record, id, updatedAt: at, createdAt: at, scope, senderId, text: `**${id}**  text`, recipientIds: [], replyTo: null, episodeId: id, sourceRunId: null });
  return { snapshot, message };
}

test('the chat list folds a team into its group, orders by activity and counts unread and attention', () => {
  const { snapshot, message } = directory();
  const messages = [
    message('hello', { kind: 'agent', id: 'mira' }, null, 30),
    message('reply', { kind: 'agent', id: 'mira' }, 'mira', 31),
    message('later', { kind: 'agent', id: 'mira' }, 'mira', 32),
    message('table', { kind: 'group', id: 'table' }, 'atlas', 25)
  ];
  const chats = agentChats(snapshot, messages, { 'profile:mira': 31 }, attentionOf(snapshot, []));
  expect(chats.map(c => `${c.kind}:${c.id}`)).toEqual(['profile:mira', 'group:table', 'profile:atlas', 'team:crew']);
  const [mira, table, , crew] = chats;
  expect(mira).toMatchObject({ last: { id: 'later' }, unread: 1, status: 'idle', scope: { kind: 'agent', id: 'mira' } });
  expect(table).toMatchObject({ teamId: 'studio', members: ['mira', 'atlas'], unread: 1, attention: 1 });
  expect(crew).toMatchObject({ scope: null, teamId: 'crew', members: ['atlas'] });
  expect(chats.some(c => c.id === 'lin' || c.id === 'studio')).toBe(false);
});

test('running and waiting work lights the conversation it belongs to and the agent doing it', () => {
  const { snapshot } = directory();
  const work = (id: string, agentId: string, scope: AgentScope, status: AgentEntities['work']['status'], at: number): AgentEntities['work'] => ({ id, revision: 1, createdAt: at, updatedAt: at, agentId, scope, taskId: null, taskGeneration: null, messageId: null, episodeId: id, prompt: id, status, error: null, runId: null, notBefore: 0 });
  const busy = { ...snapshot, work: [work('w1', 'atlas', { kind: 'group', id: 'table' }, 'running', 50), work('w2', 'mira', { kind: 'mission', id: 'm-studio' }, 'waiting', 40)] };
  const chats = agentChats(busy, [], {}, attentionOf(busy, []));
  const of = (key: string) => chats.find(c => `${c.kind}:${c.id}` === key)!;
  expect(of('group:table').status).toBe('waiting');
  expect(of('profile:atlas').status).toBe('running');
  expect(of('profile:mira').status).toBe('waiting');
  expect(chats[0]!.id).toBe('table');
});

/** The threads agent sessions run in: Atlas in the group, Mira alone (waiting on the user), and Mira's archived one. */
function sessionThreads() {
  const { snapshot } = directory();
  const record = { revision: 1, createdAt: 1, updatedAt: 1 };
  const sessions = [
    { ...record, id: 's-atlas-table', agentId: 'atlas', scope: { kind: 'group' as const, id: 'table' }, threadId: 't-atlas' },
    { ...record, id: 's-mira', agentId: 'mira', scope: { kind: 'agent' as const, id: 'mira' }, threadId: 't-mira' },
    { ...record, id: 's-mira-old', agentId: 'mira', scope: { kind: 'mission' as const, id: 'm-studio' }, threadId: 't-old' }
  ];
  const thread = (id: string, agentSessionId: string, status: ThreadSummary['status'], archived = false) => ({ id, agentSessionId, status, archived, runningSince: 100, parentThreadId: null } as unknown as ThreadSummary);
  const threads = [thread('t-atlas', 's-atlas-table', 'running'), thread('t-mira', 's-mira', 'waiting'), thread('t-old', 's-mira-old', 'running', true), thread('t-plain', '', 'running')];
  return { snapshot: { ...snapshot, sessions }, threads };
}

test('an agent at work lights its own row and the conversation its session belongs to', () => {
  const { snapshot, threads } = sessionThreads();
  const live = liveThreads(snapshot, threads);
  expect(live.get('profile:atlas')?.id).toBe('t-atlas');
  expect(live.get('group:table')?.id).toBe('t-atlas');
  expect(live.get('profile:mira')?.id).toBe('t-mira');
  // An archived session thread and an ordinary thread light nothing.
  expect([...live.values()].some(t => t.id === 't-old' || t.id === 't-plain')).toBe(false);
});

test('the thread list names the agent of a thread and lists the agents at work, the one waiting on the user first', () => {
  const { snapshot, threads } = sessionThreads();
  const store = { threads: [...threads, { id: 't-child', parentThreadId: 't-atlas', status: 'running', archived: false } as unknown as ThreadSummary] } as unknown as Store;
  const directory = new AgentDirectory(store);
  expect(directory.ownerOf(threads[0]!)).toBeNull();
  directory.snapshot = snapshot;
  expect(directory.ownerOf(threads[0]!)?.name).toBe('Atlas');
  // A delegated child belongs to its parent's agent.
  expect(directory.ownerOf(store.threads.at(-1)!)?.name).toBe('Atlas');
  expect(directory.ownerOf(threads[3]!)).toBeNull();
  expect(directory.atWork.map(w => [w.agent.name, w.waiting])).toEqual([['Mira', true], ['Atlas', false]]);
  // Work waiting on a decision counts after its turn ended: the thread is idle, the agent still needs the user.
  const idle = threads.map(t => (t.id === 't-mira' ? { ...t, status: 'idle' as const } : t));
  const waiting = { ...snapshot, runs: [{ id: 'r1', threadId: 't-mira' } as unknown as AgentsSnapshot['runs'][number]], work: [{ id: 'w1', agentId: 'mira', status: 'waiting', runId: 'r1' } as unknown as AgentsSnapshot['work'][number]] };
  const later = new AgentDirectory({ threads: idle } as unknown as Store);
  later.snapshot = waiting;
  expect(later.atWork.map(w => [w.agent.name, w.thread.status, w.waiting])).toEqual([['Mira', 'waiting', true], ['Atlas', 'running', false]]);
});

test('a conversation lists its missions and starts a new one with its members and team', () => {
  const { snapshot } = directory();
  const table = { kind: 'group' as const, id: 'table', teamId: 'studio', members: ['mira', 'atlas'] };
  expect(missionsOf(snapshot, table).map(m => m.id)).toEqual(['m-studio']);
  expect(missionsOf(snapshot, { kind: 'profile', id: 'atlas', teamId: null, members: ['atlas'] }).map(m => m.id)).toEqual(['m-solo']);
  expect(missionsOf(snapshot, { kind: 'team', id: 'crew', teamId: 'crew', members: ['atlas'] })).toEqual([]);
  expect(missionPreset(snapshot, table)).toEqual({ teamId: 'studio', memberIds: ['mira'] });
  expect(missionPreset(snapshot, { kind: 'profile', id: 'atlas', teamId: null, members: ['atlas'] })).toEqual({ teamId: null, memberIds: ['atlas'] });
});

test('avatars take a short avatar or the initials, previews drop markdown', () => {
  expect(avatarText('Prototype studio')).toBe('PS');
  expect(avatarText('mira', '🦊')).toBe('🦊');
  expect(avatarText('Mira', 'a long avatar')).toBe('M');
  expect(avatarText('  ')).toBe('?');
  expect(previewOf('**Bold** and `code`\n\n- [a link](https://x)')).toBe('Bold and code - a link');
});

test('a read mark survives a new view of the same core', async () => {
  const { snapshot } = directory();
  localStorage.clear();
  const store = { client: { call: vi.fn().mockResolvedValue(snapshot), on: () => () => {} }, core: { dataDir: 'D:/core' } } as unknown as Store;
  const first = new AgentsView(store);
  const second = new AgentsView(store);
  try {
    await first.refresh();
    first.markRead('profile:mira', 40);
    first.markRead('profile:mira', 30);
    expect(first.readAt).toEqual({ 'profile:mira': 40 });
    await second.refresh();
    expect(second.readAt).toEqual({ 'profile:mira': 40 });
  } finally { first.close(); second.close(); localStorage.clear(); }
});

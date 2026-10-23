import { expect, test } from 'vitest';
import { AGENT_HISTORY_PAGE, type AgentRecord, type AgentsHistoryPage } from '@boite/contracts';
import { oldestOf } from './agents.svelte';
import { FakeAgents } from './fake-agents';
import { FakeClient } from './fake-client';

test('runtime settings retain approved missing models but refuse newly added unlisted routes', async () => {
  const client = new FakeClient({ delayMs: 0 });
  await client.connect();
  try {
    let agent = await client.call('agents.profile.save', { value: {
      name: 'Ada', domain: '', instructions: '', avatar: '', status: 'active', tools: ['messages'],
      selection: { providerId: 'echo', accountId: 'a-echo', model: 'old-echo', effort: null, permissionMode: 'default' },
    } });
    let config = await client.call('agents.runtime.get', { agentId: agent.id });
    config.defaultRoute.permissionMode = 'yolo';
    agent = await client.call('agents.runtime.configure', { agentId: agent.id, expectedRevision: agent.revision, config });
    expect(agent.selection).toMatchObject({ model: 'old-echo', permissionMode: 'yolo' });
    config = await client.call('agents.runtime.get', { agentId: agent.id });
    config.allowedRoutes.push({ ...config.allowedRoutes[0]!, id: 'added', model: 'unknown' });
    await expect(client.call('agents.runtime.configure', { agentId: agent.id, expectedRevision: agent.revision, config }))
      .rejects.toThrow('the provider does not offer this model');
    expect((await client.call('agents.runtime.get', { agentId: agent.id })).allowedRoutes).toHaveLength(1);
  } finally { client.close(); }
});

test('the fake executes bounded groups, keeps native contexts distinct and refuses direct starts', async () => {
  const client = new FakeClient({ delayMs: 0 }); await client.connect();
  try {
    const account = (await client.call('accounts.list', {})).find(a => a.providerId === 'echo')!;
    const make = (name: string) => client.call('agents.profile.save', { value: { name, domain: '', instructions: '', avatar: '', selection: { providerId: 'echo', accountId: account.id, model: null, effort: null, permissionMode: 'default' as const }, status: 'active' as const, tools: ['messages'] } });
    const a = await make('A'); const b = await make('B');
    const group = await client.call('agents.group.save', { value: { name: 'Round table', memberIds: [a.id, b.id], mode: 'autonomous', maxTurns: 3, maxTurnsPerAgent: 2, paused: false } });
    await client.call('agents.message.send', { scope: { kind: 'group', id: group.id }, recipientIds: [a.id], text: 'Review this design', requestId: 'fake_group_001' });
    await expect.poll(async () => (await client.call('agents.snapshot', {})).work.filter(w => w.status === 'done').length).toBe(3);
    await client.call('agents.message.send', { scope: { kind: 'agent', id: a.id }, recipientIds: [a.id], text: 'Private topic', requestId: 'fake_private_001' });
    await expect.poll(async () => (await client.call('agents.snapshot', {})).work.filter(w => w.status === 'done').length).toBe(4);
    const snapshot = await client.call('agents.snapshot', {});
    expect(snapshot.sessions).toHaveLength(3);
    expect(snapshot.deliveries.filter(d => d.status === 'limited')).toHaveLength(1);
    expect(snapshot.messages.filter(m => m.scope.kind === 'group').some(m => m.text.includes('Private topic'))).toBe(false);
    await expect(client.call('turns.start', { threadId: snapshot.sessions[0]!.threadId, prompt: 'bypass' })).rejects.toThrow('persistent');
  } finally { client.close(); }
});

test('the fake keeps a fired once routine done, and a new date saved while paused re-arms it', async () => {
  const client = new FakeClient({ delayMs: 0 }); await client.connect();
  try {
    const account = (await client.call('accounts.list', {})).find(a => a.providerId === 'echo')!;
    const agent = await client.call('agents.profile.save', { value: { name: 'Scout', domain: '', instructions: '', avatar: '', selection: { providerId: 'echo', accountId: account.id, model: null, effort: null, permissionMode: 'default' as const }, status: 'active' as const, tools: ['messages'] } });
    const routine = await client.call('agents.routine.save', { value: { agentId: agent.id, name: 'Tomorrow', prompt: 'Look once', schedule: { kind: 'once', at: Date.now() + 86400000 }, enabled: true, nextAt: null, lastWorkId: null, lastScheduledAt: null } });
    await client.call('agents.routine.run', { routineId: routine.id, requestId: 'fake_once_001' });
    const ran = (await client.call('agents.snapshot', {})).routines.find(r => r.id === routine.id)!;
    expect([ran.enabled, ran.nextAt]).toEqual([false, null]);
    const resumed = await client.call('agents.routine.save', { id: ran.id, expectedRevision: ran.revision, value: { ...ran, enabled: true } });
    expect(resumed.nextAt).toBeNull();
    const at = Date.now() + 3600000;
    const moved = await client.call('agents.routine.save', { id: resumed.id, expectedRevision: resumed.revision, value: { ...resumed, enabled: false, schedule: { kind: 'once', at } } });
    expect(moved.nextAt).toBeNull();
    expect((await client.call('agents.routine.save', { id: moved.id, expectedRevision: moved.revision, value: { ...moved, enabled: true } })).nextAt).toBe(at);
  } finally { client.close(); }
});

test('the fake denies persistent configuration and engine shutdown to paired devices', async () => {
  const client = new FakeClient({ delayMs: 0, principal: 'session' }); await client.connect();
  try {
    await expect(client.call('agents.limits.set', { paused: false, backgroundConcurrency: 8 })).rejects.toThrow('owner');
    await expect(client.call('core.shutdown', {})).rejects.toThrow('owner');
    expect((await client.call('agents.snapshot', {})).profiles).toEqual([]);
  } finally { client.close(); }
});

test('the fake bounds snapshot bodies, counts all unread replies and pages older memories', () => {
  const fake = new FakeAgents(() => {});
  const save = (fake as unknown as { save: (kind: 'memory' | 'message', p: { value: object }) => AgentRecord }).save.bind(fake);
  const scope = { kind: 'agent' as const, id: 'agent_1' };
  for (let i = 0; i < AGENT_HISTORY_PAGE + 25; i++) {
    save('memory', { value: { scope, title: `Memory ${i}`, text: 'kept', sourceScopes: [scope], sourceRunId: null, expiresAt: null } });
    save('message', { value: { scope, senderId: 'agent_1', text: 'A reply', recipientIds: [], replyTo: null, episodeId: 'history', sourceRunId: null } });
  }
  const snapshot = fake.snapshot([]);
  expect(snapshot.messages).toHaveLength(AGENT_HISTORY_PAGE);
  expect(snapshot.more.message).toBe(true);
  expect(snapshot.unread).toEqual([{ scope, at: 0, count: AGENT_HISTORY_PAGE + 25 }]);
  expect(fake.snapshot([{ scope, at: Date.now() }]).unread).toEqual([]);
  const window = fake.call('agents.messages', { scope, readAt: 0, limit: 7 }) as import('@boite/contracts').AgentMessagesPage;
  expect(window.messages).toHaveLength(7); expect(window.older).toBe(false); expect(window.newer).toBe(true);
  const edge = window.messages.at(-1)!;
  const next = fake.call('agents.messages', { scope, after: { createdAt: edge.createdAt, id: edge.id }, limit: 7 }) as import('@boite/contracts').AgentMessagesPage;
  expect(new Set([...window.messages, ...next.messages].map(m => m.id)).size).toBe(14);
  expect(snapshot.memories).toHaveLength(AGENT_HISTORY_PAGE);
  expect(snapshot.more.memory).toBe(true);
  const seen = new Set(snapshot.memories.map(m => m.id));
  let before = oldestOf(snapshot.memories);
  for (let more = true; more;) {
    const page = fake.call('agents.history', { kind: 'memory', scopes: [scope], before, limit: 10 }) as AgentsHistoryPage;
    for (const m of page.memories) { expect(seen.has(m.id)).toBe(false); seen.add(m.id); }
    before = oldestOf(page.memories); more = page.more;
  }
  expect(seen.size).toBe(AGENT_HISTORY_PAGE + 25);
  expect(() => fake.call('agents.history', { kind: 'memory', agentId: 'agent_1' })).toThrow('agentId');
});

test('the fake entrusts a thread like the core: refusals, the take-over message, then one done message', async () => {
  const client = new FakeClient({ delayMs: 0, delegationDemo: true }); await client.connect();
  try {
    const account = (await client.call('accounts.list', {})).find(a => a.providerId === 'echo')!;
    const agent = await client.call('agents.profile.save', { value: { name: 'Ada', domain: '', instructions: '', avatar: '', selection: { providerId: 'echo', accountId: account.id, model: null, effort: null, permissionMode: 'default' as const }, status: 'active' as const, tools: ['messages'] } });
    const threads = await client.call('threads.list', { includeArchived: true });
    const child = threads.find(t => t.parentThreadId)!;
    const thread = threads.find(t => !t.parentThreadId && !t.agentSessionId && !t.archived && t.projectId && t.status === 'idle')!;
    await expect(client.call('agents.entrust', { threadId: 'nowhere', agentId: agent.id })).rejects.toThrow('threadId');
    await expect(client.call('agents.entrust', { threadId: child.id, agentId: agent.id })).rejects.toThrow('delegated child');
    await expect(client.call('agents.entrust', { threadId: thread.id, agentId: 'nobody' })).rejects.toThrow('agentId');
    await expect(client.call('agents.entrust', { threadId: thread.id, agentId: agent.id, objective: 'x'.repeat(4001) })).rejects.toThrow('objective');
    const entry = await client.call('agents.entrust', { threadId: thread.id, agentId: agent.id, objective: 'Ship it' });
    expect(entry).toMatchObject({ threadId: thread.id, agentId: agent.id, objective: 'Ship it' });
    const about = async () => (await client.call('agents.snapshot', {})).messages.filter(m => m.thread?.id === thread.id).map(m => m.thread!.event);
    await expect.poll(about).toEqual(['entrusted', 'done']);
    const snapshot = await client.call('agents.snapshot', {});
    const done = snapshot.messages.find(m => m.thread?.event === 'done')!;
    expect(done).toMatchObject({ senderId: agent.id, scope: { kind: 'agent', id: agent.id }, recipientIds: [] });
    const opened = await client.call('threads.get', { threadId: thread.id });
    const last = opened.messages.filter(m => m.role === 'assistant').at(-1)!;
    expect(done.text).toBe(last.parts.flatMap(p => p.type === 'text' ? [p.text] : []).join('\n'));
    expect(snapshot.entrusted).toEqual([]);
    expect(opened.activity?.goal?.status).toBe('complete');
  } finally { client.close(); }
});

test('the fake keeps entrusted projects and moves every brain with the root, each in a folder of its own', async () => {
  const client = new FakeClient({ delayMs: 0 }); await client.connect();
  try {
    const account = (await client.call('accounts.list', {})).find(a => a.providerId === 'echo')!;
    const project = (await client.call('projects.list', {})).find(p => p.kind !== 'drafts')!;
    const make = (name: string) => client.call('agents.profile.save', { value: { name, domain: '', instructions: '', avatar: '', selection: { providerId: 'echo', accountId: account.id, model: null, effort: null, permissionMode: 'default' as const }, status: 'active' as const, tools: ['messages'], projectIds: [project.id] } });
    const ada = await make('Ada'); const lin = await make('Lin');
    expect((await client.call('agents.snapshot', {})).profiles.find(a => a.id === ada.id)?.projectIds).toEqual([project.id]);
    expect((await client.call('agents.runtime.get', { agentId: ada.id })).subagents).toMatchObject({ enabled: true, paused: false, anyModel: true });

    const before = await client.call('agents.snapshot', {});
    expect(before.brainRoot).toEqual({ path: '/agent-workspaces', custom: false });
    await expect(client.call('agents.brain.root', { path: 'relative/brains' })).rejects.toThrow('absolute');
    expect((await client.call('agents.snapshot', {})).brainRoot).toEqual(before.brainRoot);
    // A folder that already holds files, a brain repository say, takes the brains in folders of their own.
    expect(await client.call('agents.brain.root', { path: project.path })).toEqual({ path: project.path, custom: true });
    expect((await client.call('agents.brain.get', { agentId: ada.id })).path).toBe(`${project.path}/ada`);

    expect(await client.call('agents.brain.root', { path: '/srv/brains/' })).toEqual({ path: '/srv/brains', custom: true });
    expect((await client.call('agents.snapshot', {})).brainRoot).toEqual({ path: '/srv/brains', custom: true });
    expect((await client.call('agents.brain.get', { agentId: ada.id })).path).toBe('/srv/brains/ada');
    expect((await client.call('agents.brain.get', { agentId: lin.id })).path).toBe('/srv/brains/lin');
    await client.call('agents.brain.root', { path: null });
    expect((await client.call('agents.brain.get', { agentId: ada.id })).path).toBe(`/agent-workspaces/${ada.id}/brain`);
  } finally { client.close(); }
});

test('the agents demo seeds an entrusted project, a reply with a readable picture and its memory pass, and a notice', async () => {
  const client = new FakeClient({ delayMs: 0, agentsDemo: true }); await client.connect();
  try {
    const snapshot = await client.call('agents.snapshot', {});
    const project = (await client.call('projects.list', {})).find(p => p.kind !== 'drafts')!;
    const [agent] = snapshot.profiles;
    expect(agent?.projectIds).toEqual([project.id]);
    const workOf = (runId: string | null) => snapshot.work.find(w => w.id === snapshot.runs.find(r => r.id === runId)?.workId);
    const reply = snapshot.messages.find(m => m.files?.length)!;
    expect(workOf(reply.sourceRunId)?.memory).toMatchObject({ status: 'done' });
    const file = reply.files![0]!;
    expect(file.part.mimeType).toMatch(/^image\//);
    expect(await client.call('artifacts.read', { threadId: file.threadId, messageId: file.messageId, artifactId: file.part.id })).toMatchObject({ name: file.part.name });
    expect(snapshot.sessions.find(s => s.agentId === agent!.id && s.scope.kind === 'agent')?.threadId).toBe(file.threadId);
    const notice = snapshot.messages.find(m => workOf(m.sourceRunId)?.purpose === 'notice');
    expect(notice?.replyTo).toBeNull();
    // Dated in the order the core would have written them.
    expect(snapshot.messages.map(m => m.senderId === null ? 'user' : m.files ? 'reply' : 'notice')).toEqual(['user', 'reply', 'notice']);
  } finally { client.close(); }
});

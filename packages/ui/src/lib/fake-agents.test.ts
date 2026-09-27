import { expect, test } from 'vitest';
import { AGENT_HISTORY_PAGE, type AgentRecord, type AgentsHistoryPage } from '@boite/contracts';
import { oldestOf } from './agents.svelte';
import { FakeAgents } from './fake-agents';
import { FakeClient } from './fake-client';

test('the fake executes bounded groups, keeps native contexts distinct and refuses direct starts', async () => {
  const client = new FakeClient({ delayMs: 0 }); await client.connect();
  try {
    const account = (await client.call('accounts.list', {})).find(a => a.providerId === 'echo')!;
    const make = (name: string) => client.call('agents.profile.save', { value: { name, domain: '', instructions: '', avatar: '', selection: { providerId: 'echo', accountId: account.id, model: null, effort: null, permissionMode: 'default' as const }, status: 'active' as const, tools: ['messages'], accountIntegration: 'provider' as const } });
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
    const agent = await client.call('agents.profile.save', { value: { name: 'Scout', domain: '', instructions: '', avatar: '', selection: { providerId: 'echo', accountId: account.id, model: null, effort: null, permissionMode: 'default' as const }, status: 'active' as const, tools: ['messages'], accountIntegration: 'provider' as const } });
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
    await expect(client.call('agents.limits.set', { paused: false, backgroundConcurrency: 8, kebaccExperiment: true })).rejects.toThrow('owner');
    await expect(client.call('core.shutdown', {})).rejects.toThrow('owner');
    expect((await client.call('agents.snapshot', {})).profiles).toEqual([]);
  } finally { client.close(); }
});

test('the fake bounds its snapshot and pages older memories by cursor, like the core', () => {
  const fake = new FakeAgents(() => {});
  const save = (fake as unknown as { save: (kind: 'memory', p: { value: object }) => AgentRecord }).save.bind(fake);
  const scope = { kind: 'agent' as const, id: 'agent_1' };
  for (let i = 0; i < AGENT_HISTORY_PAGE + 25; i++) save('memory', { value: { scope, title: `Memory ${i}`, text: 'kept', sourceScopes: [scope], sourceRunId: null, expiresAt: null } });
  const snapshot = fake.snapshot();
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

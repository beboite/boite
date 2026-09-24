import { expect, test } from 'vitest';
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

test('the fake denies persistent configuration and engine shutdown to paired devices', async () => {
  const client = new FakeClient({ delayMs: 0, principal: 'session' }); await client.connect();
  try {
    await expect(client.call('agents.limits.set', { paused: false, backgroundConcurrency: 8, kebaccExperiment: true })).rejects.toThrow('owner');
    await expect(client.call('core.shutdown', {})).rejects.toThrow('owner');
    expect((await client.call('agents.snapshot', {})).profiles).toEqual([]);
  } finally { client.close(); }
});

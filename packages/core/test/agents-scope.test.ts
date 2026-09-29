import { expect, test } from 'bun:test';
import { connect } from '../src/client.ts';
import { startTestCore } from './harness.ts';
import type { AgentProfile, AgentScope } from '@boite/contracts';

test('a shared member cannot import another group context and loses access when removed', async () => {
  const h = await startTestCore();
  try {
    const c = await h.connect(); h.core.workforce.setLimits({ ...h.core.workforce.limits(), paused: true });
    const account = (await c.call('accounts.list', {})).find(a => a.providerId === 'echo')!;
    const agent = await c.call('agents.profile.save', { value: { name: 'Member', domain: '', instructions: '', avatar: '', selection: { providerId: 'echo', accountId: account.id, model: null, effort: null, permissionMode: 'default' }, status: 'active', tools: ['messages', 'memory'], accountIntegration: 'provider' } });
    const group = (name: string) => c.call('agents.group.save', { value: { name, memberIds: [agent.id], mode: 'mentions', maxTurns: 6, maxTurnsPerAgent: 2, paused: false } });
    const a = await group('Private'); const b = await group('Shared');
    const aScope: AgentScope = { kind: 'group', id: a.id }; const bScope: AgentScope = { kind: 'group', id: b.id };
    await c.call('agents.message.send', { scope: aScope, text: 'Private source', recipientIds: [], requestId: 'private_scope_001' });
    await c.call('agents.memory.save', { value: { scope: { kind: 'agent', id: agent.id }, title: 'Private memory', text: 'Group A only', sourceScopes: [aScope], sourceRunId: null, expiresAt: null } });
    const createSession = (agent: AgentProfile, scope: AgentScope) => {
      const session = h.core.workforce.records.create('session', { agentId: agent.id, scope, threadId: '' });
      const thread = h.core.threads.createAgentSession(agent, session.id, h.dataDir);
      h.core.workforce.records.update('session', session.id, session.revision, { ...session, threadId: thread.id });
      return thread;
    };
    const thread = createSession(agent, bScope); const other = createSession(agent, aScope);
    const scoped = await connect(h.url, h.core.agents.tokenFor(thread.id));
    try {
      const snapshot = await scoped.call('agents.snapshot', { threadId: thread.id });
      expect(snapshot.groups.map(g => g.id)).toEqual([b.id]);
      expect(snapshot.memories).toEqual([]); expect(snapshot.messages).toEqual([]);
      await expect(scoped.call('agents.snapshot', { threadId: other.id })).rejects.toThrow('for thread');
      await expect(scoped.call('agents.message.send', { threadId: thread.id, scope: aScope, text: 'inject', recipientIds: [], requestId: 'cross_scope_001' })).rejects.toThrow('scope');
      await expect(scoped.call('agents.memory.save', { threadId: thread.id, value: { scope: bScope, sourceScopes: [aScope], title: 'Copy', text: 'copied', sourceRunId: null, expiresAt: null } })).rejects.toThrow('sourceScopes');
      await c.call('agents.group.save', { id: b.id, expectedRevision: b.revision, value: { ...b, memberIds: [] } });
      await expect(scoped.call('agents.snapshot', { threadId: thread.id })).rejects.toThrow('no longer belongs');
    } finally { scoped.close(); }
  } finally { await h.stop(); }
});

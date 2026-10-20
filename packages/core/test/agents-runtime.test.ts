import { expect, spyOn, test } from 'bun:test';
import type { AgentProfile } from '@boite/contracts';
import { quietAgent as quiet, startTestCore, waitFor } from './harness.ts';
import { connect } from '../src/client.ts';
import { Core } from '../src/core.ts';
import { thrown } from './settle.ts';

test('declared shared write resources serialize agents until the holder stops', async () => {
  const h = await startTestCore();
  try {
    const client = await h.connect();
    const account = (await client.call('accounts.list', {})).find(a => a.providerId === 'echo')!;
    const agents: AgentProfile[] = [];
    h.core.workforce.setLimits({ ...h.core.workforce.limits(), paused: true });
    for (const name of ['First', 'Second']) {
      const agent = await client.call('agents.profile.save', { value: { name, domain: '', instructions: '', avatar: '', selection: { providerId: 'echo', accountId: account.id, model: null, effort: null, permissionMode: 'default' }, status: 'active', tools: ['messages'] } });
      agents.push(agent);
      const scope = { kind: 'agent' as const, id: agent.id };
      await client.call('agents.resource.save', { value: { scope, name: 'Shared files', kind: 'directory', value: h.dataDir, access: 'write' } });
      await client.call('agents.message.send', { scope, recipientIds: [], text: '[sleep:60000]', requestId: `shared_resource_${name}` });
    }
    h.core.workforce.setLimits({ ...h.core.workforce.limits(), paused: false });
    await waitFor(() => h.core.workforce.records.list('run').some(r => r.status === 'running'));
    // An unrelated event makes the runtime reconsider the second item while the lock is held.
    h.core.workforce.changed();
    await client.call('agents.snapshot', {});
    expect(h.core.workforce.records.list('run')).toHaveLength(1);
    const work = h.core.workforce.records.list('work')[0]!;
    await client.call('agents.work.control', { workId: work.id, expectedRevision: work.revision, action: 'cancel' });
    await waitFor(() => h.core.workforce.records.list('run').some(r => r.agentId === agents[1]!.id && r.status === 'running'));
    expect(h.core.workforce.records.list('run').filter(r => r.status === 'running')).toHaveLength(1);
  } finally { await h.stop(); }
});

test('a decision continuation consumes the same group turn allowance', async () => {
  const h = await startTestCore();
  try {
    const client = await h.connect();
    const account = (await client.call('accounts.list', {})).find(a => a.providerId === 'echo')!;
    const agent = await client.call('agents.profile.save', { value: { name: 'Worker', domain: '', instructions: '', avatar: '', selection: { providerId: 'echo', accountId: account.id, model: null, effort: null, permissionMode: 'default' }, status: 'active', tools: ['decisions'] } });
    const group = await client.call('agents.group.save', { value: { name: 'One turn', memberIds: [agent.id], mode: 'round', maxTurns: 1, maxTurnsPerAgent: 1, paused: false } });
    await client.call('agents.message.send', { scope: { kind: 'group', id: group.id }, text: '[sleep:60000]', recipientIds: [], requestId: 'group_decision_001' });
    await waitFor(() => h.core.workforce.records.list('run').some(r => r.status === 'running'));
    const run = h.core.workforce.records.list('run')[0]!;
    const worker = await connect(h.url, h.core.agents.tokenFor(run.threadId));
    const decision = await worker.call('agents.decision.request', { threadId: run.threadId, prompt: 'Continue?', options: [], requestId: 'group_decision_002' });
    await waitFor(() => h.core.scheduler.state().running.length === 0);
    await client.call('agents.decision.answer', { decisionId: decision.id, expectedRevision: decision.revision, answer: 'Continue' });
    await waitFor(() => h.core.workforce.records.list('work').some(w => w.status === 'paused'));
    expect(h.core.workforce.records.list('run')).toHaveLength(1);
    expect(h.core.workforce.records.list('work').at(-1)?.error).toContain('Group turn limit');
    worker.close();
  } finally { await h.stop(); }
});

test('autonomous groups take bounded turns and paused groups retain their deliveries', async () => {
  const h = await startTestCore();
  try {
    const client = await h.connect();
    const account = (await client.call('accounts.list', {})).find(a => a.providerId === 'echo')!;
    const agents = [];
    for (const name of ['Researcher', 'Reviewer']) agents.push(await client.call('agents.profile.save', { value: { name, domain: '', instructions: '', avatar: '', selection: { providerId: 'echo', accountId: account.id, model: null, effort: null, permissionMode: 'default' }, status: 'active', tools: ['messages'] } }));
    // The subagent guide would fill the echo driver's 2,000-token window and add compactions to the count.
    for (const agent of agents) await quiet(client, agent);
    const group = await client.call('agents.group.save', { value: { name: 'Ideas', memberIds: agents.map(a => a.id), mode: 'autonomous', maxTurns: 3, maxTurnsPerAgent: 2, paused: true } });
    await client.call('agents.message.send', { scope: { kind: 'group', id: group.id }, recipientIds: [agents[0]!.id], text: 'Discuss the design', requestId: 'bounded_001' });
    expect(h.core.workforce.records.list('work')).toHaveLength(1);
    await client.call('agents.group.save', { id: group.id, expectedRevision: group.revision, value: { ...group, paused: false } });
    await waitFor(() => h.core.workforce.records.list('work').filter(w => w.status === 'done').length === 3, 10000);
    const snapshot = await client.call('agents.snapshot', {});
    expect(snapshot.work).toHaveLength(3);
    expect(snapshot.messages.filter(m => m.senderId !== null).map(m => m.senderId)).toEqual([agents[0]!.id, agents[1]!.id, agents[0]!.id]);
    expect(snapshot.deliveries.at(-1)?.status).toBe('limited');
  } finally { await h.stop(); }
}, 15000);

test('a persistent agent answers without a project and keeps group contexts separate', async () => {
  const h = await startTestCore();
  try {
    const client = await h.connect();
    const account = (await client.call('accounts.list', {})).find(a => a.providerId === 'echo')!;
    const agent = await client.call('agents.profile.save', { value: { name: 'Researcher', domain: '', instructions: 'Be concise.', avatar: '', selection: { providerId: 'echo', accountId: account.id, model: null, effort: null, permissionMode: 'default' }, status: 'active', tools: ['messages', 'memory'] } });
    const group = await client.call('agents.group.save', { value: { name: 'Ideas', memberIds: [agent.id], mode: 'mentions', maxTurns: 6, maxTurnsPerAgent: 2, paused: false } });
    await client.call('agents.message.send', { scope: { kind: 'agent', id: agent.id }, recipientIds: [agent.id], text: 'private greeting', requestId: 'direct_001' });
    await client.call('agents.message.send', { scope: { kind: 'group', id: group.id }, recipientIds: [agent.id], text: 'shared greeting', requestId: 'shared_001' });
    await waitFor(() => h.core.workforce.records.list('work').filter(w => w.status === 'done').length === 2, 10000);
    const snapshot = await client.call('agents.snapshot', {});
    expect(snapshot.sessions).toHaveLength(2);
    expect(new Set(snapshot.sessions.map(s => s.threadId)).size).toBe(2);
    expect(snapshot.messages.filter(m => m.senderId === agent.id)).toHaveLength(2);
    expect(snapshot.deliveries.every(d => d.status === 'processed')).toBe(true);
    expect(h.core.journal.listProjects()).toEqual([]);
    const groupRun = snapshot.runs.find(r => snapshot.sessions.find(s => s.threadId === r.threadId)?.scope.kind === 'group')!;
    expect('instructions' in groupRun.context).toBe(false);
    expect(h.core.workforce.records.get('run', groupRun.id).context.instructions).not.toContain('private greeting');
    const thread = h.core.threads.require(groupRun.threadId);
    expect(thread.projectId).toBeNull();
    expect(await thrown(client.call('turns.start', { threadId: thread.id, prompt: 'bypass scheduling' }))).toThrow('persistent');
    expect((await client.call('agent.where', { threadId: thread.id })).projectId).toBeNull();
    expect(await thrown(client.call('todos.list', { threadId: thread.id }))).toThrow('no project');
  } finally { await h.stop(); }
});

test('an agent saved on the retired Antigravity CLI loads and waits for another model', async () => {
  const h = await startTestCore();
  let next: Core | null = null;
  try {
    const client = await h.connect();
    const account = (await client.call('accounts.list', {})).find(a => a.providerId === 'echo')!;
    const saved = await client.call('agents.profile.save', { value: { name: 'Old', domain: '', instructions: '', avatar: '', selection: { providerId: 'echo', accountId: account.id, model: null, effort: null, permissionMode: 'default' }, status: 'active', tools: ['messages'] } });
    // As an older Boite left it: on the CLI's provider and its default account.
    h.core.journal.putAccount({ id: 'acc_agy', providerId: 'antigravity-cli', label: 'Default', isolationDir: null, status: 'ok', identity: null, createdAt: 1 });
    h.core.workforce.records.update('profile', saved.id, saved.revision, { ...saved, selection: { ...saved.selection, providerId: 'antigravity-cli', accountId: 'acc_agy', model: 'default' } });
    client.close();
    await h.server.stop();
    await h.core.close();

    next = new Core({ dataDir: h.dataDir, token: h.token });
    const agent = next.workforce.snapshot().profiles.find(profile => profile.id === saved.id)!;
    expect(agent.selection.providerId).toBe('antigravity-cli');
    next.workforce.send({ scope: { kind: 'agent', id: agent.id }, recipientIds: [agent.id], text: 'still there?', requestId: 'retired_provider_01' });
    await waitFor(() => next!.workforce.records.list('work').some(work => work.agentId === agent.id && work.status === 'paused'), 10000);
    const work = next.workforce.records.list('work').find(entry => entry.agentId === agent.id)!;
    expect(work.error).toContain('choose another model for this agent');
    expect(next.workforce.records.list('session').filter(session => session.agentId === agent.id)).toEqual([]);
    // The owner picks another model: the save checks it as any choice.
    const moved = next.workforce.saveProfile({ id: agent.id, expectedRevision: agent.revision, value: { ...agent, selection: { ...agent.selection, providerId: 'echo', accountId: account.id, model: null } } });
    expect(moved.selection.providerId).toBe('echo');
  } finally { await next?.close(); await h.stop(); }
});

test('an idle agent runtime reads nothing until a record changes, then starts the new work', async () => {
  const h = await startTestCore();
  try {
    const client = await h.connect();
    const account = (await client.call('accounts.list', {})).find(a => a.providerId === 'echo')!;
    const r = h.core.workforce.records;
    const statusReads = spyOn(r, 'withStatus');
    const listReads = spyOn(r, 'list');
    const settingReads = spyOn(h.core.journal, 'getSetting');
    const limitReads = () => settingReads.mock.calls.filter(call => call[0] === 'agents:limits').length;
    // A tick or two settle it, then three more at 500 ms find it quiet.
    await new Promise(resolve => setTimeout(resolve, 1200));
    const before = { status: statusReads.mock.calls.length, list: listReads.mock.calls.length, limits: limitReads() };
    await new Promise(resolve => setTimeout(resolve, 1600));
    expect(statusReads.mock.calls.length).toBe(before.status);
    expect(listReads.mock.calls.length).toBe(before.list);
    expect(limitReads()).toBe(before.limits);
    const agent = await client.call('agents.profile.save', { value: { name: 'Quiet', domain: '', instructions: '', avatar: '', selection: { providerId: 'echo', accountId: account.id, model: null, effort: null, permissionMode: 'default' }, status: 'active', tools: ['messages'] } });
    await client.call('agents.message.send', { scope: { kind: 'agent', id: agent.id }, recipientIds: [], text: 'Wake up', requestId: 'quiet_runtime_wake' });
    await waitFor(() => r.list('run').some(run => run.status === 'done'));
  } finally { await h.stop(); }
});

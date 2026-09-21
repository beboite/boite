import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { AgentProfile, AgentSave, AgentMissionTask } from '@boite/contracts';
import { startTestCore, type TestCore } from './harness.ts';
import type { CoreClient } from '../src/client.ts';

describe('persistent agents over RPC', () => {
  let h: TestCore;
  let client: CoreClient;
  let profile: AgentSave<AgentProfile>;
  beforeEach(async () => {
    h = await startTestCore(); client = await h.connect();
    h.core.workforce.setLimits({ backgroundConcurrency: 2, paused: true, kebaccExperiment: false });
    const account = (await client.call('accounts.list', {})).find(a => a.providerId === 'echo')!;
    profile = { value: { name: 'Researcher', instructions: 'Explore the requested subject.', domain: 'Research', avatar: 'violet', status: 'active', tools: ['messages', 'missions', 'memory', 'artifacts', 'decisions'], accountIntegration: 'provider', selection: { providerId: 'echo', accountId: account.id, model: null, effort: null, permissionMode: 'default' } } };
  });
  afterEach(async () => { await h.stop(); });

  test('identities, groups and teams persist as distinct objects without projects', async () => {
    const agent = await client.call('agents.profile.save', profile);
    const group = await client.call('agents.group.save', { value: { name: 'Ideas', memberIds: [agent.id], mode: 'mentions', maxTurns: 6, maxTurnsPerAgent: 2, paused: false } });
    const team = await client.call('agents.team.save', { value: { name: 'Studio', description: '', members: [{ agentId: agent.id, responsibility: 'Research' }], projectIds: [], groupId: group.id, paused: false } });
    const snapshot = await client.call('agents.snapshot', {});
    expect(snapshot.profiles[0]?.id).toBe(agent.id);
    expect(snapshot.groups[0]?.id).toBe(group.id);
    expect(snapshot.teams[0]?.id).toBe(team.id);
    expect(await client.call('projects.list', {})).toEqual([]);
    await client.call('agents.profile.save', { id: agent.id, expectedRevision: agent.revision, value: { ...profile.value, domain: 'Design' } });
    expect((await client.call('agents.snapshot', {})).profiles[0]?.id).toBe(agent.id);
    await expect(client.call('agents.profile.save', { id: agent.id, expectedRevision: agent.revision, value: profile.value })).rejects.toThrow('revision');
  });

  test('message retries do not duplicate recipients or work, and a reply chain has one allowance', async () => {
    const agent = await client.call('agents.profile.save', profile);
    const group = await client.call('agents.group.save', { value: { name: 'Ideas', memberIds: [agent.id], mode: 'autonomous', maxTurns: 2, maxTurnsPerAgent: 2, paused: false } });
    const params = { scope: { kind: 'group' as const, id: group.id }, recipientIds: [agent.id], text: 'Explore an idea', requestId: 'message_001' };
    const first = await client.call('agents.message.send', params);
    expect(await client.call('agents.message.send', params)).toEqual(first);
    const second = await client.call('agents.message.send', { ...params, replyTo: first.id, requestId: 'message_002' });
    const third = await client.call('agents.message.send', { ...params, replyTo: second.id, requestId: 'message_003' });
    const snapshot = await client.call('agents.snapshot', {});
    expect(snapshot.messages).toHaveLength(3);
    expect(snapshot.deliveries).toHaveLength(3);
    expect(snapshot.work).toHaveLength(2);
    expect(third.episodeId).toBe(first.episodeId);
    await expect(client.call('agents.message.send', { ...params, text: 'Changed input' })).rejects.toThrow('different');
  });

  test('mentions require a recipient, and group membership does not permit unrelated recipients', async () => {
    const agent = await client.call('agents.profile.save', profile);
    const other = await client.call('agents.profile.save', { value: { ...profile.value, name: 'Other' } });
    const group = await client.call('agents.group.save', { value: { name: 'Ideas', memberIds: [agent.id], mode: 'mentions', maxTurns: 6, maxTurnsPerAgent: 2, paused: false } });
    const params = { scope: { kind: 'group' as const, id: group.id }, recipientIds: [], text: 'For the record', requestId: 'message_001' };
    await client.call('agents.message.send', params);
    expect((await client.call('agents.snapshot', {})).work).toHaveLength(0);
    await expect(client.call('agents.message.send', { ...params, recipientIds: [other.id], requestId: 'message_002' })).rejects.toThrow('recipient');
  });

  test('task acquisition is exclusive, waits for dependencies and rejects stale submissions', async () => {
    const agent = await client.call('agents.profile.save', profile);
    const other = await client.call('agents.profile.save', { value: { ...profile.value, name: 'Reviewer' } });
    const mission = await client.call('agents.mission.save', { value: { title: 'Prototype', objective: 'Build a small prototype', expectedResult: 'Code and verification', agentIds: [agent.id, other.id], teamId: null, projectId: null, status: 'open', maxTurns: 10, maxDurationMs: 60000, maxTokens: null, resourceIds: [] } });
    const draft: AgentSave<AgentMissionTask> = { value: { missionId: mission.id, title: 'Build', instructions: '', dependsOn: [], assigneeId: null, status: 'open', generation: 0, leaseUntil: null, workspace: null, result: null } };
    const first = await client.call('agents.task.save', draft);
    const second = await client.call('agents.task.save', { value: { ...draft.value, title: 'Review', dependsOn: [first.id] } });
    await expect(client.call('agents.task.acquire', { taskId: second.id, agentId: other.id, expectedRevision: second.revision })).rejects.toThrow('dependencies');
    const acquired = await client.call('agents.task.acquire', { taskId: first.id, agentId: agent.id, expectedRevision: first.revision });
    await expect(client.call('agents.task.acquire', { taskId: first.id, agentId: other.id, expectedRevision: first.revision })).rejects.toThrow('already assigned');
    await expect(client.call('agents.task.submit', { taskId: first.id, generation: 0, result: 'stale result' })).rejects.toThrow('stale');
    const submitted = await client.call('agents.task.submit', { taskId: first.id, generation: acquired.generation, result: 'Built and checked' });
    expect(submitted.status).toBe('review');
    await expect(client.call('agents.task.acquire', { taskId: second.id, agentId: other.id, expectedRevision: second.revision })).rejects.toThrow('dependencies');
    await client.call('agents.task.save', { id: submitted.id, expectedRevision: submitted.revision, value: { ...submitted, status: 'done' } });
    expect((await client.call('agents.task.acquire', { taskId: second.id, agentId: other.id, expectedRevision: second.revision })).assigneeId).toBe(other.id);
  });

  test('another group context cannot read private group memory even for a common member', async () => {
    const agent = await client.call('agents.profile.save', profile);
    const makeGroup = (name: string) => client.call('agents.group.save', { value: { name, memberIds: [agent.id], mode: 'mentions', maxTurns: 6, maxTurnsPerAgent: 2, paused: false } });
    const first = await makeGroup('Private'); const second = await makeGroup('Shared');
    const source = { kind: 'group' as const, id: first.id };
    const target = { kind: 'group' as const, id: second.id };
    expect(h.core.workforce.canRead(agent.id, source, target)).toBe(false);
    expect(h.core.workforce.canRead(agent.id, source, source)).toBe(true);
  });

  test('the kebacc experiment cannot create an internal account switching path', async () => {
    await expect(client.call('agents.profile.save', { value: { ...profile.value, accountIntegration: 'kebacc-experiment' } })).rejects.toThrow('experiment');
    await client.call('agents.limits.set', { backgroundConcurrency: 2, paused: false, kebaccExperiment: true });
    await expect(client.call('agents.profile.save', { value: { ...profile.value, accountIntegration: 'kebacc-experiment' } })).rejects.toThrow('Antigravity CLI');
    expect((await client.call('agents.snapshot', {})).profiles).toHaveLength(0);
  });

  test('an unused provider account still belongs to its persistent profile', async () => {
    await client.call('agents.profile.save', profile);
    await expect(client.call('accounts.remove', { accountId: profile.value.selection.accountId })).rejects.toThrow('persistent agent');
  });

  test('directory resources must exist and have an absolute path', async () => {
    const agent = await client.call('agents.profile.save', profile);
    const value = { scope: { kind: 'agent' as const, id: agent.id }, name: 'Files', kind: 'directory' as const, value: 'missing-relative-directory', access: 'write' as const };
    await expect(client.call('agents.resource.save', { value })).rejects.toThrow('absolute');
    const resource = await client.call('agents.resource.save', { value: { ...value, value: h.dataDir } });
    expect(resource.value).toBe(h.dataDir);
  });
});

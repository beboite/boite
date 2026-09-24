import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { Core } from '../src/core.ts';
import { connect } from '../src/client.ts';
import { startTestCore, waitFor, removeDir, type TestCore } from './harness.ts';

async function fixture(h: TestCore) {
  const client = await h.connect();
  const path = join(h.dataDir, 'project'); mkdirSync(path);
  for (const args of [['init', '-q'], ['commit', '--allow-empty', '-qm', 'Initial fixture']]) {
    const spawned = h.core.procs.spawn('fixture', 'git', args, { cwd: path, env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'boite test', GIT_AUTHOR_EMAIL: 'test@boite.invalid',
      GIT_COMMITTER_NAME: 'boite test', GIT_COMMITTER_EMAIL: 'test@boite.invalid',
    } });
    const [code, error] = await Promise.all([spawned.exited, new Response(spawned.proc.stderr).text(), new Response(spawned.proc.stdout).text()]);
    if (code !== 0) throw new Error(error);
  }
  const project = await client.call('projects.add', { path, name: 'Prototype' });
  const account = (await client.call('accounts.list', {})).find(a => a.providerId === 'echo')!;
  const agent = await client.call('agents.profile.save', { value: { name: 'Builder', domain: '', instructions: '', avatar: '', selection: { providerId: 'echo', accountId: account.id, model: null, effort: null, permissionMode: 'default' }, status: 'active', tools: ['missions', 'artifacts', 'decisions'], accountIntegration: 'provider' } });
  const mission = await client.call('agents.mission.save', { value: { title: 'Prototype', objective: 'Build it', expectedResult: 'Source and checks', agentIds: [agent.id], teamId: null, projectId: project.id, status: 'open', maxTurns: 10, maxDurationMs: 60000, maxTokens: null, resourceIds: [] } });
  const task = await client.call('agents.task.save', { value: { missionId: mission.id, title: 'Build', instructions: '[sleep:60000]', dependsOn: [], assigneeId: null, status: 'open', generation: 0, leaseUntil: null, workspace: null, result: null } });
  return { client, agent, mission, task, project };
}

test('mission artifacts retry after completion, review waits for execution and tasks reuse their isolated workspace', async () => {
  const h = await startTestCore();
  try {
    const { client, agent, mission, task, project } = await fixture(h);
    const assigned = await client.call('agents.task.acquire', { taskId: task.id, agentId: agent.id, expectedRevision: task.revision });
    await waitFor(() => h.core.workforce.records.list('run').some(r => r.status === 'running'));
    const run = h.core.workforce.records.list('run')[0]!;
    const thread = h.core.threads.require(run.threadId);
    expect(thread.cwd).not.toBe(project.path);
    expect(thread.branch).toStartWith('boite/agent-');
    await expect(client.call('projects.remove', { projectId: project.id })).rejects.toThrow('persistent agents');
    const agentClient = await connect(h.url, h.core.agents.tokenFor(thread.id));
    const file = join(thread.cwd, 'prototype.txt'); writeFileSync(file, 'Prototype result');
    const request = { threadId: thread.id, requestId: 'artifact_mission_001', value: { missionId: mission.id, taskId: task.id, title: 'Prototype', summary: 'Ready for review', paths: ['prototype.txt'], commit: null, verification: 'Read the generated file' } };
    const artifact = await agentClient.call('agents.artifact.add', request);
    const submitted = await agentClient.call('agents.task.submit', { threadId: thread.id, taskId: task.id, generation: assigned.generation, result: 'Ready' });
    await expect(client.call('agents.task.save', { id: task.id, expectedRevision: submitted.revision, value: { ...submitted, status: 'done' } })).rejects.toThrow('execution');
    const decision = await agentClient.call('agents.decision.request', { threadId: thread.id, prompt: 'Review the artifact', options: [], requestId: 'mission_decision_001' });
    await waitFor(() => h.core.scheduler.state().running.length === 0);
    unlinkSync(file);
    expect(await agentClient.call('agents.artifact.add', request)).toEqual(artifact);
    await client.call('agents.decision.answer', { decisionId: decision.id, expectedRevision: decision.revision, answer: 'Finish with the current result.' });
    await waitFor(() => h.core.workforce.records.get('task', task.id).status === 'review');
    const reviewed = h.core.workforce.records.get('task', task.id);
    await client.call('agents.task.save', { id: task.id, expectedRevision: reviewed.revision, value: { ...reviewed, status: 'done' } });
    const second = await client.call('agents.task.save', { value: { ...task, title: 'Inspect', instructions: 'Inspect the result', dependsOn: [task.id] } });
    await client.call('agents.task.acquire', { taskId: second.id, agentId: agent.id, expectedRevision: second.revision });
    await waitFor(() => h.core.workforce.records.get('task', second.id).status === 'review');
    expect(h.core.workforce.records.get('task', second.id).workspace).toEqual({ path: thread.cwd, branch: thread.branch });
    expect(h.core.workforce.records.list('session')).toHaveLength(1);
    agentClient.close();
  } finally { await h.stop(); }
}, 20000);

test('shutdown during workspace preparation leaves one durable branch for recovery', async () => {
  const h = await startTestCore();
  let next: Core | undefined;
  try {
    const { client, agent, task } = await fixture(h);
    const ensure = h.core.worktrees.ensure.bind(h.core.worktrees);
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let prepared: { path: string; branch: string } | undefined;
    h.core.worktrees.ensure = async (...args) => { prepared = await ensure(...args); await held; return prepared; };
    await client.call('agents.task.acquire', { taskId: task.id, agentId: agent.id, expectedRevision: task.revision });
    await waitFor(() => !!prepared);
    const closing = h.core.agentRuntime.close();
    release(); await closing;
    expect(h.core.workforce.records.list('session')).toHaveLength(0);
    await h.server.stop(); await h.core.close();
    next = new Core({ dataDir: h.dataDir, token: h.token });
    await waitFor(() => next!.workforce.records.list('run').some(r => r.status === 'running'));
    const session = next.workforce.records.list('session')[0]!;
    expect(next.threads.require(session.threadId).cwd).toBe(prepared!.path);
    expect(next.threads.require(session.threadId).branch).toBe(prepared!.branch);
    expect(next.workforce.records.list('run')).toHaveLength(1);
  } finally {
    if (next) { await next.close(); await removeDir(h.dataDir); }
    else await h.stop();
  }
}, 20000);

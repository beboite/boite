import { afterEach, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_DELEGATION_CONFIG, resolveContext } from '@boite/contracts';
import { echoThread, startTestCore, waitFor, type TestCore } from './harness.ts';
import { makeAgent, scripted } from './agent-fixture.ts';
import { thrown } from './settle.ts';

const cores: TestCore[] = [];
const restores: (() => void)[] = [];
afterEach(async () => { for (const h of cores.splice(0)) await h.stop(); for (const restore of restores.splice(0)) restore(); });

async function setup(count = 1) {
  const h = await startTestCore(); cores.push(h);
  const client = await h.connect();
  const projects = [];
  for (const name of ['First', 'Second', 'Outside']) {
    const path = join(h.dataDir, name);
    mkdirSync(path);
    projects.push(await client.call('projects.add', { name, path }));
  }
  let { agent, threadId } = await makeAgent(h, client, { projectIds: projects.slice(0, count).map(p => p.id) });
  const config = { ...DEFAULT_DELEGATION_CONFIG, enabled: true, profiles: [{ id: 'worker', name: 'Worker', ...agent.selection, model: 'echo' }] };
  agent = await client.call('agents.runtime.configure', { agentId: agent.id, expectedRevision: agent.revision, config: {
    defaultRoute: agent.selection, allowedRoutes: [{ id: 'main', name: 'Main', ...agent.selection, model: 'echo' }], subagents: config, autoMemory: false, dailyBudgetUsd: null,
  } });
  const parent = h.core.threads.require(threadId);
  h.core.journal.putThread({ ...parent, branch: 'personal-brain' });
  const spawn = (requestId: string, project?: string) => client.call('delegation.spawn', { threadId, profileId: 'worker', task: 'Inspect the project', requestId, ...(project === undefined ? {} : { project }) });
  const grant = async (projectIds: string[]) => {
    const current = h.core.workforce.records.get('profile', agent.id);
    agent = await client.call('agents.profile.save', { id: agent.id, expectedRevision: current.revision, value: { ...current, projectIds } });
  };
  return { h, client, projects, agent, threadId, parent: h.core.threads.require(threadId), spawn, grant };
}

test('a bot delegates into its sole entrusted project and keeps route ownership and result delivery', async () => {
  const s = await setup();
  const seen = new Map<string, string>();
  const driver = scripted(ctx => { seen.set(ctx.thread.id, ctx.thread.cwd); return { text: 'Project inspected' }; });
  restores.push(driver.restore);
  const child = await s.spawn('sole');
  expect(child.thread).toMatchObject({ projectId: s.projects[0]!.id, cwd: s.projects[0]!.path, branch: null, parentThreadId: s.threadId });
  expect(child.thread.agentSessionId).toBeUndefined();
  expect(s.h.core.workforce.resident.ownerOf(child.thread.id)).toBe(s.agent.id);
  await waitFor(() => s.h.core.delegation.get(s.threadId).messages.some(letter => letter.origin === 'result'));
  expect(seen.get(child.thread.id)).toBe(s.projects[0]!.path);
  expect(driver.prompts.get(s.threadId)?.join('\n')).toContain('Project inspected');
  await s.client.call('agents.accounts.set', { grants: [{ accountId: s.agent.selection.accountId, agentIds: [] }] });
  expect(s.h.core.workforce.resident.allowed(s.agent.id, child.thread, true)).toBe(false);
});

test('a bot with several projects selects an entrusted project by id, name or path', async () => {
  const s = await setup(2);
  const target = s.projects[1]!;
  for (const [index, project] of [target.id, target.name, target.path].entries()) {
    const child = await s.spawn(`explicit-${index}`, project);
    expect(child.thread).toMatchObject({ projectId: target.id, cwd: target.path, branch: null, parentThreadId: s.threadId });
  }
  expect(await thrown(s.spawn('outside', s.projects[2]!.id))).toThrow('entrusted');
  expect(await thrown(s.spawn('unknown', 'missing-project'))).toThrow('project');
  expect(await thrown(s.spawn('invalid', 4 as unknown as string))).toThrow('project');
  await s.client.call('projects.archive', { projectId: target.id, archived: true });
  expect(await thrown(s.spawn('archived', target.id))).toThrow('entrusted');
  const child = await s.spawn('remaining');
  expect(child.thread.projectId).toBe(s.projects[0]!.id);
});

test('bot retries keep their original project and explicit project participates in idempotency', async () => {
  const s = await setup(0);
  const personal = await s.spawn('old-default');
  expect(personal.thread).toMatchObject({ projectId: null, cwd: s.parent.cwd });
  await s.grant([s.projects[0]!.id]);
  expect((await s.spawn('old-default')).thread.id).toBe(personal.thread.id);
  expect((await s.spawn('new-default')).thread.projectId).toBe(s.projects[0]!.id);
  const explicit = await s.spawn('explicit', s.projects[0]!.id);
  await s.grant([s.projects[1]!.id]);
  expect((await s.spawn('explicit', s.projects[0]!.id)).thread.id).toBe(explicit.thread.id);
  expect(await thrown(s.spawn('explicit', s.projects[1]!.id))).toThrow('different content');
  expect(await thrown(s.spawn('explicit'))).toThrow('different content');
  await s.grant([s.projects[0]!.id, s.projects[1]!.id]);
  expect((await s.spawn('ambiguous-default')).thread).toMatchObject({ projectId: null, cwd: s.parent.cwd });
});

test('ordinary delegation preserves the parent checkout and refuses an explicit different project', async () => {
  const s = await setup();
  const { threadId } = await echoThread(s.h, s.client);
  const parent = s.h.core.threads.require(threadId);
  const cwd = join(s.h.core.projects.require(parent.projectId).path, 'nested');
  mkdirSync(cwd);
  s.h.core.journal.putThread({ ...parent, cwd, branch: 'existing-parent-branch' });
  await s.client.call('delegation.configure', { threadId, config: { ...DEFAULT_DELEGATION_CONFIG, enabled: true } });
  const own = s.h.core.projects.require(parent.projectId);
  for (const [index, project] of [undefined, own.id, own.name, own.path].entries()) {
    const child = await s.client.call('delegation.spawn', { threadId, project, task: 'Inspect checkout', requestId: `ordinary-${index}` });
    expect(child.thread).toMatchObject({ projectId: parent.projectId, cwd, branch: 'existing-parent-branch', parentThreadId: threadId });
  }
  expect(await thrown(s.client.call('delegation.spawn', { threadId, project: s.projects[0]!.id, task: 'Inspect checkout', requestId: 'cross-project' }))).toThrow('project');
});

test('workflow children use the sole bot project while fixed memory children stay personal', async () => {
  const s = await setup();
  const route = s.h.core.delegation.resolve(s.threadId, { profileId: 'worker' });
  const workflowId = s.h.core.delegation.createChild(s.parent, route, 'Workflow', () => {});
  expect(s.h.core.threads.require(workflowId)).toMatchObject({ projectId: s.projects[0]!.id, cwd: s.projects[0]!.path, branch: null, parentThreadId: s.threadId });
  const memoryId = s.h.core.delegation.createChild(s.parent, route, 'Memory', () => {}, undefined, false, {
    contextMode: { ...resolveContext({ preset: 'neutral' })!, tools: [] }, permissionMode: 'plan',
  });
  expect(s.h.core.threads.require(memoryId)).toMatchObject({ projectId: null, cwd: s.parent.cwd, parentThreadId: s.threadId, permissionMode: 'plan' });
});

test('archived bot project children count in their project while ordinary subagents stay out', async () => {
  const s = await setup();
  const child = await s.spawn('archive-bot');
  await waitFor(() => s.h.core.threads.require(child.thread.id).archived);
  await s.client.call('threads.archive', { threadId: child.thread.id, archived: false });
  const updates: { archivedThreads?: number; doneThreads?: number }[] = [];
  const off = s.h.core.bus.onCommitted((name, payload) => {
    if (name === 'project.updated' && (payload as { id: string }).id === s.projects[0]!.id) updates.push(payload as typeof updates[number]);
  });
  restores.push(off);
  await s.client.call('threads.archive', { threadId: child.thread.id, onlyIfIdle: true });
  const project = s.projects[0]!;
  expect(updates.at(-1)).toMatchObject({ archivedThreads: 1, doneThreads: 1 });
  expect(s.h.core.journal.archivedThreadCounts().get(project.id)).toEqual({ archived: 1, done: 1 });
  expect((await s.client.call('threads.list', { projectId: project.id, includeArchived: true })).some(t => t.id === child.thread.id && t.archived && t.doneAt)).toBe(true);
  const ordinary = await s.client.call('threads.create', { projectId: project.id, ...s.agent.selection, model: 'echo' });
  await s.client.call('delegation.configure', { threadId: ordinary.id, config: { ...DEFAULT_DELEGATION_CONFIG, enabled: true } });
  const sub = await s.client.call('delegation.spawn', { threadId: ordinary.id, task: 'Read a file', requestId: 'archive-ordinary' });
  expect(sub.thread.parentIsBot).toBeUndefined();
  await waitFor(() => s.h.core.threads.require(sub.thread.id).status === 'idle');
  await s.client.call('threads.archive', { threadId: sub.thread.id });
  expect(s.h.core.journal.archivedThreadCounts().get(project.id)).toEqual({ archived: 1, done: 1 });
  // Changing Done to Archived also updates the project without an archive-state transition.
  await s.client.call('threads.archive', { threadId: child.thread.id });
  expect(s.h.core.journal.archivedThreadCounts().get(project.id)).toEqual({ archived: 1, done: 0 });
  expect(updates.at(-1)?.doneThreads).toBeUndefined();
  await s.client.call('threads.archive', { threadId: child.thread.id, archived: false });
  await s.client.call('threads.archive', { threadId: child.thread.id });
  expect(s.h.core.journal.archivedThreadCounts().get(project.id)).toEqual({ archived: 1, done: 0 });
  expect(updates.at(-1)).toMatchObject({ archivedThreads: 1 });
  // A reconnect does not list the archived bot, but its restored worker still identifies its parent.
  await s.client.call('threads.archive', { threadId: s.threadId });
  await s.client.call('threads.archive', { threadId: child.thread.id, archived: false });
  const fresh = await s.client.call('threads.list', {});
  expect(fresh.some(t => t.id === s.threadId)).toBe(false);
  expect(fresh.find(t => t.id === child.thread.id)).toMatchObject({ parentThreadId: s.threadId, parentIsBot: true });
  expect(s.h.core.journal.getThread(child.thread.id)?.parentIsBot).toBe(true);
});

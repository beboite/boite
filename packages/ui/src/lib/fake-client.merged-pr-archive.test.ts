import { afterEach, expect, test, vi } from 'vitest';
import { RpcErrorCode } from '@boite/contracts';
import { FakeClient } from './fake-client';
import { sweepMergedPrFixtures, type MergedPrFixture } from './fake-client/merged-pr-archive';
import { FakeContext } from './fake-client/context';
import { seed } from './fake-client/seed';
import { threadMethods } from './fake-client/threads';
import { closeSideQuestions } from './fake-client/side-questions';
let client: FakeClient;
afterEach(() => client?.close());
async function fixture() {
  client?.close();
  client = new FakeClient({ delayMs: 0 }); await client.connect();
  const project = await client.call('projects.add', { path: '/workspace/archive-fixture' });
  const account = (await client.call('accounts.list', {})).find(account => account.providerId === 'echo')!;
  const thread = await client.call('threads.create', { projectId: project.id, providerId: 'echo', accountId: account.id, worktree: { branch: 'topic-fixture' }, title: 'merged fixture' });
  const proof: MergedPrFixture = { repository: 'github.com/example/repo', branch: thread.branch!, tip: 'a'.repeat(40), clean: true, candidates: [{ repository: 'github.com/example/repo', branch: thread.branch!, sha: 'a'.repeat(40), number: 7, url: 'https://github.com/example/repo/pull/7', mergedAt: '2026-10-01T12:00:00Z' }] };
  client.setMergedPrFixture(thread.id, proof);
  return { project, thread, proof };
}

async function completedWorkflow() {
  const f = await fixture();
  const run = await client.call('workflows.start', { threadId: f.thread.id, requestId: 'archive-family-workflow', plan: { name: 'Completed family', steps: [{ id: 'review', task: 'Review the merged change.' }] } });
  await expect.poll(async () => (await client.call('workflows.get', { threadId: f.thread.id, runId: run.id })).status).toBe('done');
  const finished = await client.call('workflows.get', { threadId: f.thread.id, runId: run.id });
  const child = await client.call('threads.get', { threadId: finished.nodes[0]!.instances[0]!.threadId! });
  expect(child.turns.at(-1)?.status).toBe('done');
  await client.call('threads.markRead', { threadId: child.id });
  await client.call('threads.markRead', { threadId: f.thread.id });
  return { ...f, child };
}

/** Legacy retained depth is seeded in the domain, without adding a client fixture API. */
async function retainedDescendants() {
  const ctx = new FakeContext({ delayMs: 0 });
  seed(ctx);
  ctx.bus.setState('ready');
  const methods = threadMethods(ctx);
  const summary = await methods['threads.create']({ projectId: 'p-boite', providerId: 'echo', accountId: 'a-echo',
    worktree: { branch: 'retained-depth-fixture' }, title: 'Retained descendants' });
  const root = ctx.thread(summary.id);
  const now = ctx.now();
  const child = { ...structuredClone(root), id: 't-retained-child', parentThreadId: root.id,
    turns: [{ id: 'turn-retained-child', threadId: 't-retained-child', status: 'done' as const, queuedAt: now, startedAt: now, finishedAt: now, usage: null, error: null }] };
  const descendant = { ...structuredClone(child), id: 't-retained-descendant', parentThreadId: child.id,
    turns: [{ ...child.turns[0]!, id: 'turn-retained-descendant', threadId: 't-retained-descendant' }] };
  ctx.threads.set(child.id, child);
  ctx.threads.set(descendant.id, descendant);
  ctx.mergedPrFixtures.set(root.id, { repository: 'github.com/example/repo', branch: root.branch!, tip: 'a'.repeat(40), clean: true,
    candidates: [{ repository: 'github.com/example/repo', branch: root.branch!, sha: 'a'.repeat(40), number: 7,
      url: 'https://github.com/example/repo/pull/7', mergedAt: '2026-10-01T12:00:00Z' }] });
  return { ctx, methods, root, child, descendant };
}

test('fake deeper retained descendant quiescence protects the root after side state is dismissed', async () => {
  const { ctx, methods, root, descendant } = await retainedDescendants();
  vi.useFakeTimers();
  try {
    const requestId = 'side_deep_quiescence';
    await methods['threads.btw']({ threadId: descendant.id, requestId, question: 'A retained answer' });
    await vi.advanceTimersByTimeAsync(0);
    await methods['threads.btw.cancel']({ threadId: descendant.id, requestId });
    descendant.unread = true;
    expect(await sweepMergedPrFixtures(ctx)).toBe(0);
    expect(root.archived).toBe(false);
    descendant.unread = false;
    descendant.status = 'running';
    expect(await sweepMergedPrFixtures(ctx)).toBe(0);
    descendant.status = 'idle';
    ctx.bus.protectedThreadIds.add(descendant.id);
    expect(await sweepMergedPrFixtures(ctx)).toBe(0);
    ctx.bus.protectedThreadIds.clear();
    expect(await sweepMergedPrFixtures(ctx)).toBe(1);
  } finally { closeSideQuestions(ctx); vi.useRealTimers(); }
});

test.each(['pending', 'completed'] as const)('fake removal releases %s side state throughout retained descendants without deleting their history', async state => {
  const { ctx, methods, root, child, descendant } = await retainedDescendants();
  const before = structuredClone(descendant);
  const answers: unknown[] = [];
  ctx.bus.on('thread.btw', answer => answers.push(answer));
  vi.useFakeTimers();
  try {
    const requestId = 'side_deep_remove';
    await methods['threads.btw']({ threadId: descendant.id, requestId, question: 'Pending during deletion' });
    if (state === 'completed') await vi.advanceTimersByTimeAsync(0);
    await methods['threads.remove']({ threadId: root.id });
    const expected = state === 'pending'
      ? { threadId: descendant.id, requestId, answer: null, error: 'side request cancelled' }
      : { threadId: descendant.id, requestId, answer: 'Side answer: Pending during deletion', error: null };
    expect(answers).toEqual([expected]);
    await vi.advanceTimersByTimeAsync(0);
    expect(answers).toEqual([expected]);
    expect(ctx.deletedThreads.get(root.id)!.threads.map(thread => thread.id)).toEqual([root.id, child.id]);
    expect(ctx.thread(descendant.id)).toEqual(before);
    await methods['threads.restore']({ threadId: root.id });
    await expect(methods['threads.btw.fork']({ threadId: descendant.id, requestId })).rejects.toThrow('available completed');
    expect(ctx.thread(descendant.id)).toEqual(before);
  } finally { closeSideQuestions(ctx); vi.useRealTimers(); }
});

test('fake archives a completed retained workflow family, preserving children and restore', async () => {
  const { thread, child } = await completedWorkflow();
  expect(await client.sweepMergedPrArchives()).toBe(1);
  expect((await client.call('threads.get', { threadId: child.id })).turns).toEqual(child.turns);
  expect((await client.call('threads.get', { threadId: child.id })).archived).toBe(child.archived);
  await client.call('threads.archive', { threadId: thread.id, archived: false });
  expect(await client.sweepMergedPrArchives()).toBe(0);
  const next = await client.call('turns.start', { threadId: child.id, prompt: 'Explicit work after restore' });
  expect(next.threadId).toBe(child.id);
});

test('fake retained child input, pin and late turn admission protect the family', async () => {
  const { thread, child, proof } = await completedWorkflow();
  await client.call('threads.pin', { threadId: child.id, pinned: true });
  expect(await client.sweepMergedPrArchives()).toBe(0);
  await client.call('threads.pin', { threadId: child.id, pinned: false });
  await client.call('threads.focus', { threadId: null, protectedThreadIds: [child.id] });
  expect(await client.sweepMergedPrArchives()).toBe(0);
  await client.call('threads.focus', { threadId: child.id, protectedThreadIds: [] });
  expect(await client.sweepMergedPrArchives()).toBe(0);
  await client.call('threads.focus', { threadId: null });
  proof.beforeValidate = async () => { await client.call('turns.start', { threadId: child.id, prompt: 'Late child work [permission]' }); };
  expect(await client.sweepMergedPrArchives()).toBe(0);
  expect((await client.call('threads.get', { threadId: thread.id })).archived).toBe(false);
  expect((await client.call('threads.get', { threadId: child.id })).status).toBe('waiting');
});

test('fake archived parent rejects late child turns, messages and new delegation before retaining any work', async () => {
  const { thread, child } = await completedWorkflow();
  await client.call('threads.archive', { threadId: thread.id, archived: true });
  const history = (await client.call('threads.get', { threadId: child.id })).turns;
  await expect(client.call('turns.start', { threadId: child.id, prompt: 'Late child work' })).rejects.toMatchObject({ code: RpcErrorCode.Refused });
  await expect(client.call('delegation.send', { threadId: child.id, toThreadId: thread.id, text: 'Late result', requestId: 'late-family-result' })).rejects.toMatchObject({ code: RpcErrorCode.Refused });
  await expect(client.call('delegation.spawn', { threadId: thread.id, profileId: 'conversation', task: 'Late task', requestId: 'late-family-task' })).rejects.toMatchObject({ code: RpcErrorCode.Refused });
  expect((await client.call('threads.get', { threadId: child.id })).turns).toEqual(history);
});

test('fake hides only proven merged worktree, preserves reason, and restore dismisses repeated results', async () => {
  const { project, thread } = await fixture();
  const changed: unknown[] = [];
  client.on('project.updated', row => changed.push(row));
  expect(await client.sweepMergedPrArchives()).toBe(1);
  expect(changed).toContainEqual(expect.objectContaining({ id: project.id, autoArchiveMergedPr: true }));
  const archived = await client.call('threads.get', { threadId: thread.id });
  expect(archived.archiveReason).toMatchObject({ type: 'pr-merged', number: 7 });
  expect(archived.cwd).toBe(thread.cwd);
  await client.call('threads.archive', { threadId: thread.id, archived: false });
  expect(await client.sweepMergedPrArchives()).toBe(0);
  expect((await client.call('threads.get', { threadId: thread.id })).archiveReason).toBeUndefined();
});

test('fake validates proof and protects busy, viewed, pending input and paused workflow fixtures', async () => {
  const { project, thread, proof } = await fixture();
  const original = structuredClone(proof);
  for (const patch of [{ clean: false }, { tip: 'b'.repeat(40) }, { branch: 'wrong' }, { candidates: [proof.candidates[0]!, proof.candidates[0]!] }, { candidates: [null] }, { candidates: [{}] }, { workflowActive: true }]) {
    Object.assign(proof, original, patch); expect(await client.sweepMergedPrArchives()).toBe(0);
  }
  Object.assign(proof, original);
  proof.workflowActive = false;
  await client.call('threads.pin', { threadId: thread.id, pinned: true }); expect(await client.sweepMergedPrArchives()).toBe(0);
  await client.call('threads.pin', { threadId: thread.id, pinned: false });
  await client.call('threads.focus', { threadId: null });
  expect(await client.sweepMergedPrArchives()).toBe(0);
  expect((await client.call('threads.get', { threadId: thread.id })).archived).toBe(false);
  await client.call('threads.focus', { threadId: thread.id }); expect(await client.sweepMergedPrArchives()).toBe(0);
  await client.call('threads.focus', { threadId: null, protectedThreadIds: [thread.id] }); expect(await client.sweepMergedPrArchives()).toBe(0);
  await client.call('threads.focus', { threadId: null }); expect(await client.sweepMergedPrArchives()).toBe(0);
  await client.call('threads.focus', { threadId: null, protectAllThreads: false }); expect(await client.sweepMergedPrArchives()).toBe(0);
  await client.call('threads.focus', { threadId: null, protectAllThreads: true }); expect(await client.sweepMergedPrArchives()).toBe(0);
  await client.call('threads.focus', { threadId: null, protectedThreadIds: [] }); expect(await client.sweepMergedPrArchives()).toBe(0);
  await client.call('threads.focus', { threadId: null, protectAllThreads: false }); expect(await client.sweepMergedPrArchives()).toBe(1);

  const reconnected = await client.call('threads.create', { projectId: project.id, providerId: thread.providerId, accountId: thread.accountId, worktree: { branch: 'topic-reconnected' } });
  const reconnectProof: MergedPrFixture = { ...proof, branch: reconnected.branch!, candidates: proof.candidates.map(candidate => ({ ...candidate, branch: reconnected.branch! })) };
  client.setMergedPrFixture(reconnected.id, reconnectProof);
  await client.call('threads.focus', { threadId: null, protectedThreadIds: [reconnected.id] });
  client.drop();
  await client.restore();
  await client.call('threads.focus', { threadId: null });
  expect(await client.sweepMergedPrArchives()).toBe(0);
  await client.call('threads.focus', { threadId: null, protectAllThreads: false });
  expect(await client.sweepMergedPrArchives()).toBe(1);
});

test('fake stale policy, restore and checkout evidence cannot hide conversation', async () => {
  const { project, thread, proof } = await fixture();
  proof.beforeValidate = async () => { await client.call('projects.setAutoArchiveMergedPr', { projectId: project.id, enabled: false }); };
  expect(await client.sweepMergedPrArchives()).toBe(0);
  await client.call('projects.setAutoArchiveMergedPr', { projectId: project.id, enabled: true });
  proof.beforeValidate = async () => { await client.call('threads.archive', { threadId: thread.id, archived: false }); };
  expect(await client.sweepMergedPrArchives()).toBe(0);
  expect(await client.sweepMergedPrArchives()).toBe(0);
  // Mutations check repository freshness and immutable accepted evidence;
  // replacements check that validation reads the current checkout evidence.
  for (const change of ['mutated-repository', 'replaced-repository', 'replaced-dirty', 'advanced-tip-and-candidate'] as const) {
    const next = await fixture();
    next.proof.beforeValidate = async () => {
      if (change === 'mutated-repository') next.proof.repository = 'github.com/other/repo';
      else if (change === 'advanced-tip-and-candidate') {
        next.proof.tip = 'b'.repeat(40);
        next.proof.candidates[0]!.sha = next.proof.tip;
      } else client.setMergedPrFixture(next.thread.id, {
        ...next.proof,
        ...(change === 'replaced-repository' ? { repository: 'github.com/other/repo' } : { clean: false }),
      });
    };
    expect.soft(await client.sweepMergedPrArchives(), change).toBe(0);
    const retained = await client.call('threads.get', { threadId: next.thread.id });
    expect.soft(retained.archived, change).toBe(false);
    expect.soft(retained.archiveReason, change).toBeUndefined();
    expect.soft(retained.cwd, change).toBe(next.thread.cwd);
  }
  const compatible = await fixture();
  compatible.proof.beforeValidate = async () => {
    client.setMergedPrFixture(compatible.thread.id, { ...compatible.proof });
  };
  expect(await client.sweepMergedPrArchives()).toBe(1);
});

test('fake stale move and deletion responses leave their new state intact', async () => {
  for (const action of ['move', 'delete'] as const) {
    const { thread, proof } = await fixture();
    proof.beforeValidate = async () => {
      if (action === 'delete') await client.call('threads.remove', { threadId: thread.id });
      else {
        const project = await client.call('projects.add', { path: '/workspace/moved-project' });
        await client.call('threads.move', { threadId: thread.id, projectId: project.id });
      }
    };
    expect(await client.sweepMergedPrArchives()).toBe(0);
    if (action === 'move') expect((await client.call('threads.get', { threadId: thread.id })).archived).toBe(false);
    else await expect(client.call('threads.get', { threadId: thread.id })).rejects.toMatchObject({ code: RpcErrorCode.NotFound });
  }
});

test('fake project policy defaults enabled, survives other writers and rejects paired/agent callers', async () => {
  const { project } = await fixture();
  expect(project.autoArchiveMergedPr).toBe(true);
  expect((await client.call('projects.add', { path: project.path })).autoArchiveMergedPr).toBe(true);
  expect((await client.call('projects.list', {})).find(row => row.id === project.id)?.autoArchiveMergedPr).toBe(true);
  await client.call('projects.setAutoArchiveMergedPr', { projectId: project.id, enabled: false });
  await client.call('projects.setWorktreeDefault', { projectId: project.id, enabled: false });
  expect((await client.call('projects.list', {})).find(row => row.id === project.id)?.autoArchiveMergedPr).toBe(false);
  await expect(client.call('projects.setAutoArchiveMergedPr', { projectId: project.id, enabled: 'yes' as never })).rejects.toMatchObject({ code: RpcErrorCode.Refused });
  for (const principal of ['session', 'agent'] as const) { client.becomes(principal); await expect(client.call('projects.setAutoArchiveMergedPr', { projectId: project.id, enabled: true })).rejects.toMatchObject({ code: RpcErrorCode.Refused }); }
});

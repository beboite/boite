import { afterEach, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkflowPlan, WorkflowRun } from '@boite/contracts';
import { setDriver } from '../src/drivers/index.ts';
import type { TurnContext, TurnResult } from '../src/drivers/types.ts';
import { echoThread, startTestCore, waitFor, type TestCore } from './harness.ts';
import { thrown } from './settle.ts';

/* Workflow steps with `machine`: a run here, one of its steps a subagent on another machine of the group. */

const cores: TestCore[] = [];
const restores: (() => void)[] = [];
afterEach(async () => { for (const h of cores.splice(0)) await h.stop(); for (const restore of restores.splice(0)) restore(); });

/** Each turn answers `reply(prompt)`; null holds it until stopped. Every prompt is kept by thread. */
function scripted(reply: (prompt: string) => string | null) {
  const prompts = new Map<string, string[]>();
  const held = new Set<string>();
  restores.push(setDriver('echo', { protocol: 'echo', startTurn(ctx: TurnContext) {
    prompts.set(ctx.thread.id, [...(prompts.get(ctx.thread.id) ?? []), ctx.prompt]);
    const done: TurnResult = { status: 'done', sessionId: `session:${ctx.thread.id}`, usage: null };
    const text = reply(ctx.prompt);
    if (text !== null) {
      const id = ctx.emit.startMessage('assistant');
      ctx.emit.part(id, 0, { type: 'text', text });
      ctx.emit.complete(id, 'complete');
      return { done: Promise.resolve(done), stop() {} };
    }
    held.add(ctx.thread.id);
    const finished = Promise.withResolvers<TurnResult>();
    return { done: finished.promise, stop() { held.delete(ctx.thread.id); finished.resolve({ status: 'stopped', sessionId: null, usage: null }); } };
  } }));
  return { prompts, held };
}

/** A conversation on `desk`, and `pc` in the same group with a project Notes. */
async function setup(allow = true) {
  const desk = await startTestCore();
  const pc = await startTestCore();
  cores.push(desk, pc);
  const owner = await desk.connect();
  const pcOwner = await pc.connect();
  await desk.core.group.create('Home');
  await pc.core.group.join((await desk.core.group.invite()).invite);
  const pcId = pc.core.coordination.card().coreId, deskId = desk.core.coordination.card().coreId;
  await waitFor(() => desk.core.group.peers().some(peer => peer.coreId === pcId) && pc.core.group.peers().some(peer => peer.coreId === deskId));
  const { threadId } = await echoThread(desk, owner, 'Family helper');
  const notesPath = join(pc.dataDir, 'notes');
  mkdirSync(notesPath, { recursive: true });
  const notes = await pcOwner.call('projects.add', { path: notesPath, name: 'Notes' });
  if (allow) await pc.core.settings.set({ groupThreads: true });
  const onPc = () => pc.core.journal.listThreads().filter(thread => thread.projectId === notes.id);
  const run = (runId: string): WorkflowRun => desk.core.workflows.get(threadId, runId);
  return { desk, pc, owner, threadId, pcId, deskId, machine: pcId.slice(0, 8), onPc, run };
}

const JSON_BLOCK = (value: unknown) => `Here it is.\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;

test('a step on another machine runs there after a step here, and its JSON output feeds the run', async () => {
  const { prompts } = scripted(prompt => {
    if (prompt.includes('step scan')) return JSON_BLOCK({ files: ['a.ts', 'b.ts'] });
    // The first answer there has no JSON: the run asks that subagent once more, as it asks a step here.
    if (prompt.includes('does not match this workflow step')) return JSON_BLOCK({ count: 2 });
    if (prompt.includes('step count')) return 'Two files.';
    return 'Summary read.';
  });
  const { desk, pc, owner, threadId, pcId, machine, onPc, run } = await setup();
  const plan: WorkflowPlan = { name: 'Across', steps: [
    { id: 'scan', task: 'List the files.', output: { files: ['string'] } },
    { id: 'count', machine, project: 'notes', task: 'Count these files: {{scan.files}}', output: { count: 'number' } },
  ] };
  expect((await owner.call('workflows.check', { threadId, plan })).levels).toEqual([['scan'], ['count']]);
  const started = await owner.call('workflows.start', { threadId, requestId: 'across-1', plan });
  await waitFor(() => run(started.id).status === 'done', 10_000);

  const [child] = onPc();
  expect(child).toBeDefined();
  const count = run(started.id).nodes[1]!.instances[0]!;
  expect(count).toMatchObject({ status: 'done', output: { count: 2 }, threadId: null, providerId: 'echo' });
  expect(count.machine).toMatchObject({ name: pc.core.coordination.identity().name, coreId: pcId, childId: child!.id, corrections: 1 });
  // It ran there, on what the step before it returned here.
  const first = prompts.get(child!.id)![0]!;
  expect(first).toContain('step count');
  expect(first).toContain('a.ts');
  expect(first).not.toContain('boite workflow output');
  expect(desk.core.journal.getThread(child!.id)).toBeNull();
  // Its answer went to the run, never to the conversation as mail, and the subagent list does not show it.
  expect(desk.core.journal.db.query("SELECT count(*) AS n FROM delegation_messages WHERE root_id = ? AND request_id GLOB 'result:*'").get(threadId)).toEqual({ n: 0 });
  expect((await owner.call('delegation.get', { threadId })).agents).toHaveLength(0);
  await waitFor(() => (prompts.get(threadId) ?? []).some(prompt => prompt.includes('Boite workflow done') && prompt.includes('count')));
});

test('a plan naming a machine not in the group is refused before it starts; one whose owner keeps groupThreads off fails the step with the setting to propose', async () => {
  scripted(() => 'ok');
  const { owner, threadId, machine, onPc, run } = await setup(false);
  const nowhere: WorkflowPlan = { name: 'Nowhere', steps: [{ id: 'far', machine: 'nowhere', task: 'Read.' }] };
  const checked = await thrown(owner.call('workflows.check', { threadId, plan: nowhere }));
  expect(checked).toThrow('steps[0].machine: no machine nowhere in this group; the others are');
  expect(await thrown(owner.call('workflows.start', { threadId, requestId: 'nowhere-1', plan: nowhere }))).toThrow('steps[0].machine: no machine nowhere in this group');
  expect(await owner.call('workflows.list', { threadId })).toHaveLength(0);

  const off = await owner.call('workflows.start', { threadId, requestId: 'off-1', plan: { name: 'Off', steps: [{ id: 'far', machine, project: 'notes', task: 'Read.' }] } });
  await waitFor(() => run(off.id).status === 'failed');
  expect(run(off.id).nodes[0]!.instances[0]!.error).toContain(`boite settings request groupThreads true --machine ${machine} --why`);
  expect(onPc()).toHaveLength(0);
});

test('stopping the run stops its step on the other machine', async () => {
  const { held } = scripted(prompt => (prompt.includes('step slow') ? null : 'ok'));
  const { desk, pc, owner, threadId, pcId, machine, onPc, run } = await setup();
  const started = await owner.call('workflows.start', { threadId, requestId: 'stop-1', plan: { name: 'Stop', steps: [{ id: 'slow', machine, project: 'notes', task: 'Read every page.' }] } });
  await waitFor(() => onPc().length === 1 && held.has(onPc()[0]!.id));
  const childId = onPc()[0]!.id;
  await waitFor(() => run(started.id).nodes[0]!.instances[0]!.machine?.childId === childId);

  await owner.call('workflows.control', { threadId, runId: started.id, action: 'stop' });
  expect(run(started.id)).toMatchObject({ status: 'stopped' });
  expect(run(started.id).nodes[0]!.instances[0]!.status).toBe('stopped');
  await desk.core.delegation.remote.flush(pcId);
  await waitFor(() => !held.has(childId) && pc.core.threads.require(childId).status !== 'running');
  expect(pc.core.journal.listTurns(childId).at(-1)?.status).toBe('stopped');
});

test('a step with both machine and compute is invalid', async () => {
  scripted(() => 'ok');
  const { owner, threadId, machine } = await setup();
  const compute = { sharedProjectId: 'shared-1', host: { ownerCoreId: 'a'.repeat(64), coreId: 'b'.repeat(64), projectId: 'p1' }, profileId: 'default', baseCommit: 'c'.repeat(40) };
  const both = await thrown(owner.call('workflows.check', { threadId, plan: { name: 'Both', steps: [{ id: 'far', machine, compute, task: 'Read.' }] } }));
  expect(both).toThrow('steps[0].machine: a step runs on another machine of the group or on a shared-project host, not both');
});

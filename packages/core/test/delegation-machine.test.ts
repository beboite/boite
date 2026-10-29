import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { DelegatedAgent, ModelInfo } from '@boite/contracts';
import { runCli } from '../src/cli.ts';
import type { CoreClient } from '../src/client.ts';
import { setDriver } from '../src/drivers/index.ts';
import type { TurnContext, TurnResult } from '../src/drivers/types.ts';
import { invalidParams } from '../src/errors.ts';
import { echoThread, startTestCore, waitFor, type TestCore } from './harness.ts';
import { thrown } from './settle.ts';

/* `boite delegate spawn --machine`: a parent here, its subagent on another machine of the group. */

const cores: TestCore[] = [];
const restores: (() => void)[] = [];
afterEach(async () => { for (const h of cores.splice(0)) await h.stop(); for (const restore of restores.splice(0)) restore(); });

/** An echo driver that records every prompt and answers with its folder's name; a prompt with HOLD-ON waits until released or stopped, and a stopped turn ends once `stopping` settles. */
function answering(stopping?: () => Promise<void>) {
  const prompts = new Map<string, string[]>();
  const held = new Map<string, () => void>();
  restores.push(setDriver('echo', { protocol: 'echo', startTurn(ctx: TurnContext) {
    prompts.set(ctx.thread.id, [...(prompts.get(ctx.thread.id) ?? []), ctx.prompt]);
    const answer = () => {
      const id = ctx.emit.startMessage('assistant');
      ctx.emit.part(id, 0, { type: 'text', text: `Done in ${basename(ctx.thread.cwd)}` });
      ctx.emit.complete(id, 'complete');
    };
    const done: TurnResult = { status: 'done', sessionId: `session:${ctx.thread.id}`, usage: null };
    if (!ctx.prompt.includes('HOLD-ON')) {
      answer();
      return { done: Promise.resolve(done), stop() {} };
    }
    const finished = Promise.withResolvers<TurnResult>();
    held.set(ctx.thread.id, () => { held.delete(ctx.thread.id); answer(); finished.resolve(done); });
    const end = () => finished.resolve({ status: 'stopped', sessionId: null, usage: null });
    return { done: finished.promise, stop() { held.delete(ctx.thread.id); if (stopping) void stopping().then(end); else end(); } };
  } }));
  const wakes = (threadId: string) => (prompts.get(threadId) ?? []).filter(prompt => prompt.includes('Boite delegation messages')).length;
  return { prompts, held, wakes };
}

/** Two machines of one group: a parent thread on `desk` in project test, a project Notes on `pc`, which lets the group start work there. */
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
  const cli = async (args: string[], on: TestCore = desk, as = threadId) => {
    let out = '', err = '';
    const code = await runCli(args, { out: s => { out += s; }, err: s => { err += s; }, env: { BOITE_THREAD_ID: as, BOITE_CORE_URL: on.url, BOITE_AGENT_TOKEN: on.core.agents.tokenFor(as) }, cwd: on.dataDir });
    return { code, out, err };
  };
  const spawn = async (brief: string, ...rest: string[]) => {
    const started = await cli(['delegate', 'spawn', brief, '--machine', pcId.slice(0, 8), ...rest, '--json']);
    expect(started.err).toBe('');
    return JSON.parse(started.out) as DelegatedAgent;
  };
  const childrenOnPc = () => pc.core.journal.listThreads().filter(thread => thread.projectId === notes.id);
  return { desk, pc, owner, pcOwner, threadId, notes, notesPath, pcId, deskId, machine: pcId.slice(0, 8), pcName: pc.core.coordination.identity().name, cli, spawn, childrenOnPc };
}

const TWIN_MODELS: ModelInfo[] = [
  { id: 'twin-a', name: 'Twin A', default: true, effort: { levels: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }], default: 'high' } },
  { id: 'twin-b', name: 'Twin B', effort: { levels: [{ id: 'low', label: 'Low' }, { id: 'max', label: 'Max' }], default: 'max' } },
];

/** A second provider on the echo driver, signed in, that the parent does not run on. */
async function twinProvider(h: TestCore, owner: CoreClient): Promise<void> {
  const shipped = JSON.parse(readFileSync(join(import.meta.dir, '../src/providers/shipped/echo.json'), 'utf8')) as Record<string, unknown>;
  mkdirSync(join(h.dataDir, 'providers'), { recursive: true });
  writeFileSync(join(h.dataDir, 'providers', 'twin.json'), JSON.stringify({ ...shipped, id: 'twin', name: 'Twin', shortName: 'Twin', models: TWIN_MODELS }));
  expect((await owner.call('providers.reload', {})).rejected).toEqual([]);
  h.core.accounts.ensureDefaults();
}

test('a subagent on another machine runs on the parent\'s model there, or on the one named from that machine\'s list, in the project named like the parent\'s', async () => {
  const { prompts } = answering();
  const { desk, pc, owner, pcOwner, threadId, notes, notesPath, machine, cli, spawn, childrenOnPc } = await setup();
  await twinProvider(pc, pcOwner);
  const parent = desk.core.threads.require(threadId);
  const config = desk.core.delegation.config(threadId);
  await owner.call('delegation.configure', { threadId, config: { ...config, anyModel: false } });
  expect((await owner.call('delegation.models', { threadId, machine })).anyModel).toBe(false);
  await owner.call('delegation.configure', { threadId, config });
  expect((await owner.call('delegation.models', { threadId, machine })).anyModel).toBe(true);

  // Without --project it takes the project of that machine named like the parent's; the PC has none.
  const unnamed = await cli(['delegate', 'spawn', 'Read the notes', '--machine', machine, '--request-id', 'model-0']);
  expect(unnamed.err).toContain('has no project named test; name one of its projects with --project: Notes');
  expect(desk.core.delegation.remote.holds(threadId, 'model-0')).toBe(false);
  const testPath = join(pc.dataDir, 'test');
  mkdirSync(testPath, { recursive: true });
  const sameName = await pcOwner.call('projects.add', { path: testPath, name: 'test' });
  const plain = await spawn('Read the notes', '--request-id', 'model-1');
  expect(plain.machine).toEqual({ coreId: pc.core.coordination.card().coreId, name: pc.core.coordination.identity().name });
  expect(pc.core.threads.require(plain.thread.id)).toMatchObject({ projectId: sameName.id, cwd: testPath, providerId: parent.providerId, model: parent.model });
  expect(desk.core.journal.getThread(plain.thread.id)).toBeNull();
  await waitFor(() => prompts.has(plain.thread.id));
  const first = prompts.get(plain.thread.id)![0]!;
  expect(first).toContain(`for parent agent ${threadId} on ${desk.core.coordination.identity().name}, another machine of the user's`);
  expect(first).toContain('You cannot start subagents or threads.');
  const message = pc.core.journal.listMessages(plain.thread.id).find(message => message.role === 'user')!;
  expect(message.parts[0]).toMatchObject({ type: 'text', displayText: 'Read the notes', startedBy: {
    threadId, title: parent.title, projectId: parent.projectId, project: 'test', machine: desk.core.coordination.identity().name,
  } });

  const named = await spawn('Read the notes', '--project', 'notes', '--model', 'twin-b', '--effort', 'low', '--request-id', 'model-2');
  expect(pc.core.threads.require(named.thread.id)).toMatchObject({ projectId: notes.id, cwd: notesPath, providerId: 'twin', model: 'twin-b', effort: 'low' });
  expect(named.profileId).toBe('twin/twin-b');

  // A model the PC lacks: refused with the PC's list, and no delegation.start is sent.
  const asked: string[] = [];
  const request = desk.core.coordination.request.bind(desk.core.coordination);
  desk.core.coordination.request = ((peer, operation, payload) => { asked.push(operation); return request(peer, operation, payload); }) as typeof desk.core.coordination.request;
  const before = pc.core.journal.listThreads().length;
  const missing = await cli(['delegate', 'spawn', 'Read the notes', '--machine', machine, '--project', 'notes', '--model', 'echo/missing', '--request-id', 'model-3']);
  expect(missing.err).toContain(`model: no installed model matches "echo/missing"; run boite delegate models --machine ${machine}`);
  const refusal = await desk.core.delegation.remote.spawn({ threadId, task: 'Read', machine, project: 'notes', model: 'echo/missing', requestId: 'model-4' }).catch((error: unknown) => error);
  expect(refusal).toMatchObject({ data: { field: 'model', expected: expect.arrayContaining(['echo/echo', 'twin/twin-a', 'twin/twin-b']) } });
  expect(asked).toEqual(['delegation.catalog', 'delegation.catalog']);
  expect(pc.core.journal.listThreads()).toHaveLength(before);
  expect(desk.core.delegation.remote.holds(threadId, 'model-3')).toBe(false);
  expect(childrenOnPc()).toHaveLength(1);
});

test('a machine whose owner did not let the group start work there refuses, with the setting to propose', async () => {
  answering();
  const { desk, pc, owner, threadId, machine, cli, childrenOnPc } = await setup(false);
  const refused = await cli(['delegate', 'spawn', 'Read the notes', '--machine', machine, '--project', 'notes', '--request-id', 'off-1']);
  expect(refused.err).toContain(`boite settings request groupThreads true --machine ${machine} --why`);
  expect(childrenOnPc()).toHaveLength(0);
  expect(pc.core.journal.listThreads().filter(thread => thread.title === 'Read the notes')).toHaveLength(0);
  expect((await owner.call('delegation.get', { threadId })).agents).toHaveLength(0);
  // Nothing is kept of it: the same request id asks again once the owner allows it.
  expect(desk.core.delegation.remote.holds(threadId, 'off-1')).toBe(false);
  await pc.core.settings.set({ groupThreads: true });
  expect((await cli(['delegate', 'spawn', 'Read the notes', '--machine', machine, '--project', 'notes', '--request-id', 'off-1'])).err).toBe('');
  expect(childrenOnPc()).toHaveLength(1);
});

test('the result wakes the parent once, as a result letter from that machine, and delegate wait settles on it', async () => {
  const { held, wakes } = answering();
  const { desk, pc, owner, threadId, pcId, deskId, pcName, cli, spawn } = await setup();
  const reports: unknown[] = [];
  const report = pc.core.coordination.request.bind(pc.core.coordination);
  pc.core.coordination.request = ((peer, operation, payload) => {
    if (operation === 'delegation.report') reports.push(payload);
    return report(peer, operation, payload);
  }) as typeof pc.core.coordination.request;

  const child = await spawn('Read the notes HOLD-ON', '--project', 'notes', '--title', 'Read the notes', '--request-id', 'result-1');
  await waitFor(() => held.has(child.thread.id));
  // A wait taken while it runs ends when its result crosses back.
  const waited = cli(['delegate', 'wait', child.thread.id, '--timeout', '10']);
  held.get(child.thread.id)!();
  const settled = await waited;
  expect(settled.err).toBe('');
  expect(settled.out).toContain('state: result_available');
  expect(settled.out).toContain('result: Done in notes');

  await waitFor(() => wakes(threadId) === 1 && desk.core.threads.require(threadId).status === 'idle');
  const [result] = (await owner.call('delegation.get', { threadId })).messages.filter(letter => letter.origin === 'result');
  expect(result).toMatchObject({ from: { coreId: pcId, threadId: child.thread.id, machine: pcName }, status: 'delivered' });
  expect(result!.text).toBe('Read the notes: done\nDone in notes');

  // That machine sends the same reports again, as after an answer it did not hear: nothing new is filed or woken.
  const deskPeer = pc.core.group.peers().find(peer => peer.coreId === deskId)!;
  for (const payload of reports) await report(deskPeer, 'delegation.report', payload);
  const filed = desk.core.journal.db.query("SELECT count(*) AS n FROM delegation_messages WHERE sender_id = ? AND request_id GLOB 'result:*'").get(`${pcId}:${child.thread.id}`) as { n: number };
  expect(filed.n).toBe(1);
  expect(desk.core.journal.db.query("SELECT count(*) AS n FROM delegation_messages WHERE root_id = ? AND status = 'received'").get(threadId)).toEqual({ n: 0 });
  await waitFor(() => desk.core.threads.require(threadId).status === 'idle');
  expect(wakes(threadId)).toBe(1);
});

test('a result the member could not send waits there, and arrives once the caller can be reached', async () => {
  const { wakes } = answering();
  const { desk, pc, owner, threadId, deskId, spawn } = await setup();
  let away = true, failures = 0;
  const report = pc.core.coordination.request.bind(pc.core.coordination);
  pc.core.coordination.request = ((peer, operation, payload) => {
    if (operation === 'delegation.report' && away) { failures++; return Promise.reject(new Error('connect ECONNREFUSED')); }
    return report(peer, operation, payload);
  }) as typeof pc.core.coordination.request;

  const child = await spawn('Read the notes', '--project', 'notes', '--request-id', 'away-1');
  await waitFor(() => failures > 0 && pc.core.threads.require(child.thread.id).status === 'idle' && pc.core.delegation.remote.waiting(deskId).reports > 0);
  expect(wakes(threadId)).toBe(0);
  expect((await owner.call('delegation.get', { threadId })).agents[0]?.result ?? null).toBeNull();

  away = false;
  await pc.core.delegation.remote.flush(deskId);
  expect(pc.core.delegation.remote.waiting(deskId).reports).toBe(0);
  await waitFor(() => wakes(threadId) === 1);
  expect(desk.core.delegation.remote.child(threadId, child.thread.id)?.state?.result).toBe('Done in notes');
});

test('delegation.get and delegate list show the child on the other machine with that machine and its last result', async () => {
  answering();
  const { desk, owner, threadId, pcId, pcName, cli, spawn } = await setup();
  const child = await spawn('Read the notes', '--project', 'notes', '--request-id', 'list-1');
  await waitFor(() => desk.core.delegation.remote.child(threadId, child.thread.id)?.state?.result === 'Done in notes');
  const { agents } = await owner.call('delegation.get', { threadId });
  expect(agents).toHaveLength(1);
  expect(agents[0]).toMatchObject({ thread: { id: child.thread.id, parentThreadId: threadId, title: 'Read the notes' }, machine: { coreId: pcId, name: pcName }, result: 'Done in notes', task: 'Read the notes' });
  expect(agents[0]!.resultRef?.agentId).toBe(child.thread.id);
  const list = (await cli(['delegate', 'list'])).out;
  expect(list).toContain(`${child.thread.id} `);
  expect(list).toContain(` on ${pcName} "Read the notes"`);
  expect(list).toContain('  result: Done in notes');
  // Its full result is read from that machine.
  const page = await cli(['delegate', 'result', child.thread.id, agents[0]!.resultRef!.turnId]);
  expect(page.out).toContain('Done in notes');
});

test('delegate send reaches the child there and starts a turn, delegate stop stops it, and archiving the parent archives it there', async () => {
  const { prompts, held } = answering();
  const { desk, pc, owner, threadId, cli, spawn } = await setup();
  const idle = await spawn('Read the notes', '--project', 'notes', '--request-id', 'steer-1');
  await waitFor(() => desk.core.delegation.remote.child(threadId, idle.thread.id)?.state?.result === 'Done in notes');

  const sent = await cli(['delegate', 'send', idle.thread.id, 'Now read the second page', '--request-id', 'steer-letter-1']);
  expect(sent.err).toBe('');
  await waitFor(() => (prompts.get(idle.thread.id) ?? []).some(prompt => prompt.includes('Boite delegation messages') && prompt.includes('Now read the second page')));
  expect(desk.core.journal.db.query('SELECT status FROM delegation_messages WHERE sender_id = ? AND request_id = ?').get(threadId, 'steer-letter-1')).toEqual({ status: 'delivered' });

  const busy = await spawn('Read every page HOLD-ON', '--project', 'notes', '--title', 'Read every page', '--request-id', 'steer-2');
  await waitFor(() => held.has(busy.thread.id));
  await waitFor(() => ['queued', 'running'].includes(desk.core.delegation.remote.child(threadId, busy.thread.id)?.state?.lastTurn?.status ?? ''));
  const stopped = await cli(['delegate', 'stop', busy.thread.id]);
  expect(stopped.out).toContain('stopped: 1');
  await waitFor(() => !held.has(busy.thread.id) && pc.core.threads.require(busy.thread.id).status !== 'running');
  await waitFor(() => desk.core.delegation.remote.child(threadId, busy.thread.id)?.state?.lastTurn?.status === 'stopped');

  await waitFor(() => desk.core.threads.require(threadId).status === 'idle');
  await owner.call('threads.archive', { threadId });
  await waitFor(() => pc.core.threads.require(idle.thread.id).archived && pc.core.threads.require(busy.thread.id).archived);
});

test('the same request id answers the same child there, even when the first answer was lost; other content is refused', async () => {
  answering();
  const { desk, pc, owner, threadId, deskId, machine, cli, childrenOnPc } = await setup();
  const starts: unknown[] = [];
  let lose = true;
  const request = desk.core.coordination.request.bind(desk.core.coordination);
  desk.core.coordination.request = (async (peer, operation, payload) => {
    const answer = await request(peer, operation, payload);
    if (operation === 'delegation.start') {
      starts.push(payload);
      if (lose) { lose = false; throw new Error('socket hang up'); }
    }
    return answer;
  }) as typeof desk.core.coordination.request;
  const brief = ['delegate', 'spawn', 'Read the notes', '--machine', machine, '--project', 'notes', '--request-id', 'same-1'];
  const lost = await cli(brief);
  expect(lost.err).toContain('did not answer: socket hang up');
  expect(lost.err).toContain('the same --request-id answers it');
  expect(childrenOnPc()).toHaveLength(1);
  const [there] = childrenOnPc();

  const again = await cli([...brief, '--json']);
  expect(again.err).toBe('');
  expect((JSON.parse(again.out) as DelegatedAgent).thread.id).toBe(there!.id);
  const once = await cli([...brief, '--json']);
  expect((JSON.parse(once.out) as DelegatedAgent).thread.id).toBe(there!.id);
  expect(childrenOnPc()).toHaveLength(1);
  expect((await owner.call('delegation.get', { threadId })).agents.map(agent => agent.thread.id)).toEqual([there!.id]);

  expect((await cli(['delegate', 'spawn', 'Read other notes', '--machine', machine, '--project', 'notes', '--request-id', 'same-1'])).err).toContain('requestId already used for different content');
  // The member keeps the request too: the same start answers its child, another under that id is refused.
  const peer = desk.core.group.peers().find(member => member.coreId === pc.core.coordination.card().coreId)!;
  const start = starts[0] as Record<string, unknown>;
  expect(await request(peer, 'delegation.start', start)).toMatchObject({ childId: there!.id });
  expect(await thrown(request(peer, 'delegation.start', { ...start, task: 'Read other notes', fingerprint: 'another' }))).toThrow('delegation.start.requestId was already used for different content');
  expect(childrenOnPc()).toHaveLength(1);
  expect(pc.core.delegation.remote.parentOf(there!.id)).toMatchObject({ coreId: deskId, parentId: threadId, requestId: 'same-1' });
});

test('a subagent working for another machine cannot start subagents or threads', async () => {
  answering();
  const { desk, pc, cli, spawn } = await setup();
  await desk.core.settings.set({ groupThreads: true });
  const child = await spawn('Read the notes', '--project', 'notes', '--request-id', 'nested-1');
  const childId = child.thread.id;
  const before = pc.core.journal.listThreads().length;
  expect((await cli(['delegate', 'spawn', 'Read more', '--request-id', 'nested-2'], pc, childId)).err).toContain('delegation supports one level');
  expect((await cli(['delegate', 'spawn', 'Read more', '--machine', desk.core.coordination.card().coreId.slice(0, 8), '--request-id', 'nested-3'], pc, childId)).err).toContain('delegation supports one level');
  expect((await cli(['thread', 'new', 'notes', 'Read more', '--request-id', 'nested-4'], pc, childId)).err).toContain('a delegated agent or workflow step cannot start threads');
  expect((await cli(['thread', 'new', 'test', 'Read more', '--machine', desk.core.coordination.card().coreId.slice(0, 8), '--request-id', 'nested-5'], pc, childId)).err).toContain('a delegated agent or workflow step cannot start threads');
  expect(pc.core.journal.listThreads()).toHaveLength(before);
});

test('a member whose Boite does not know these operations is reported too old, and nothing starts', async () => {
  answering();
  const { desk, threadId, machine, cli, childrenOnPc, pc } = await setup();
  // As an older core answers an operation it does not know.
  pc.core.delegation.remote.peer = async () => { throw invalidParams('operation: expected directory, deliver, receipt, search, read, group.sync, group.push, relay.*, thread.start, delegation.catalog, setting.* or bot.*'); };
  const spawned = await cli(['delegate', 'spawn', 'Read the notes', '--machine', machine, '--project', 'notes', '--request-id', 'old-1']);
  expect(spawned.err).toContain('is too old to run subagents for another machine; the owner updates it in Settings, Machines and updates');
  expect(childrenOnPc()).toHaveLength(0);
  expect(desk.core.delegation.remote.holds(threadId, 'old-1')).toBe(false);
});

test('a parent archived or deleted before its child there was named retires that child once a report names it', async () => {
  const { held } = answering();
  const { desk, pc, owner, threadId, pcId, deskId, machine, cli, childrenOnPc } = await setup();
  const request = desk.core.coordination.request.bind(desk.core.coordination);
  desk.core.coordination.request = (async (peer, operation, payload) => {
    const answer = await request(peer, operation, payload);
    if (operation === 'delegation.start') throw new Error('lost start reply');
    return answer;
  }) as typeof desk.core.coordination.request;
  let away = true;
  const report = pc.core.coordination.request.bind(pc.core.coordination);
  pc.core.coordination.request = ((peer, operation, payload) => (operation === 'delegation.report' && away
    ? Promise.reject(new Error('offline')) : report(peer, operation, payload))) as typeof pc.core.coordination.request;
  expect((await cli(['delegate', 'spawn', 'Read HOLD-ON', '--machine', machine, '--project', 'notes', '--request-id', 'archive-lost'])).err).toContain('lost start reply');
  const child = childrenOnPc()[0]!;
  await waitFor(() => held.has(child.id));
  await owner.call('threads.archive', { threadId });
  away = false;
  await pc.core.delegation.remote.flush(deskId);
  await desk.core.delegation.remote.flush(pcId);
  // Before, the archive skipped the child it could not name yet, and it kept working there.
  expect(pc.core.threads.require(child.id).archived).toBe(true);
  expect(held.has(child.id)).toBe(false);

  // Deleted for good with its project: nothing of that parent stays here but the retirement, until a report names its child.
  mkdirSync(join(desk.dataDir, 'other'), { recursive: true });
  const project = await owner.call('projects.add', { path: join(desk.dataDir, 'other'), name: 'Other' });
  const parent = desk.core.threads.require(threadId);
  const other = await owner.call('threads.create', { projectId: project.id, providerId: parent.providerId, accountId: parent.accountId, title: 'Second helper' });
  away = true;
  expect((await cli(['delegate', 'spawn', 'Read HOLD-ON', '--machine', machine, '--project', 'notes', '--request-id', 'delete-lost'], desk, other.id)).err).toContain('lost start reply');
  const orphan = childrenOnPc().find(thread => thread.id !== child.id)!;
  await waitFor(() => held.has(orphan.id));
  await owner.call('projects.remove', { projectId: project.id });
  expect(desk.core.delegation.remote.has(other.id)).toBe(false);
  away = false;
  await pc.core.delegation.remote.flush(deskId);
  await desk.core.delegation.remote.flush(pcId);
  // Before, the report of a parent this machine forgot was dropped, and the child kept working there.
  expect(pc.core.threads.require(orphan.id).archived).toBe(true);
  expect(held.has(orphan.id)).toBe(false);
});

test('a stop sent again because its answer was lost does not stop the instruction that follows it', async () => {
  const { held, prompts } = answering();
  const { desk, pc, threadId, pcId, cli, spawn } = await setup();
  const child = await spawn('Read HOLD-ON', '--project', 'notes', '--request-id', 'stop-child');
  await waitFor(() => held.has(child.thread.id));
  const report = pc.core.coordination.request.bind(pc.core.coordination);
  pc.core.coordination.request = ((peer, operation, payload) => (operation === 'delegation.report' ? Promise.reject(new Error('no reports')) : report(peer, operation, payload))) as typeof pc.core.coordination.request;
  const request = desk.core.coordination.request.bind(desk.core.coordination);
  let lost: unknown;
  desk.core.coordination.request = (async (peer, operation, payload) => {
    const answer = await request(peer, operation, payload);
    if (operation === 'delegation.stop' && lost === undefined) { lost = payload; throw new Error('lost stop reply'); }
    return answer;
  }) as typeof desk.core.coordination.request;
  desk.core.delegation.remote.stop(threadId, child.thread.id);
  await desk.core.delegation.remote.flush(pcId);
  await waitFor(() => !held.has(child.thread.id) && pc.core.journal.listTurns(child.thread.id)[0]?.status === 'stopped');
  expect(desk.core.delegation.remote.waiting(pcId).stops).toBe(1);
  expect((await cli(['delegate', 'send', child.thread.id, 'Read a new page HOLD-ON', '--request-id', 'later-instruction'])).err).toBe('');
  await waitFor(() => held.has(child.thread.id));
  expect(prompts.get(child.thread.id)).toHaveLength(2);
  // The same stop arrives again, from the outbox or the transport's own retry.
  await request(desk.core.group.peers().find(peer => peer.coreId === pcId)!, 'delegation.stop', lost);
  await desk.core.delegation.remote.flush(pcId);
  expect(desk.core.delegation.remote.waiting(pcId).stops).toBe(0);
  // Before, the same stop was applied again and cut the new instruction too.
  expect(held.has(child.thread.id)).toBe(true);
  expect(pc.core.journal.listTurns(child.thread.id)[1]?.status).toBe('running');

  // A stop that does not get through before the next instruction ends the turn it meant, never the one that instruction opens.
  let blocked = true;
  desk.core.coordination.request = (async (peer, operation, payload) => {
    if (operation === 'delegation.stop' && blocked) throw new Error('stop not delivered');
    return request(peer, operation, payload);
  }) as typeof desk.core.coordination.request;
  desk.core.delegation.remote.stop(threadId, child.thread.id);
  await desk.core.delegation.remote.flush(pcId);
  expect(held.has(child.thread.id)).toBe(true);
  expect((await cli(['delegate', 'send', child.thread.id, 'Read the last page HOLD-ON', '--request-id', 'last-instruction'])).err).toBe('');
  await waitFor(() => held.has(child.thread.id) && pc.core.journal.listTurns(child.thread.id)[2]?.status === 'running');
  expect(pc.core.journal.listTurns(child.thread.id)[1]?.status).toBe('stopped');
  blocked = false;
  await desk.core.delegation.remote.flush(pcId);
  expect(desk.core.delegation.remote.waiting(pcId).stops).toBe(0);
  expect(held.has(child.thread.id)).toBe(true);
  expect(pc.core.journal.listTurns(child.thread.id)[2]?.status).toBe('running');
});

test('a stop asked after an instruction cancels it, whether it lands while that instruction waits or before it arrives', async () => {
  const slow = Promise.withResolvers<void>(), asked = Promise.withResolvers<void>();
  const { held, prompts } = answering(() => { asked.resolve(); return slow.promise; });
  const { desk, pc, threadId, pcId, cli, spawn } = await setup();
  const child = await spawn('Read HOLD-ON', '--project', 'notes', '--request-id', 'overtaken-child');
  await waitFor(() => held.has(child.thread.id));
  const request = desk.core.coordination.request.bind(desk.core.coordination);
  let stops = false, transit: Promise<void> | null = null;
  desk.core.coordination.request = (async (peer, operation, payload) => {
    if (operation === 'delegation.stop' && !stops) throw new Error('stop not delivered');
    if (operation === 'delegation.letter' && transit) await transit;
    return request(peer, operation, payload);
  }) as typeof desk.core.coordination.request;
  const send = (text: string, requestId: string) => thrown(desk.core.delegation.remote.send({ threadId, toThreadId: child.thread.id, requestId, text }, 'agent'));

  // The instruction carries the stop that did not get through and waits for the turn it ends; a later stop lands meanwhile.
  desk.core.delegation.remote.stop(threadId, child.thread.id);
  await desk.core.delegation.remote.flush(pcId);
  const waiting = send('Read the next page HOLD-ON', 'overtaken-waiting');
  await asked.promise;
  stops = true;
  desk.core.delegation.remote.stop(threadId, child.thread.id);
  await desk.core.delegation.remote.flush(pcId);
  slow.resolve();
  expect(await waiting).toThrow('a stop asked after this instruction');
  expect(held.has(child.thread.id)).toBe(false);
  expect(pc.core.journal.listTurns(child.thread.id).map(turn => turn.status)).toEqual(['stopped']);

  // A stop asked while the instruction is on its way, and taken first, cancels it too.
  expect((await cli(['delegate', 'send', child.thread.id, 'Read again HOLD-ON', '--request-id', 'overtaken-resume'])).err).toBe('');
  await waitFor(() => held.has(child.thread.id));
  const gate = Promise.withResolvers<void>();
  transit = gate.promise;
  const late = send('Read the last page HOLD-ON', 'overtaken-late');
  desk.core.delegation.remote.stop(threadId, child.thread.id);
  await desk.core.delegation.remote.flush(pcId);
  gate.resolve();
  expect(await late).toThrow('a stop asked after this instruction');
  expect(held.has(child.thread.id)).toBe(false);
  expect(prompts.get(child.thread.id)).toHaveLength(2);
});

test('an instruction waiting for a stopped turn starts nothing once the owner turns groupThreads off', async () => {
  const slow = Promise.withResolvers<void>(), asked = Promise.withResolvers<void>();
  const { held, prompts } = answering(() => { asked.resolve(); return slow.promise; });
  const { desk, pc, threadId, pcId, spawn } = await setup();
  const child = await spawn('Read HOLD-ON', '--project', 'notes', '--request-id', 'revoked-child');
  await waitFor(() => held.has(child.thread.id));
  const request = desk.core.coordination.request.bind(desk.core.coordination);
  desk.core.coordination.request = ((peer, operation, payload) => (operation === 'delegation.stop' ? Promise.reject(new Error('stop not delivered')) : request(peer, operation, payload))) as typeof desk.core.coordination.request;
  desk.core.delegation.remote.stop(threadId, child.thread.id);
  await desk.core.delegation.remote.flush(pcId);
  const waiting = thrown(desk.core.delegation.remote.send({ threadId, toThreadId: child.thread.id, requestId: 'revoked-letter', text: 'Read more HOLD-ON' }, 'agent'));
  await asked.promise;
  await pc.core.settings.set({ groupThreads: false });
  slow.resolve();
  expect(await waiting).toThrow('does not let the other machines of its group start threads there');
  expect(held.has(child.thread.id)).toBe(false);
  expect(prompts.get(child.thread.id)).toHaveLength(1);
});

test('the child owner stopping it cancels an earlier waiting instruction, while a new explicit instruction can resume it', async () => {
  const slow = Promise.withResolvers<void>(), asked = Promise.withResolvers<void>();
  const { held, prompts } = answering(() => { asked.resolve(); return slow.promise; });
  const { desk, pc, pcOwner, threadId, pcId, cli, spawn } = await setup();
  const child = await spawn('Read HOLD-ON', '--project', 'notes', '--request-id', 'owner-stop-child');
  await waitFor(() => held.has(child.thread.id));
  const request = desk.core.coordination.request.bind(desk.core.coordination);
  desk.core.coordination.request = ((peer, operation, payload) => (operation === 'delegation.stop' ? Promise.reject(new Error('stop not delivered')) : request(peer, operation, payload))) as typeof desk.core.coordination.request;
  desk.core.delegation.remote.stop(threadId, child.thread.id);
  await desk.core.delegation.remote.flush(pcId);
  const waiting = thrown(desk.core.delegation.remote.send({ threadId, toThreadId: child.thread.id, requestId: 'before-owner-stop', text: 'Earlier instruction HOLD-ON' }, 'agent'));
  await asked.promise;
  expect(await pcOwner.call('turns.stop', { threadId: child.thread.id })).toEqual({ stopped: true });
  slow.resolve();
  expect(await waiting).toThrow('a stop asked after this instruction');
  expect(held.has(child.thread.id)).toBe(false);
  expect(prompts.get(child.thread.id)).toHaveLength(1);
  expect(pc.core.journal.listTurns(child.thread.id).map(turn => turn.status)).toEqual(['stopped']);

  expect((await cli(['delegate', 'send', child.thread.id, 'Resume HOLD-ON', '--request-id', 'after-owner-stop'])).err).toBe('');
  await waitFor(() => held.has(child.thread.id));
  expect(prompts.get(child.thread.id)).toHaveLength(2);
});

test('a turn the parent there started with delegate send is cut by a restart handoff and continued after it', async () => {
  const { held, prompts } = answering();
  const { desk, pc, threadId, cli, spawn } = await setup();
  const child = await spawn('Read the first page', '--project', 'notes', '--request-id', 'restart-child');
  await waitFor(() => desk.core.delegation.remote.child(threadId, child.thread.id)?.state?.result === 'Done in notes');
  expect((await cli(['delegate', 'send', child.thread.id, 'Read the next page HOLD-ON', '--request-id', 'restart-instruction'])).err).toBe('');
  await waitFor(() => held.has(child.thread.id));
  const cut = pc.core.journal.listTurns(child.thread.id)[1]!;
  expect(cut.execution?.operation).toBe('delegation');
  await pc.core.threads.handoff.begin(0);
  // Before, nothing kept it: the handoff skips sub-work, and delegation only kept local children.
  expect(pc.core.journal.getSetting('delegation-restart-cut')).toEqual([{ childId: child.thread.id, turnId: cut.id }]);
  await pc.core.delegation.remote.flush(desk.core.coordination.card().coreId);
  expect(desk.core.delegation.remote.child(threadId, child.thread.id)?.state).toMatchObject({ lastTurn: { id: cut.id, status: 'stopped' }, restarting: true });
  expect(pc.core.delegation.resumeAfterRestart()).toBe(1);
  await waitFor(() => pc.core.journal.listTurns(child.thread.id)[2]?.status === 'done');
  const resumed = pc.core.journal.listTurns(child.thread.id)[2]!;
  expect(resumed.execution?.operation).toBe('resume');
  expect(prompts.get(child.thread.id)!.at(-1)).toStartWith('Boite restarted');
  // Its parent hears of the turn that went on.
  await waitFor(() => desk.core.delegation.remote.child(threadId, child.thread.id)?.state?.lastTurn?.id === resumed.id);
});

test('a member that turns groupThreads off while a start is on its way creates no child', async () => {
  answering();
  const { desk, pc, threadId, deskId, childrenOnPc } = await setup();
  const parent = desk.core.threads.require(threadId);
  const caller = pc.core.group.peers().find(peer => peer.coreId === deskId)!;
  const starting = pc.core.delegation.remote.peer(caller, 'delegation.start', {
    parent: { threadId, title: parent.title, projectId: parent.projectId, project: 'test' }, requestId: 'revoke-1', fingerprint: 'revoke-1', task: 'Read the notes', title: 'Read the notes', worktree: false, project: 'notes',
    route: { providerId: parent.providerId, model: parent.model, effort: parent.effort, speed: null }, permissionMode: parent.permissionMode,
  });
  await pc.core.settings.set({ groupThreads: false });
  // Before, the setting was read once on arrival and a child started anyway.
  expect(await thrown(starting)).toThrow('groupThreads is off on this machine');
  expect(childrenOnPc()).toHaveLength(0);
});

test('a stop asked by request id before that machine named the child stops it once a report names it', async () => {
  const { held } = answering();
  const { desk, pc, threadId, pcId, deskId, machine, cli, childrenOnPc } = await setup();
  const request = desk.core.coordination.request.bind(desk.core.coordination);
  desk.core.coordination.request = (async (peer, operation, payload) => {
    const answer = await request(peer, operation, payload);
    if (operation === 'delegation.start') throw new Error('lost start reply');
    return answer;
  }) as typeof desk.core.coordination.request;
  let away = true;
  const report = pc.core.coordination.request.bind(pc.core.coordination);
  pc.core.coordination.request = ((peer, operation, payload) => (operation === 'delegation.report' && away
    ? Promise.reject(new Error('offline')) : report(peer, operation, payload))) as typeof pc.core.coordination.request;
  expect((await cli(['delegate', 'spawn', 'Read HOLD-ON', '--machine', machine, '--project', 'notes', '--request-id', 'stop-unnamed'])).err).toContain('lost start reply');
  const child = childrenOnPc()[0]!;
  await waitFor(() => held.has(child.id));
  expect(desk.core.delegation.remote.stopRequest(threadId, 'stop-unnamed')).toBe(true);
  expect(desk.core.delegation.remote.stopRequest(threadId, 'never-asked')).toBe(false);
  away = false;
  await pc.core.delegation.remote.flush(deskId);
  await desk.core.delegation.remote.flush(pcId);
  expect(held.has(child.id)).toBe(false);
  expect(pc.core.threads.require(child.id).archived).toBe(false);
  expect(desk.core.delegation.remote.child(threadId, child.id)?.stopping).toBeUndefined();
});

test('a restart of the child\'s machine keeps the child at work for its parent until that stop is final', async () => {
  const { held } = answering();
  const { desk, pc, owner, pcOwner, threadId, pcId, deskId, spawn } = await setup();
  const child = await spawn('Read HOLD-ON', '--project', 'notes', '--request-id', 'restart-first');
  const other = await spawn('Read more HOLD-ON', '--project', 'notes', '--request-id', 'restart-second');
  await waitFor(() => held.has(child.thread.id) && held.has(other.thread.id));
  await pc.core.threads.handoff.begin(0);
  await pc.core.delegation.remote.flush(deskId);
  const seen = (id: string) => desk.core.delegation.remote.child(threadId, id)!;
  const agent = async (id: string) => (await owner.call('delegation.get', { threadId })).agents.find(entry => entry.thread.id === id)!;
  expect(seen(child.thread.id).state?.lastTurn?.status).toBe('stopped');
  // Before, the parent read that cut as the child's final stop, with a result to collect.
  expect(seen(child.thread.id).state?.restarting).toBe(true);
  expect(desk.core.delegation.remote.busy(threadId)).toBe(true);
  expect((await owner.call('delegation.get', { threadId })).settlement).toBe('waiting_for_children');
  expect((await agent(child.thread.id)).resultRef).toBeUndefined();
  expect(await owner.call('delegation.wait', { threadId, agentId: child.thread.id, timeoutMs: 0 })).toMatchObject({ state: 'waiting_for_children', timedOut: true });
  expect(await owner.call('delegation.wait', { threadId, timeoutMs: 0 })).toMatchObject({ state: 'waiting_for_children', timedOut: true });
  // That machine's owner stops one and the parent the other: no next core continues them, and the parent hears it at once.
  await pcOwner.call('turns.stop', { threadId: child.thread.id });
  await pc.core.delegation.remote.flush(deskId);
  await waitFor(() => seen(child.thread.id).state?.restarting === undefined);
  expect(await owner.call('delegation.wait', { threadId, agentId: child.thread.id, timeoutMs: 0 })).toMatchObject({ state: 'result_available', timedOut: false });
  expect(await owner.call('delegation.wait', { threadId, timeoutMs: 0 })).toMatchObject({ state: 'waiting_for_children', timedOut: true });
  desk.core.delegation.remote.stop(threadId, other.thread.id);
  await desk.core.delegation.remote.flush(pcId);
  await pc.core.delegation.remote.flush(deskId);
  // An automatic report may already be in flight; the newer stop state goes in the next batch.
  await waitFor(() => [child.thread.id, other.thread.id].every(id => seen(id).state?.restarting === undefined));
  for (const id of [child.thread.id, other.thread.id]) {
    const cut = seen(id).state!.lastTurn!.id;
    expect(pc.core.threads.handoff.carries(cut)).toBe(false);
    expect(seen(id).state?.restarting).toBeUndefined();
    expect((await agent(id)).resultRef?.turnId).toBe(cut);
  }
  expect(desk.core.delegation.remote.busy(threadId)).toBe(false);
  expect((await owner.call('delegation.get', { threadId })).settlement).toBe('settled');
});

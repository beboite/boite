import { afterEach, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { AgentSpawn } from '@boite/contracts';
import { runCli } from '../src/cli.ts';
import { setDriver } from '../src/drivers/index.ts';
import type { TurnContext, TurnResult } from '../src/drivers/types.ts';
import { echoThread, startTestCore, waitFor, type TestCore } from './harness.ts';

/* `boite thread new --machine`: a thread's agent starts a thread on another machine of its group. */

const cores: TestCore[] = [];
const restores: (() => void)[] = [];
afterEach(async () => { for (const h of cores.splice(0)) await h.stop(); for (const restore of restores.splice(0)) restore(); });

/** An echo driver that records every prompt and answers at once with its folder's name. */
function answering(): Map<string, string[]> {
  const prompts = new Map<string, string[]>();
  restores.push(setDriver('echo', { protocol: 'echo', startTurn(ctx: TurnContext) {
    prompts.set(ctx.thread.id, [...(prompts.get(ctx.thread.id) ?? []), ctx.prompt]);
    const id = ctx.emit.startMessage('assistant');
    ctx.emit.part(id, 0, { type: 'text', text: `Done in ${basename(ctx.thread.cwd)}` });
    ctx.emit.complete(id, 'complete');
    const result: TurnResult = { status: 'done', sessionId: `session:${ctx.thread.id}`, usage: null };
    return { done: Promise.resolve(result), stop() {} };
  } }));
  return prompts;
}

/** Two machines of one group: a thread on `desk`, a project Notes on `pc`. */
async function setup() {
  const desk = await startTestCore();
  const pc = await startTestCore();
  cores.push(desk, pc);
  const owner = await desk.connect();
  const pcOwner = await pc.connect();
  await desk.core.group.create('Home');
  await pc.core.group.join((await desk.core.group.invite()).invite);
  const pcId = pc.core.coordination.card().coreId;
  await waitFor(() => desk.core.group.peers().some(peer => peer.coreId === pcId));
  const { threadId } = await echoThread(desk, owner, 'Family helper');
  const notesPath = join(pc.dataDir, 'notes');
  mkdirSync(notesPath, { recursive: true });
  const notes = await pcOwner.call('projects.add', { path: notesPath, name: 'Notes' });
  const cli = async (args: string[], on: TestCore = desk, as = threadId) => {
    let out = '', err = '';
    const code = await runCli(args, { out: s => { out += s; }, err: s => { err += s; }, env: { BOITE_THREAD_ID: as, BOITE_CORE_URL: on.url, BOITE_AGENT_TOKEN: on.core.agents.tokenFor(as) }, cwd: on.dataDir });
    return { code, out, err };
  };
  return { desk, pc, owner, pcOwner, threadId, notes, notesPath, pcId, machine: pcId.slice(0, 8), cli };
}

test('a thread starts one on another machine of its group once that machine allows it, and hears its answer', async () => {
  const prompts = answering();
  const { desk, pc, owner, pcOwner, threadId, notes, notesPath, pcId, machine, cli } = await setup();
  // The user asked something: the cards land under that turn.
  await owner.call('turns.start', { threadId, prompt: 'Print my letter', clientRequestId: 'user-turn-1' });
  await waitFor(() => desk.core.threads.require(threadId).status === 'idle');

  // Off by default, on the machine that would hold the thread: the agent is told how to ask for it.
  const refused = await cli(['thread', 'new', 'notes', 'Print the letter on the USB printer', '--machine', machine, '--request-id', 'print-1']);
  expect(refused.code).not.toBe(0);
  // Both test cores go by this computer's host name: the command names the other by a core id prefix.
  expect(refused.err).toContain(`boite settings request groupThreads true --machine ${machine} --why`);
  expect(pc.core.journal.listThreads().filter(t => t.projectId === notes.id)).toHaveLength(0);

  // The card asks about that machine's setting, and settles when its owner turns it on there.
  const asked = await cli(['settings', 'request', 'groupThreads', 'true', '--machine', machine, '--why', 'Print from the PC', '--json']);
  expect(asked.err).toBe('');
  const card = JSON.parse(asked.out) as { setting: { machine?: { coreId: string }; previous: unknown } };
  expect(card.setting).toMatchObject({ key: 'groupThreads', value: true, previous: false, page: 'machines', machine: { coreId: pcId } });
  expect(await owner.call('questions.list', { threadId })).toHaveLength(1);
  expect(desk.core.settings.get().groupThreads ?? false).toBe(false);
  await pcOwner.call('settings.set', { groupThreads: true });
  await waitFor(() => (prompts.get(threadId) ?? []).some(p => p.includes('applied: groupThreads is now true on')));
  expect(await owner.call('questions.list', { threadId })).toHaveLength(0);

  const started = await cli(['thread', 'new', 'notes', 'Print the letter on the USB printer', '--machine', machine, '--title', 'Print the letter', '--request-id', 'print-2', '--json']);
  expect(started.err).toBe('');
  const spawned = JSON.parse(started.out) as AgentSpawn;
  expect(spawned.address).toEqual({ coreId: pcId, threadId: spawned.thread.id });
  const there = pc.core.threads.require(spawned.thread.id);
  expect(there).toMatchObject({ projectId: notes.id, cwd: notesPath, title: 'Print the letter', providerId: 'echo' });
  expect(desk.core.journal.getThread(spawned.thread.id)).toBeNull();
  const first = pc.core.journal.listMessages(spawned.thread.id).find(m => m.role === 'user')!;
  expect(first.parts[0]).toMatchObject({ displayText: 'Print the letter on the USB printer', startedBy: { threadId, title: 'Family helper', project: 'test', machine: desk.core.coordination.identity().name } });
  const line = desk.core.journal.listMessages(threadId).find(m => m.role === 'system' && m.parts.some(p => p.type === 'text' && p.started));
  expect(line?.parts[0]).toMatchObject({ started: { threadId: spawned.thread.id, project: 'Notes', machine: pc.core.coordination.identity().name } });

  // Its first answer crosses back as a letter from the thread it started.
  await waitFor(() => desk.core.coordination.get(threadId).messages.some(m => m.from.threadId === spawned.thread.id));
  const letter = desk.core.coordination.get(threadId).messages.find(m => m.from.threadId === spawned.thread.id)!;
  expect(letter.text).toBe('Print the letter: done\nDone in notes');
  expect(letter.relation).toBe('started');

  // A retry answers the same thread; the started thread cannot start another until the user writes in it.
  const again = JSON.parse((await cli(['thread', 'new', 'notes', 'Print the letter on the USB printer', '--machine', machine, '--title', 'Print the letter', '--request-id', 'print-2', '--json'])).out) as AgentSpawn;
  expect(again.thread.id).toBe(spawned.thread.id);
  await desk.core.settings.set({ groupThreads: true });
  const chained = await cli(['thread', 'new', 'test', 'Another one', '--machine', desk.core.coordination.card().coreId.slice(0, 8)], pc, spawned.thread.id);
  expect(chained.err).toContain('a thread an agent started cannot start another until the user writes in it');
});

test('another machine stays within the caller\'s communication settings and the group', async () => {
  answering();
  const { desk, pc, owner, threadId, machine, cli } = await setup();
  await pc.core.settings.set({ groupThreads: true });
  const config = await owner.call('collaboration.get', { threadId }).then(view => view.config);

  await owner.call('collaboration.configure', { threadId, config: { ...config, remote: false } });
  expect((await cli(['thread', 'new', 'notes', 'Brief', '--machine', machine])).err).toContain('may only reach its own project');
  await owner.call('collaboration.configure', { threadId, config: { ...config, mode: 'off' } });
  expect((await cli(['thread', 'new', 'notes', 'Brief', '--machine', machine])).err).toContain('communication is off');
  await owner.call('collaboration.configure', { threadId, config: { ...config, paused: true } });
  expect((await cli(['thread', 'new', 'notes', 'Brief', '--machine', machine])).err).toContain('communication is paused');
  await owner.call('collaboration.configure', { threadId, config });

  expect((await cli(['thread', 'new', 'notes', 'Brief', '--machine', 'nowhere'])).err).toContain('no machine nowhere in this group');
  expect((await cli(['thread', 'new', 'notes', 'Brief', '--machine', desk.core.coordination.card().coreId])).err).toContain('is this machine; leave --machine out');
  expect((await cli(['thread', 'new', 'nothing', 'Brief', '--machine', machine])).err).toContain('no project nothing');
  // A card about another machine asks only about what that machine lets the others do.
  expect((await cli(['settings', 'request', 'muteAgents', 'false', '--machine', machine, '--why', 'x'])).err).toContain('is this machine\'s own');
  expect((await cli(['settings', 'request', 'groupThreads', 'true', '--machine', machine, '--why', 'x'])).err).toContain('already true on');

  // A member's thread.start and setting operations arrive sealed or not at all, as the roster does.
  for (const operation of ['thread.start', 'setting.read', 'setting.changed']) {
    const body = JSON.stringify({ from: desk.core.coordination.card().coreId, to: pc.core.coordination.card().coreId, at: Date.now(), nonce: crypto.randomUUID(), operation, payload: {} });
    const clear = await fetch(`${pc.url}/agent-messages`, { method: 'POST', body, headers: { 'x-boite-peer': desk.core.coordination.card().coreId, 'x-boite-signature': desk.core.coordination.signature(Buffer.from(body)).toString('base64') } });
    expect(clear.status).toBe(400);
    expect(await clear.json()).toMatchObject({ error: 'machines of a group exchange sealed requests only' });
  }
  // A signed envelope with no operation is turned away like any malformed one.
  const blank = JSON.stringify({ from: desk.core.coordination.card().coreId, to: pc.core.coordination.card().coreId, at: Date.now(), nonce: crypto.randomUUID(), payload: {} });
  const answer = await fetch(`${pc.url}/agent-messages`, { method: 'POST', body: blank, headers: { 'x-boite-peer': desk.core.coordination.card().coreId, 'x-boite-signature': desk.core.coordination.signature(Buffer.from(blank)).toString('base64') } });
  expect([answer.status, await answer.text()]).toEqual([403, 'invalid signed message']);
});

test('a machine outside any group has no other machine to start a thread on', async () => {
  const h = await startTestCore(); cores.push(h);
  const owner = await h.connect();
  const { threadId } = await echoThread(h, owner, 'Alone');
  let err = '';
  await runCli(['thread', 'new', 'test', 'Brief', '--machine', 'pc'], { out: () => {}, err: s => { err += s; }, env: { BOITE_THREAD_ID: threadId, BOITE_CORE_URL: h.url, BOITE_AGENT_TOKEN: h.core.agents.tokenFor(threadId) }, cwd: h.dataDir });
  expect(err).toContain('this machine is in no group');
});

test('the owner turning the switch off while the worktree is prepared stops the thread before its first turn', async () => {
  const prompts = answering();
  const { pc, machine, cli, notes, notesPath } = await setup();
  await pc.core.settings.set({ groupThreads: true });
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const threads = pc.core.threads;
  const create = threads.create.bind(threads);
  threads.createInWorktree = async (params) => {
    const { worktree: _worktree, ...base } = params;
    entered.resolve();
    await release.promise;
    return create(base);
  };
  const started = cli(['thread', 'new', 'notes', 'Brief', '--machine', machine, '--worktree']);
  await entered.promise;
  await pc.core.settings.set({ groupThreads: false });
  release.resolve();
  expect((await started).err).toContain('does not let the other machines of its group start threads there');
  expect(prompts.size).toBe(0);
  // The thread made for the worktree goes with the refusal.
  expect(pc.core.journal.listThreads().filter(thread => thread.cwd.startsWith(notesPath) || thread.projectId === notes.id)).toHaveLength(0);
});

test('a card about another machine draws what that machine has, even when the owner flipped it while the read came back', async () => {
  answering();
  const { desk, pc, owner, threadId, machine, cli } = await setup();
  await owner.call('turns.start', { threadId, prompt: 'Print my letter', clientRequestId: 'user-turn-1' });
  await waitFor(() => desk.core.threads.require(threadId).status === 'idle');
  const announcements: Promise<unknown>[] = [];
  const announce = pc.core.coordination.request.bind(pc.core.coordination);
  pc.core.coordination.request = ((peer, operation, payload) => {
    const sent = announce(peer, operation, payload);
    if (operation === 'setting.changed') announcements.push(sent);
    return sent;
  }) as typeof pc.core.coordination.request;
  // The PC answers, then its owner flips the switch and its announcement lands before that answer does.
  let flipTo = true;
  const read = desk.core.coordination.request.bind(desk.core.coordination);
  desk.core.coordination.request = (async (peer, operation, payload) => {
    const answer = await read(peer, operation, payload);
    if (operation === 'setting.read') {
      const heard = announcements.length;
      await pc.core.settings.set({ groupThreads: flipTo });
      await waitFor(() => announcements.length > heard);
      await Promise.all(announcements);
    }
    return answer;
  }) as typeof desk.core.coordination.request;
  const ask = () => cli(['settings', 'request', 'groupThreads', 'true', '--machine', machine, '--why', 'Print']);

  // Read false, flipped on: there is nothing left to ask.
  expect((await ask()).err).toContain('groupThreads is already true on');
  expect(await owner.call('questions.list', { threadId })).toHaveLength(0);
  // Read true, flipped off: the card asks, from false.
  flipTo = false;
  expect((await ask()).code).toBe(0);
  const [card] = await owner.call('questions.list', { threadId });
  expect(card?.setting).toMatchObject({ key: 'groupThreads', value: true, previous: false });
});

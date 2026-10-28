import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { AgentProfile, AgentSettingAsk, AgentSpawn, CoordinationPeer } from '@boite/contracts';
import { runCli } from '../src/cli.ts';
import { connect } from '../src/client.ts';
import { setDriver } from '../src/drivers/index.ts';
import type { TurnContext, TurnResult } from '../src/drivers/types.ts';
import { EVENT_HEADER } from '../src/agents/runtime.ts';
import { batchOf, OUTBOX_MAX, type BotEvent } from '../src/agents/group-host.ts';
import { MAX_BODY } from '../src/coordination-wire.ts';
import { makeAgent, settled } from './agent-fixture.ts';
import { echoThread, removeDir, startTestCore, waitFor, type TestCore } from './harness.ts';
import { thrown } from './settle.ts';

/* A bot of one machine looks after a project another machine of its group entrusted to it. */

const cores: TestCore[] = [];
const restores: (() => unknown)[] = [];
afterEach(async () => { for (const h of cores.splice(0)) await h.stop(); for (const restore of restores.splice(0)) await restore(); });

/** An echo driver that records every prompt, answers with its folder's name and keeps quiet on events. */
function answering(wait?: (ctx: TurnContext) => Promise<void>): Map<string, string[]> {
  const prompts = new Map<string, string[]>();
  restores.push(setDriver('echo', { protocol: 'echo', startTurn(ctx: TurnContext) {
    prompts.set(ctx.thread.id, [...(prompts.get(ctx.thread.id) ?? []), ctx.prompt]);
    const id = ctx.emit.startMessage('assistant');
    ctx.emit.part(id, 0, { type: 'text', text: ctx.prompt.includes(EVENT_HEADER) ? '[quiet] read the events' : `Done in ${basename(ctx.thread.cwd)}` });
    ctx.emit.complete(id, 'complete');
    const result: TurnResult = { status: 'done', sessionId: `session:${ctx.thread.id}`, usage: null };
    return { done: wait ? wait(ctx).then(() => result) : Promise.resolve(result), stop() {} };
  } }));
  return prompts;
}

/**
 * Two machines of one group: the bot Ada on `desk`, the projects Notes and
 * Accounts on `pc`, a thread in each. `entrusted`: Notes is Ada's from the start.
 */
async function setup(entrusted = true) {
  const desk = await startTestCore();
  // pc keeps its data directory when it stops, so a test can start it again.
  const pcDir = mkdtempSync(join(tmpdir(), 'boite-core-'));
  restores.push(() => removeDir(pcDir));
  const pc = await startTestCore({ dataDir: pcDir });
  cores.push(desk, pc);
  const owner = await desk.connect();
  const pcOwner = await pc.connect();
  await desk.core.group.create('Home');
  await pc.core.group.join((await desk.core.group.invite()).invite);
  const pcId = pc.core.coordination.card().coreId;
  const deskId = desk.core.coordination.card().coreId;
  await waitFor(() => desk.core.group.peers().some(peer => peer.coreId === pcId) && pc.core.group.peers().some(peer => peer.coreId === deskId));
  const { accountId } = await echoThread(pc, pcOwner, 'Scratch');
  const folder = (name: string) => { const path = join(pc.dataDir, name); mkdirSync(path, { recursive: true }); return path; };
  const notes = await pcOwner.call('projects.add', { path: folder('notes'), name: 'Notes' });
  const accounts = await pcOwner.call('projects.add', { path: folder('accounts'), name: 'Accounts' });
  const letter = (await pcOwner.call('threads.create', { projectId: notes.id, providerId: 'echo', accountId, title: 'Letter' })).id;
  const ledger = (await pcOwner.call('threads.create', { projectId: accounts.id, providerId: 'echo', accountId, title: 'Ledger' })).id;
  await echoThread(desk, owner, 'Home');
  const grant = `${pcId}/${notes.id}`;
  const made = await makeAgent(desk, owner, entrusted ? { projectIds: [grant] } : {});
  let agent = made.agent;
  const self = made.threadId;
  // Held, so the facts the bot hears stay waiting where the test can read them.
  desk.core.workforce.setLimits({ paused: true });
  const cli = async (args: string[]) => {
    let out = '', err = '';
    const code = await runCli(args, { out: s => { out += s; }, err: s => { err += s; }, env: { BOITE_THREAD_ID: self, BOITE_CORE_URL: desk.url, BOITE_AGENT_TOKEN: desk.core.agents.tokenFor(self) }, cwd: desk.dataDir });
    // Bun 1.4.2 on Windows can free a closed socket's poll request twice when the next
    // connection opens in the same tick (uv__fast_poll_process_poll_req): let the close land first.
    await Bun.sleep(5);
    return { code, out, err };
  };
  const facts = () => desk.core.agentRuntime.facts(agent.id);
  const fresh = () => { agent = desk.core.workforce.records.get('profile', agent.id); return agent as AgentProfile; };
  // Both test cores go by this computer's host name: the CLI names the other by a core id prefix.
  const machine = pcId.slice(0, 8);
  return { desk, pc, owner, pcOwner, pcId, deskId, notes, accounts, letter, ledger, grant, self, cli, facts, agent: fresh, machine, ref: `${machine}/${letter}` };
}

test('a bot sees, drives and hears a thread of a project another machine entrusted to it, until that machine takes its permission back', async () => {
  const prompts = answering();
  const { desk, pc, pcOwner, pcId, deskId, letter, ledger, self, cli, facts, agent, machine, ref } = await setup();

  // Off by default on the machine that holds the project: the bot is told how to ask for it, and sees nothing there.
  const closed = await cli(['threads']);
  expect(closed.code).toBe(0);
  expect(closed.out).toContain(`unavailable: ${pc.core.info().hostname} does not let the bots of the other machines of its group look after its projects`);
  expect(closed.out).toContain(`boite settings request groupBots true --machine ${machine} --why`);
  expect(closed.out).not.toContain(letter);

  await pcOwner.call('settings.set', { groupBots: true });
  // Invalid targets fail as targets, without contaminating the lease shared by concurrent requests.
  for (const target of ['', 'x'.repeat(129)]) {
    expect(await thrown(desk.core.workforce.group.send({ threadId: self, machine, target, text: 'Invalid target', requestId: `invalid-${target.length}` }))).toThrow('bot.send.target');
  }
  const listed = await cli(['threads']);
  expect([listed.code, listed.err]).toEqual([0, '']);
  // The entrusted project's thread, named by its machine; Accounts was not entrusted, so its thread stays out.
  expect(listed.out.trim().split('\n')).toEqual([`${ref} idle "Letter" project="Notes" machine=${machine}`]);
  expect((await cli(['threads', '--project', `${machine}/notes`])).out.trim()).toBe(`${ref} idle "Letter" project="Notes" machine=${machine}`);
  // The machine part is taken as --machine takes it: a shorter core id prefix names it too.
  expect((await cli(['threads', '--project', `${pcId.slice(0, 6)}/Notes`])).out.trim()).toBe(`${ref} idle "Letter" project="Notes" machine=${machine}`);
  expect((await cli(['thread', 'show', ref])).out).toStartWith(`${ref} idle "Letter"`);
  expect((await cli(['thread', 'show', `${machine}/${ledger}`])).err).toContain(`${ledger} is not a thread of the projects`);
  // A rejected send must not leave its provisional watch in later leases.
  const denied = await cli(['thread', 'send', `${machine}/${ledger}`, 'Outside the grant']);
  expect(denied.err).toContain(`${ledger} is not a thread of the projects`);
  await desk.core.workforce.group.sync(pcId);
  expect(pc.core.workforce.groupHost.leases(deskId)[agent().id]!.watched).toEqual([]);

  await cli(['thread', 'rename', ref, 'Letter to the bank']);
  expect(pc.core.threads.require(letter).title).toBe('Letter to the bank');

  // Its message reaches the thread as the bot's, and the turn it starts comes back as an event, without polling.
  const sent = await cli(['thread', 'send', ref, 'Draft it', '--request-id', 'draft-1']);
  expect([sent.code, sent.err]).toEqual([0, '']);
  expect(sent.out).toContain('as: the agent of its project');
  await waitFor(() => (prompts.get(letter) ?? []).some(prompt => prompt.includes('Draft it')));
  await waitFor(() => facts().some(fact => fact.text.includes(`Turn done in thread ${ref} on ${pc.core.info().hostname}, titled "Letter to the bank"`)));
  expect(facts().find(fact => fact.text.includes(ref))!.key).toStartWith(`remote:${pcId}:turn:`);
  // The thread it wrote to is on its desk, with the machine it is on.
  expect(desk.core.workforce.group.desk(agent())).toMatchObject([{ threadId: letter, coreId: pcId, machine, state: 'idle' }]);
  expect(pc.core.workforce.groupHost.leases(deskId)[agent().id]!.watched).toEqual([letter]);
  // A row from that machine is bounded before the desk keeps it: a long title is cut, an id that does not fit is dropped.
  const pcPeer = desk.core.group.peers().find(member => member.coreId === pcId)! as CoordinationPeer;
  const row = pc.core.workforce.projects.row(pc.core.threads.require(letter));
  await desk.core.workforce.group.peer(pcPeer, 'bot.event', { events: [
    { agentId: agent().id, key: 'row:long', kind: 'row', row: { ...row, title: 'x'.repeat(5_000) } },
    { agentId: agent().id, key: 'row:huge', kind: 'row', row: { ...row, id: 'y'.repeat(5_000) } },
  ] });
  expect(desk.core.workforce.group.desk(agent()).map(watch => [watch.threadId, watch.title.length])).toEqual([[letter, 300]]);
  await desk.core.workforce.group.peer(pcPeer, 'bot.event', { events: [{ agentId: agent().id, key: 'row:back', kind: 'row', row }] });

  // A question there reaches it, and it answers with the id the list prints.
  const peer = pc.core.group.peers().find(member => member.coreId === deskId)! as CoordinationPeer;
  const lease = pc.core.workforce.groupHost.leases(deskId)[agent().id]!;
  const asker = await connect(pc.url, pc.core.agents.tokenFor(letter));
  try {
    const { questionId } = await asker.call('questions.ask', { threadId: letter, text: 'Send it now?', options: ['Yes', 'No'] });
    await waitFor(() => facts().some(fact => fact.key === `remote:${pcId}:ask:${questionId}`));
    expect((await cli(['questions'])).out).toContain(`question ${questionId} (${ref}, one option, or text): Send it now?`);
    // The JSON names the thread as the text does, so `boite answer` takes the id either prints.
    expect(JSON.parse((await cli(['thread', 'show', ref, '--json'])).out).questions).toMatchObject([{ id: questionId, threadId: ref }]);
    // The machine holding the thread bounds what an answer carries before the question sees it.
    expect(await thrown(pc.core.workforce.groupHost.handle(peer, 'bot.answer', { lease, target: letter, questionId, optionIds: [{}] }))).toThrow('bot.answer.optionIds[0]');
    expect(await thrown(pc.core.workforce.groupHost.handle(peer, 'bot.answer', { lease, target: letter, questionId, optionIds: [], text: 'x'.repeat(12_001) }))).toThrow('bot.answer.text');
    const answered = await cli(['answer', ref, questionId, 'Yes']);
    expect([answered.code, answered.err]).toEqual([0, '']);
    expect(pc.core.threads.listQuestions(letter)).toEqual([]);
  } finally { asker.close(); }

  // Deleting and permissions stay the owner's, on the bot's side and on the machine that holds the thread.
  expect((await cli(['thread', 'remove', ref])).err).toContain("deleting a thread is the owner's");
  expect((await cli(['allow', ref, 'perm_x'])).err).toContain("deciding a tool permission is the owner's");
  expect(await thrown(pc.core.workforce.groupHost.handle(peer, 'bot.act', { lease, target: letter, action: 'remove' }))).toThrow("deleting a thread stays the owner's");
  expect(pc.core.journal.getThread(letter)).not.toBeNull();

  // The answer reaches the thread as a turn: done waits for an idle thread.
  await waitFor(() => settled(pc, letter));
  const done = await cli(['thread', 'done', ref]);
  expect([done.code, done.err]).toEqual([0, '']);
  expect(pc.core.threads.require(letter)).toMatchObject({ archived: true });
  expect(pc.core.threads.require(letter).doneAt).not.toBeNull();
  await cli(['thread', 'unarchive', ref]);

  // That machine takes its permission back: the next request is refused there at once.
  await pcOwner.call('settings.set', { groupBots: false });
  const cut = await cli(['thread', 'show', ref]);
  expect(cut.code).not.toBe(0);
  expect(cut.err).toContain('does not let the bots of the other machines of its group look after its projects');
  // Its thread stays on the desk as last seen, saying why it cannot be reached.
  expect((await cli(['threads'])).out).toStartWith(`${ref} idle "Letter to the bank" desk=followed machine=${machine} unreachable="${pc.core.info().hostname} has groupBots off"\nunavailable: `);
  expect(await thrown(pc.core.workforce.groupHost.handle(peer, 'bot.thread', { lease, target: letter }))).toThrow('groupBots is off on this machine');
}, 30_000);

test('a machine that does not answer is named unreachable, and its events reach the bot once it answers again', async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  answering(ctx => ctx.prompt.includes('Draft it') ? held : Promise.resolve());
  restores.push(() => release());
  const { desk, pc, pcOwner, pcId, deskId, letter, cli, facts, agent, machine, ref } = await setup();
  // A lease sync may finish while the send's answer is still on its way back.
  const deskRequest = desk.core.coordination.request.bind(desk.core.coordination);
  desk.core.coordination.request = (async (to: CoordinationPeer, operation: string, payload: unknown) => {
    const result = await deskRequest(to, operation as never, payload);
    if (operation === 'bot.send') {
      await desk.core.workforce.group.sync(pcId);
      release();
    }
    return result;
  }) as typeof deskRequest;
  restores.push(() => { desk.core.coordination.request = deskRequest; });
  await pcOwner.call('settings.set', { groupBots: true });
  await cli(['thread', 'send', ref, 'Draft it', '--request-id', 'draft-1']);
  const turnFacts = () => facts().filter(fact => fact.key.startsWith(`remote:${pcId}:turn:`));
  await waitFor(() => turnFacts().length === 1);

  // The bot's machine goes away while pc has an event for it: the event waits there.
  const real = pc.core.coordination.request.bind(pc.core.coordination);
  let away = true, tried = 0;
  pc.core.coordination.request = (async (to: CoordinationPeer, operation: string, payload: unknown) => {
    if (away && operation === 'bot.event') { tried += 1; throw new Error('connect ECONNREFUSED'); }
    return real(to, operation as never, payload);
  }) as typeof real;
  restores.push(() => { pc.core.coordination.request = real; });
  await pcOwner.call('turns.start', { threadId: letter, prompt: 'Second pass' });
  await waitFor(() => tried > 0 && settled(pc, letter) && pc.core.workforce.groupHost.outbox(deskId).some(event => event.kind === 'turn'));
  expect(turnFacts()).toHaveLength(1);

  // It is back: its next request tells pc so, and what waited goes at once rather than after the 5 s retry.
  away = false;
  await cli(['threads']);
  await waitFor(() => turnFacts().length === 2, 3_000);
  await waitFor(() => pc.core.workforce.groupHost.outbox(deskId).length === 0);

  // pc stops answering at all: the bot reads its name and why, never a silent empty list.
  await pc.stop();
  const listed = await cli(['threads']);
  expect(listed.code).toBe(0);
  expect(listed.out).toContain(`unavailable: ${machine} is unreachable (`);
  // Its JSON says so too: an empty list is not taken for nothing pending.
  const pending = JSON.parse((await cli(['questions', '--json'])).out) as { questions: unknown[]; unavailable: string[] };
  expect(pending.questions).toEqual([]);
  expect(pending.unavailable).toEqual([expect.stringContaining(`${machine} is unreachable (`)]);
  const shown = await cli(['thread', 'show', ref]);
  expect(shown.code).not.toBe(0);
  expect(shown.err).toContain(`${machine} is unreachable (`);
  expect(shown.err).toContain('its events reach you once it is back');
  const [row] = desk.core.workforce.group.desk(agent());
  expect(row).toMatchObject({ threadId: letter, coreId: pcId });
  expect(row!.unreachable).toContain('is unreachable');

  // pc starts again with the bot's thread on its lease: it tells the bot's machine how that thread stands, which clears the mark.
  const again = await startTestCore({ dataDir: pc.dataDir });
  cores.push(again);
  await waitFor(() => desk.core.workforce.group.desk(agent())[0]?.unreachable === undefined, 5_000);
  // The mark clears as the event lands; pc empties its outbox once the request returns.
  await waitFor(() => again.core.workforce.groupHost.outbox(deskId).length === 0);
}, 30_000);

test('a setting card offers the projects of the other machines by machine, and the owner applying it entrusts one', async () => {
  answering();
  const { desk, owner, pc, pcOwner, pcId, deskId, notes, accounts, letter, grant, self, cli, agent, machine } = await setup(false);
  await pcOwner.call('settings.set', { groupBots: true });
  // A sync already on its way when the card reads the names: the read waits for it rather than reading none.
  const real = desk.core.coordination.request.bind(desk.core.coordination);
  let slow = true;
  desk.core.coordination.request = (async (to: CoordinationPeer, operation: string, payload: unknown) => {
    if (slow && operation === 'bot.lease') { slow = false; await Bun.sleep(300); }
    return real(to, operation as never, payload);
  }) as typeof real;
  restores.push(() => { desk.core.coordination.request = real; });
  void desk.core.workforce.group.sync(pcId).catch(() => undefined);
  const read = await cli(['settings', 'bot', 'projects']);
  expect([read.code, read.err]).toEqual([0, '']);
  expect(read.out).toContain(`${machine}/Notes (${grant})`);
  expect(read.out).toContain(`${machine}/Accounts (${pcId}/${accounts.id})`);

  const asked = await cli(['settings', 'bot', 'request', 'projects', `+${machine}/Notes`, '--why', 'Look after the letters', '--json']);
  expect(asked.err).toBe('');
  const card = JSON.parse(asked.out) as { questionId: string; setting: AgentSettingAsk };
  expect(card.setting.value).toEqual([grant]);
  expect(card.setting.labels).toEqual({ [grant]: `${machine}/Notes` });
  await owner.call('agents.settings.apply', { threadId: self, questionId: card.questionId });
  await waitFor(() => agent().projectIds?.includes(grant) === true);
  // pc hears the grant now, not at the bot's first request.
  await waitFor(() => pc.core.workforce.groupHost.leases(deskId)[agent().id]?.projectIds.includes(notes.id) === true);

  // A project of a machine outside the group cannot be entrusted.
  const current = agent();
  expect(await thrown(owner.call('agents.profile.save', { id: current.id, expectedRevision: current.revision, value: { ...current, projectIds: ['core_elsewhere/prj_x'] } }))).toThrow();

  // Taking back its last project of pc empties the lease there, and pc stops answering for that bot at once.
  await owner.call('agents.profile.save', { id: current.id, expectedRevision: current.revision, value: { ...current, projectIds: [] } });
  await waitFor(() => pc.core.workforce.groupHost.leases(deskId)[agent().id] === undefined);
  expect((await cli(['threads'])).out).not.toContain(letter);
}, 30_000);

test('the machine holding the projects decides: its own switch, members of its group only, open projects only', async () => {
  answering();
  const { pc, pcOwner, deskId, notes, accounts, letter, ledger, agent } = await setup();
  const host = pc.core.workforce.groupHost;
  const peer = pc.core.group.peers().find(member => member.coreId === deskId)! as CoordinationPeer;
  // Newer than any lease the bot's machine sends during the test, so this one stays.
  const lease = { agentId: agent().id, threadId: 'thr_bot', name: 'Ada', projectIds: [notes.id, accounts.id], watched: [], v: Date.now() * 10 };
  expect(await thrown(host.handle(peer, 'bot.threads', { lease }))).toThrow('groupBots is off on this machine');
  await pcOwner.call('settings.set', { groupBots: true });
  expect(await thrown(host.handle({ ...peer, coreId: 'core_stranger' }, 'bot.threads', { lease }))).toThrow('only a machine of this core\'s group');
  expect((await host.handle(peer, 'bot.threads', { lease }) as { id: string }[]).map(row => row.id).sort()).toEqual([letter, ledger].sort());
  // An archived project leaves every lease, and the list of projects a bot may be entrusted.
  await pcOwner.call('projects.archive', { projectId: accounts.id, archived: true });
  expect(host.scope(lease)).toEqual([notes.id]);
  expect((await host.handle(peer, 'bot.threads', { lease }) as { id: string }[]).map(row => row.id)).toEqual([letter]);
  expect(await thrown(host.handle(peer, 'bot.thread', { lease, target: ledger }))).toThrow(`${ledger} is not a thread of the projects`);
  const offered = await host.handle(peer, 'bot.lease', { v: lease.v + 1, leases: [lease] }) as { projects: { name: string }[] };
  expect(offered.projects.map(project => project.name)).toContain('Notes');
  expect(offered.projects.map(project => project.name)).not.toContain('Accounts');
}, 30_000);

test('a bot starts a thread in a project another machine entrusted to it, and hears its first answer once, on its desk', async () => {
  const prompts = answering();
  const { desk, pc, pcOwner, pcId, deskId, notes, self, cli, facts, agent, machine } = await setup();
  await pcOwner.call('settings.set', { groupBots: true });
  const started = await cli(['thread', 'new', `${machine}/Notes`, 'Sort the letters', '--title', 'Sort', '--request-id', 'sort-1']);
  expect([started.code, started.err]).toEqual([0, '']);
  const id = /^thread: (\S+)$/m.exec(started.out)![1]!;
  const ref = `${machine}/${id}`;
  expect(started.out).toContain(`machine: ${machine}`);
  expect(started.out).toContain(`It is on your desk; each turn it ends wakes you with an event, so do not poll. boite thread send ${ref} <text> steers it.`);

  // The machine of the project holds it, marked as the bot's.
  expect(pc.core.threads.require(id)).toMatchObject({ projectId: notes.id, title: 'Sort', providerId: 'echo' });
  expect(desk.core.journal.getThread(id)).toBeNull();
  const deskName = desk.core.coordination.identity().name;
  const first = pc.core.journal.listMessages(id).find(m => m.role === 'user')!;
  expect(first.parts[0]).toMatchObject({ displayText: 'Sort the letters', startedBy: { threadId: self, title: agent().name, projectId: notes.id, project: 'Notes', machine: deskName } });
  expect(prompts.get(id)?.[0]).toContain(`This thread was started by ${agent().name}, a bot of the user's on ${deskName}`);
  const line = desk.core.journal.listMessages(self).find(m => m.role === 'system' && m.parts.some(p => p.type === 'text' && p.started));
  expect(line?.parts[0]).toMatchObject({ started: { threadId: id, project: 'Notes', machine: pc.core.coordination.identity().name } });

  // It is on the bot's desk at once, on both machines.
  expect(desk.core.workforce.group.desk(agent())).toMatchObject([{ threadId: id, coreId: pcId, machine, origin: 'started' }]);
  expect(pc.core.workforce.groupHost.leases(deskId)[agent().id]!.watched).toContain(id);

  // Its first answer reaches the bot once, as an event of its desk, never as a letter.
  const answered = () => facts().filter(fact => fact.text.includes(`Turn done in thread ${ref} on ${pc.core.info().hostname}, titled "Sort"`));
  await waitFor(() => answered().length === 1);
  await waitFor(() => pc.core.workforce.groupHost.outbox(deskId).length === 0);
  expect(answered()[0]!.text).toContain('Done in notes');
  expect(desk.core.coordination.get(self).messages.filter(m => m.from.threadId === id)).toEqual([]);

  // A retry answers the same thread: the bot's machine keeps what it started, and the other one what it was asked.
  const again = await cli(['thread', 'new', `${machine}/Notes`, 'Sort the letters', '--title', 'Sort', '--request-id', 'sort-1', '--json']);
  expect((JSON.parse(again.out) as AgentSpawn).thread.id).toBe(id);
  const peer = pc.core.group.peers().find(member => member.coreId === deskId)! as CoordinationPeer;
  const lease = pc.core.workforce.groupHost.leases(deskId)[agent().id]!;
  const ask = { lease, project: notes.id, prompt: 'File them', title: 'File', worktree: false, requestId: 'file-1', agent: { providerId: 'echo', model: null, effort: null, speed: null, permissionMode: 'default' } };
  const once = await pc.core.workforce.groupHost.handle(peer, 'bot.start', ask) as AgentSpawn;
  expect((await pc.core.workforce.groupHost.handle(peer, 'bot.start', ask) as AgentSpawn).thread.id).toBe(once.thread.id);
  expect(pc.core.journal.listThreads().filter(t => t.projectId === notes.id).map(t => t.title).sort()).toEqual(['File', 'Letter', 'Sort']);
  expect(answered()).toHaveLength(1);
}, 30_000);

test('a bot starts no thread on a machine whose groupBots is off, nor in a project of it not entrusted to the bot', async () => {
  answering();
  const { desk, pc, pcOwner, deskId, notes, accounts, cli, agent, machine } = await setup();
  const off = await cli(['thread', 'new', `${machine}/Notes`, 'Sort the letters', '--request-id', 'sort-1']);
  expect(off.code).not.toBe(0);
  expect(off.err).toContain('does not let the bots of the other machines of its group look after its projects');
  expect(off.err).toContain(`boite settings request groupBots true --machine ${machine} --why`);
  expect(pc.core.journal.listThreads().filter(t => t.projectId === notes.id).map(t => t.title)).toEqual(['Letter']);

  await pcOwner.call('settings.set', { groupBots: true });
  // A project of that machine not entrusted to it: the refusal names the ones it may use there.
  const outside = await cli(['thread', 'new', 'Accounts', 'Pay the bills', '--machine', machine]);
  expect(outside.code).not.toBe(0);
  expect(outside.err).toContain(`Accounts is not a project of ${pc.core.info().hostname} entrusted to ${agent().name}; there it may start threads in ${machine}/Notes, and here in any project`);
  // That machine checks on its own too, whatever the bot's machine sent.
  const peer = pc.core.group.peers().find(member => member.coreId === deskId)! as CoordinationPeer;
  const lease = pc.core.workforce.groupHost.leases(deskId)[agent().id]!;
  expect(await thrown(pc.core.workforce.groupHost.handle(peer, 'bot.start', { lease, project: accounts.id, prompt: 'Pay the bills', title: 'Pay', worktree: false, requestId: 'pay-1', agent: { providerId: 'echo', permissionMode: 'default' } })))
    .toThrow(`bot.start.project: ${accounts.id} is not a project entrusted to ${agent().name} here; its projects here are Notes`);
  expect(pc.core.journal.listThreads().filter(t => t.projectId === accounts.id).map(t => t.title)).toEqual(['Ledger']);

  // --machine with the project's name there starts it.
  const started = await cli(['thread', 'new', 'notes', 'Sort the letters', '--machine', machine, '--json']);
  expect(started.err).toBe('');
  const spawned = JSON.parse(started.out) as AgentSpawn;
  expect(spawned).toMatchObject({ project: 'Notes', machine, address: { coreId: pc.core.coordination.card().coreId } });
  expect(desk.core.workforce.group.desk(agent()).map(watch => watch.threadId)).toEqual([spawned.thread.id]);
}, 30_000);

test('a bot\'s thread on a machine that does not answer is refused, naming it', async () => {
  answering();
  const { desk, pc, pcOwner, cli, machine } = await setup();
  await pcOwner.call('settings.set', { groupBots: true });
  await waitFor(() => desk.core.workforce.group.choices().some(choice => choice.label === `${machine}/Notes`));
  await pc.stop();
  const away = await cli(['thread', 'new', `${machine}/Notes`, 'Sort the letters', '--request-id', 'sort-1']);
  expect(away.code).not.toBe(0);
  expect(away.err).toContain(`${machine} is unreachable (`);
  expect(away.err).toContain('the same --request-id later answers the thread if it started there');
}, 30_000);

test('a thread a bot started on another machine whose answer was lost comes back on its desk, and its first answer reaches the bot once', async () => {
  let finish!: () => void;
  const held = new Promise<void>(resolve => { finish = resolve; });
  answering(ctx => ctx.prompt.includes('Sort the letters') ? held : Promise.resolve());
  const { desk, pc, pcOwner, pcId, deskId, cli, facts, agent, machine } = await setup();
  await pcOwner.call('settings.set', { groupBots: true });
  await desk.core.workforce.group.sync(pcId);
  // That machine starts the thread, then its answer is lost on the way back.
  const request = desk.core.coordination.request.bind(desk.core.coordination);
  desk.core.coordination.request = async (peer, op, payload) => {
    const result = await request(peer, op, payload);
    if (op === 'bot.start') throw new Error('connection reset');
    return result;
  };
  const lost = await cli(['thread', 'new', `${machine}/Notes`, 'Sort the letters', '--title', 'Sort', '--request-id', 'sort-1']);
  expect(lost.code).not.toBe(0);
  desk.core.coordination.request = request;
  const id = pc.core.journal.listThreads().find(t => t.title === 'Sort')!.id;
  expect(desk.core.workforce.group.desk(agent())).toEqual([]);

  // A lease sync that does not list it keeps it watched there, and the desk takes it back.
  await desk.core.workforce.group.sync(pcId);
  expect(pc.core.workforce.groupHost.leases(deskId)[agent().id]!.watched).toContain(id);
  expect(desk.core.workforce.group.desk(agent())).toMatchObject([{ threadId: id, coreId: pcId, origin: 'started' }]);

  finish();
  const answered = () => facts().filter(fact => fact.text.includes(`Turn done in thread ${machine}/${id}`));
  await waitFor(() => answered().length === 1);
  const again = await cli(['thread', 'new', `${machine}/Notes`, 'Sort the letters', '--title', 'Sort', '--request-id', 'sort-1', '--json']);
  expect((JSON.parse(again.out) as AgentSpawn).thread.id).toBe(id);
  await desk.core.workforce.group.sync(pcId);
  await waitFor(() => pc.core.workforce.groupHost.outbox(deskId).length === 0);
  expect(answered()).toHaveLength(1);
  // The bot's lease lists it now: that machine holds it as any thread the bot follows.
  expect(pc.core.workforce.groupHost.leases(deskId)[agent().id]).toMatchObject({ watched: [id] });
  expect(pc.core.workforce.groupHost.leases(deskId)[agent().id]!.started).toBeUndefined();
}, 30_000);

test('a thread a bot started on another machine and took off its desk before any lease sync stays off it', async () => {
  answering();
  const { desk, pc, pcOwner, pcId, deskId, cli, agent, machine } = await setup();
  await pcOwner.call('settings.set', { groupBots: true });
  await desk.core.workforce.group.sync(pcId);
  const started = await cli(['thread', 'new', `${machine}/Notes`, 'Sort the letters', '--title', 'Sort', '--request-id', 'sort-1']);
  const ref = `${machine}/${/^thread: (\S+)$/m.exec(started.out)![1]!}`;
  const id = ref.slice(machine.length + 1);
  expect((await cli(['bot', 'unwatch', ref])).code).toBe(0);
  expect(desk.core.workforce.group.desk(agent())).toEqual([]);
  // The lease that tells that machine so lets the start go there, and nothing puts it back.
  await desk.core.workforce.group.sync(pcId);
  expect(desk.core.workforce.group.desk(agent())).toEqual([]);
  expect(pc.core.workforce.groupHost.leases(deskId)[agent().id]).toMatchObject({ watched: [] });
  expect(pc.core.workforce.groupHost.leases(deskId)[agent().id]!.started).toBeUndefined();
  // Watching it again is the owner's or the bot's call, as for any thread there.
  expect((await cli(['bot', 'watch', ref])).code).toBe(0);
  await desk.core.workforce.group.sync(pcId);
  expect(desk.core.workforce.group.desk(agent()).map(watch => watch.threadId)).toEqual([id]);
  expect(pc.core.workforce.groupHost.leases(deskId)[agent().id]).toMatchObject({ watched: [id] });
}, 30_000);

test('a full outbox goes in requests a member accepts, oldest first, none left behind', () => {
  const row = { id: 'thr_x', title: 'Letter', projectId: 'prj_x', project: 'Notes', status: 'idle', archived: false, branch: null, questions: 0, permissions: 0, pullRequest: null, updatedAt: 1, lastCompletedAt: null } as const;
  const events: BotEvent[] = Array.from({ length: OUTBOX_MAX }, (_, index) => ({ agentId: 'agt_ada', kind: 'turn', key: `turn:${index}`, row, status: 'done', answer: 'x'.repeat(1_500) + 'é'.repeat(1_000) }));
  const sent: BotEvent[] = [];
  for (let left = events; left.length > 0;) {
    const batch = batchOf(left);
    // A sealed request carries its plaintext as base64, a third larger.
    expect(Buffer.byteLength(JSON.stringify({ events: batch })) * 4 / 3).toBeLessThan(MAX_BODY);
    sent.push(...batch);
    left = left.slice(batch.length);
  }
  expect(sent.map(event => event.key)).toEqual(events.map(event => event.key));
});
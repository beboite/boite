import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { AgentLetter, AgentProfile, AgentWatch, ProjectThreadRow } from '@boite/contracts';
import { runCli } from '../src/cli.ts';
import { setDriver } from '../src/drivers/index.ts';
import type { TurnContext, TurnResult } from '../src/drivers/types.ts';
import { connect } from '../src/client.ts';
import { QUESTION_GRACE_MS } from '../src/agents/projects.ts';
import { EVENT_HEADER } from '../src/agents/runtime.ts';
import { makeAgent, settled } from './agent-fixture.ts';
import { echoThread, startTestCore, waitFor, type TestCore } from './harness.ts';
import { thrown } from './settle.ts';

const cores: TestCore[] = [];
const restores: (() => void)[] = [];
afterEach(async () => { for (const h of cores.splice(0)) await h.stop(); for (const restore of restores.splice(0)) restore(); });

/**
 * An echo driver that records every prompt. It answers with its folder's name,
 * fails a prompt that says FAIL-ME, and keeps quiet on events.
 */
function answering(): Map<string, string[]> {
  const prompts = new Map<string, string[]>();
  restores.push(setDriver('echo', { protocol: 'echo', startTurn(ctx: TurnContext) {
    prompts.set(ctx.thread.id, [...(prompts.get(ctx.thread.id) ?? []), ctx.prompt]);
    const failing = ctx.prompt.includes('FAIL-ME') && !ctx.prompt.includes(EVENT_HEADER);
    const id = ctx.emit.startMessage('assistant');
    ctx.emit.part(id, 0, { type: 'text', text: ctx.prompt.includes(EVENT_HEADER) ? '[quiet] read the events' : `Done in ${basename(ctx.thread.cwd)}` });
    ctx.emit.complete(id, 'complete');
    const result: TurnResult = failing ? { status: 'error', error: 'Asked to fail', sessionId: null, usage: null } : { status: 'done', sessionId: `session:${ctx.thread.id}`, usage: null };
    return { done: Promise.resolve(result), stop() {} };
  } }));
  return prompts;
}

async function setup(entrusted: ('test' | 'Other' | 'Notes')[] = ['test', 'Other']) {
  const h = await startTestCore(); cores.push(h);
  const owner = await h.connect();
  const { threadId: worker, accountId } = await echoThread(h, owner, 'Worker');
  const project = h.core.threads.require(worker).projectId!;
  const thread = (title: string, projectId: string) => owner.call('threads.create', { projectId, providerId: 'echo', accountId, title });
  const folder = (name: string) => { const path = join(h.dataDir, name); mkdirSync(path, { recursive: true }); return path; };
  const notes = await owner.call('projects.add', { path: folder('notes'), name: 'Notes' });
  const other = await owner.call('projects.add', { path: folder('other'), name: 'Other' });
  const outside = (await thread('Outside', notes.id)).id;
  const ids = { test: project, Other: other.id, Notes: notes.id };
  const made = await makeAgent(h, owner, { projectIds: entrusted.map(name => ids[name]), selection: { providerId: 'echo', accountId, model: 'echo', effort: null, permissionMode: 'default' } });
  let agent = made.agent;
  const self = made.threadId;
  const run = async (args: string[], env: Record<string, string>) => {
    let out = '', err = '';
    const code = await runCli(args, { out: s => { out += s; }, err: s => { err += s; }, env, cwd: h.dataDir });
    // Bun 1.4.2 on Windows can free a closed socket's poll request twice when the next
    // connection opens in the same tick (uv__fast_poll_process_poll_req): let the close land first.
    await Bun.sleep(5);
    return { code, out, err };
  };
  /** The agent, from its own thread, or the agent of another thread. */
  const cli = (args: string[], as = self) => run(args, { BOITE_THREAD_ID: as, BOITE_CORE_URL: h.url, BOITE_AGENT_TOKEN: h.core.agents.tokenFor(as) });
  /** The owner at a terminal, reaching the core by address with the token in the environment. */
  const terminal = (args: string[]) => run([...args, '--core', h.url], { BOITE_TOKEN: h.token });
  const off = async (threadId: string) => owner.call('collaboration.configure', { threadId, config: { ...h.core.coordination.config(threadId), mode: 'off' } });
  const entrust = async (names: ('test' | 'Other' | 'Notes')[]) => {
    const current = h.core.workforce.records.get('profile', agent.id);
    agent = await owner.call('agents.profile.save', { id: agent.id, expectedRevision: current.revision, value: { ...current, projectIds: names.map(name => ids[name]) } });
    return agent;
  };
  /** The facts waiting for the agent's next event turn. */
  const facts = () => h.core.agentRuntime.facts(agent.id);
  /** Makes the waiting facts due now, the way their delay running out would. */
  const hurry = () => {
    const pending = (h.core.agentRuntime as unknown as { pending: Map<string, { facts: { notBefore: number }[] }> }).pending.get(agent.id);
    for (const fact of pending?.facts ?? []) fact.notBefore = 0;
  };
  const events = () => h.core.journal.listTurns(self).filter(t => t.execution?.operation === 'event');
  return { h, owner, self, worker, outside, project, notes, other, cli, terminal, off, entrust, facts, hurry, events, thread, agent: () => agent as AgentProfile };
}

function lines(threadId: string, h: TestCore): string[] {
  return h.core.journal.listMessages(threadId).filter(m => m.role === 'system').flatMap(m => m.parts.flatMap(p => p.type === 'text' ? [p.text] : []));
}

test('an agent reads and drives only the threads of the projects entrusted to it; deleting and permissions stay the owner\'s', async () => {
  answering(); const { h, owner, self, worker, outside, notes, cli, entrust, agent } = await setup();
  const listed = JSON.parse((await cli(['threads', '--json'])).out) as { rows: ProjectThreadRow[]; desk: AgentWatch[] };
  expect(listed.rows.map(row => row.id)).toEqual([worker]);
  expect(listed.desk).toEqual([]);
  // A thread the owner put on its desk lists after its projects' threads, marked as the desk's, with its machine.
  h.core.workforce.watch({ agentId: agent().id, watchThreadId: outside, watched: true });
  const rowsOut = (await cli(['threads', 'list'])).out.trim().split('\n');
  expect(rowsOut[0]).toStartWith(`${worker} idle "Worker"`);
  expect(rowsOut[0]).toEndWith('machine=here');
  expect(rowsOut[1]).toBe(`${outside} idle "Outside" desk=followed machine=here`);
  expect((await cli(['threads', '--project', 'Notes'])).out.trim()).toBe(rowsOut[1]!);
  h.core.workforce.watch({ agentId: agent().id, watchThreadId: outside, watched: false });
  expect((await cli(['thread', 'show', outside])).err).toContain('is not a thread of the projects entrusted to this bot');
  expect((await cli(['thread', 'show', self])).err).toContain('is not a thread of the projects entrusted to this bot');

  expect((await cli(['thread', 'archive', worker])).code).toBe(0);
  expect(h.core.threads.require(worker).archived).toBe(true);
  expect((await cli(['threads', '--archived'])).out).toContain(worker);
  await cli(['thread', 'unarchive', worker]);
  await cli(['thread', 'rename', worker, 'Ship the release']);
  expect(h.core.threads.require(worker).title).toBe('Ship the release');
  expect((await cli(['thread', 'move', 'Other', worker])).code).toBe(0);
  await waitFor(() => h.core.journal.getProject(h.core.threads.require(worker).projectId!)?.name === 'Other');
  expect((await cli(['thread', 'move', 'Notes', worker])).err).toContain('Notes is not entrusted to this bot');
  expect(lines(worker, h).some(text => text === 'Archived by Ada, the bot the user entrusted this project to.')).toBe(true);
  expect(lines(worker, h).some(text => text.startsWith('Renamed "Ship the release" by Ada'))).toBe(true);

  expect((await cli(['thread', 'remove', worker])).err).toContain("deleting a thread is the owner's");
  expect((await cli(['allow', worker, 'perm_x'])).err).toContain("deciding a tool permission is the owner's");
  expect(h.core.journal.getThread(worker)).not.toBeNull();

  // Drafts and unknown folders cannot be entrusted; taking the projects back closes every door.
  const drafts = h.core.journal.listProjects().find(project => project.kind === 'drafts');
  if (drafts) expect(await thrown(owner.call('agents.profile.save', { id: agent().id, expectedRevision: agent().revision, value: { ...agent(), projectIds: [drafts.id] } }))).toThrow('drafts');
  expect(await thrown(owner.call('agents.profile.save', { id: agent().id, expectedRevision: agent().revision, value: { ...agent(), projectIds: ['prj_missing'] } }))).toThrow();
  await entrust([]);
  // A bot with no project still lists its desk, empty here.
  expect(await cli(['threads'])).toEqual({ code: 0, out: 'threads: none\n', err: '' });
  // An ordinary thread lists what coordination lets it reach, the bot's own thread among them now that it starts on.
  const reached = await cli(['threads'], outside);
  expect([reached.code, reached.err]).toEqual([0, '']);
  expect(reached.out).toContain(`${self}  "Ada"`);
  expect((await cli(['threads', '--archived'], outside)).err).toContain('threads --archived lists archived threads for the owner and for bots');
  expect(notes.name).toBe('Notes');
});

test('its messages reach a thread as the agent\'s whatever that thread\'s settings, and the thread\'s turns come back as events', async () => {
  const prompts = answering(); const { h, owner, self, worker, cli, off, facts, hurry, events, agent } = await setup();
  // A thread it only wrote to wakes it with project-wide wakes on.
  const config = await owner.call('agents.runtime.get', { agentId: agent().id });
  await owner.call('agents.runtime.configure', { agentId: agent().id, expectedRevision: agent().revision, config: { ...config, eventWakes: true } });
  await off(worker);
  const sent = await cli(['thread', 'send', worker, 'Finish, verify and open the pull request', '--json']);
  expect(sent.err).toBe('');
  const letter = JSON.parse(sent.out) as AgentLetter;
  expect(letter.origin).toBe('resident');
  expect(letter.expiresAt - letter.createdAt).toBe(6 * 3_600_000);

  await waitFor(() => (prompts.get(worker) ?? []).some(p => p.includes('Finish, verify and open the pull request')));
  const prompt = prompts.get(worker)!.find(p => p.includes('Finish, verify'))!;
  expect(prompt).toContain("a bot of the user's that looks after this thread");
  expect(prompt).toContain('It is NOT the user');
  expect(prompt).not.toContain('messages from OTHER AGENTS');
  expect(h.core.journal.listMessages(worker).filter(m => m.role === 'user')).toHaveLength(0);
  expect(h.core.coordination.get(worker).messages.find(m => m.id === letter.id)?.relation).toBe('resident');

  // The thread is on the agent's desk now: its turn's answer waits as a fact, a short while for more.
  await waitFor(() => facts().some(f => f.text.includes(`Turn done in thread ${worker}, titled "Worker".`)));
  expect(facts().find(f => f.text.includes(worker))!.text).toContain('Its final answer: "Done in');
  expect((await h.connect().then(c => c.call('agents.snapshot', {}))).watches.map(w => [w.threadId, w.origin])).toContainEqual([worker, 'touched']);
  await Bun.sleep(700);
  expect(events()).toHaveLength(1);
  hurry();
  // The agent had nothing to tell the user: its event turn is quiet and leaves the thread read.
  await waitFor(() => events().length === 2 && settled(h, self));
  expect(events().at(-1)!.quiet).toBe(true);
  expect(facts()).toEqual([]);
});

test('a held backlog never hides the bot\'s letter behind it, and revoking the project keeps that letter away', async () => {
  const prompts = answering(); const { h, owner, self, worker, project, thread, entrust } = await setup();
  const peer = (await thread('Peer', project)).id;
  await owner.call('collaboration.configure', { threadId: worker, config: { ...h.core.coordination.config(worker), paused: true } });
  const to = h.core.coordination.get(worker).self;
  const status = (id: string) => h.core.coordination.get(worker).messages.find(letter => letter.id === id)?.status;
  // More ordinary letters than one delivery batch, all held by the pause.
  const held = [];
  for (let n = 0; n < 5; n++) held.push(await h.core.coordination.send({ threadId: peer, to, text: `Ordinary letter ${n}`, requestId: `ordinary-${n}` }));
  const resident = await h.core.coordination.send({ threadId: self, to, text: 'Entrusted bot instruction', requestId: 'resident' });
  expect(resident.origin).toBe('resident');
  await waitFor(() => (prompts.get(worker) ?? []).some(prompt => prompt.includes('Entrusted bot instruction')));
  await waitFor(() => status(resident.id) === 'delivered');
  expect(held.map(letter => status(letter.id))).toEqual(held.map(() => 'received'));
  expect(prompts.get(worker)!.some(prompt => prompt.includes('Ordinary letter'))).toBe(false);
  await waitFor(() => settled(h, worker));

  // Received while nothing delivers, then the project leaves the bot's care: it never reaches the thread.
  const deliver = spyOn(h.core.coordination as unknown as { deliver(threadId: string): Promise<void> }, 'deliver').mockResolvedValue(undefined);
  const late = await h.core.coordination.send({ threadId: self, to, text: 'Instruction after revocation', requestId: 'late' }).finally(() => undefined);
  await entrust(['Other']);
  deliver.mockRestore();
  await h.core.coordination.wait(worker, undefined, 0);
  await Bun.sleep(100);
  expect(status(late.id)).not.toBe('delivered');
  expect(prompts.get(worker)!.some(prompt => prompt.includes('Instruction after revocation'))).toBe(false);
  expect(held.map(letter => status(letter.id))).toEqual(held.map(() => 'received'));
});

test('events: failures and asks from any thread, finished turns only from followed ones, gathered for one turn', async () => {
  answering(); const { h, owner, worker, outside, project, thread, facts, entrust, agent } = await setup(['test']);
  // Held, so the facts stay waiting where the test can read them.
  h.core.workforce.setLimits({ paused: true });
  const quiet = (await thread('Quiet', project)).id;
  await owner.call('turns.start', { threadId: quiet, prompt: 'Build it' });
  await owner.call('turns.start', { threadId: outside, prompt: 'FAIL-ME elsewhere' });
  await waitFor(() => h.core.journal.lastCompletedAt(quiet) !== null && h.core.threads.require(outside).status !== 'running');
  expect(facts()).toHaveLength(0);

  await owner.call('turns.start', { threadId: worker, prompt: 'FAIL-ME please' });
  await waitFor(() => facts().length === 1);
  const asker = await connect(h.url, h.core.agents.tokenFor(quiet));
  try {
    const { questionId } = await asker.call('questions.ask', { threadId: quiet, text: 'Merge now?', options: ['Yes', 'No'] });
    await waitFor(() => facts().some(f => f.text.includes(questionId)));
    expect(facts().map(f => f.key)).toEqual([expect.stringMatching(/^turn:/), `ask:${questionId}`]);
    expect(facts()[0]!.text).toContain(`Turn error in thread ${worker}, titled "Worker"`);
    expect(facts()[1]!.text).toContain('Question: "Merge now?"');
    // The ask waits for the user first: its fact is due only past the grace delay.
    const pending = (h.core.agentRuntime as unknown as { pending: Map<string, { facts: { key: string; at: number; notBefore: number }[] }> }).pending.get(agent().id)!;
    const ask = pending.facts.find(f => f.key === `ask:${questionId}`)!;
    expect(ask.notBefore - ask.at).toBe(QUESTION_GRACE_MS);
    // Taking the project back drops what the facts say about its threads, here all of it.
    await entrust(['Other']);
    expect(facts()).toEqual([]);
  } finally { asker.close(); }
});

test('a bot with default settings wakes for a thread it started or watches, and holds the turns of a thread it only wrote to', async () => {
  const prompts = answering(); const { h, owner, self, worker, cli, facts, hurry, events } = await setup(['test']);
  // B: the bot answers a question of a thread of its project, which puts it on its desk.
  await owner.call('turns.start', { threadId: worker, prompt: 'Start B' });
  await waitFor(() => settled(h, worker));
  const asker = await connect(h.url, h.core.agents.tokenFor(worker));
  try {
    const { questionId } = await asker.call('questions.ask', { threadId: worker, text: 'Merge now?', options: ['Yes', 'No'] });
    await waitFor(() => facts().some(f => f.key === `ask:${questionId}`));
    expect((await cli(['answer', worker, questionId, 'Yes'])).err).toBe('');
  } finally { asker.close(); }
  expect((await owner.call('agents.snapshot', {})).watches.find(w => w.threadId === worker)?.origin).toBe('touched');
  await owner.call('turns.start', { threadId: worker, prompt: 'Build B' });
  await waitFor(() => facts().some(f => f.key.startsWith('turn:') && f.text.includes(worker)) && settled(h, worker));
  // A: a thread the bot started.
  const before = events().length;
  const started = await cli(['thread', 'new', 'test', 'Build A']);
  const a = /thread: (\S+)/.exec(started.out)![1]!;
  await waitFor(() => facts().some(f => f.text.includes(a)));
  hurry();
  await waitFor(() => events().length === before + 1 && settled(h, self));
  await Bun.sleep(700);
  expect(events()).toHaveLength(before + 1);
  const prompt = prompts.get(self)!.at(-1)!;
  expect(prompt).toContain(`Turn done in thread ${a}`);
  expect(prompt).not.toContain(worker);
  // B's turns wait for the bot's next routine.
  expect(facts().some(f => f.key.startsWith('turn:') && f.text.includes(worker))).toBe(true);
  // Watching B makes it its business: B's next turn wakes it.
  expect((await cli(['bot', 'watch', worker])).err).toBe('');
  expect((await owner.call('agents.snapshot', {})).watches.find(w => w.threadId === worker)?.origin).toBe('followed');
  const held = facts().length;
  await owner.call('turns.start', { threadId: worker, prompt: 'Again B' });
  await waitFor(() => facts().length === held + 1 && settled(h, worker));
  hurry();
  await waitFor(() => events().length === before + 2 && settled(h, self));
  expect(prompts.get(self)!.at(-1)!).toContain(`Turn done in thread ${worker}`);
});

test('it starts threads in its projects, and the thread\'s first answer comes back as an event', async () => {
  const prompts = answering(); const { h, owner, other, cli, facts, agent } = await setup(['Other']);
  const started = await cli(['thread', 'new', 'Other', 'Write the release notes']);
  expect(started.err).toBe('');
  expect(started.out).toContain('It is on your desk; each turn it ends wakes you with an event');
  const id = /thread: (\S+)/.exec(started.out)![1]!;
  expect(h.core.threads.require(id).projectId).toBe(other.id);
  await waitFor(() => (prompts.get(id) ?? []).length > 0);
  expect(prompts.get(id)![0]).toContain('started by Ada, a bot of the user\'s');
  expect(h.core.workforce.projects.follows(agent().id, id)).toBe(true);
  expect((await owner.call('agents.snapshot', {})).watches.find(w => w.threadId === id)).toMatchObject({ origin: 'started', projectId: other.id });
  await waitFor(() => facts().some(f => f.text.includes(id)));
});

test('a bot starts a thread in any project and drives what it started; threads it did not start stay out of reach outside its projects', async () => {
  const prompts = answering(); const { h, owner, notes, outside, cli, entrust, agent } = await setup(['Other']);
  const started = await cli(['thread', 'new', 'Notes', 'Write the notes']);
  expect(started.err).toBe('');
  const id = /thread: (\S+)/.exec(started.out)![1]!;
  expect(h.core.threads.require(id).projectId).toBe(notes.id);
  await waitFor(() => (prompts.get(id) ?? []).length > 0);
  expect(prompts.get(id)![0]).toContain('started by Ada, a bot of the user\'s');
  expect((await owner.call('agents.snapshot', {})).watches.find(w => w.threadId === id)).toMatchObject({ origin: 'started', projectId: notes.id });
  await waitFor(() => h.core.threads.require(id).status === 'idle');
  // Full control follows the thread it started, outside its projects.
  expect((await cli(['thread', 'show', id])).err).toBe('');
  const sent = await cli(['thread', 'send', id, 'Add the changelog', '--json']);
  expect(sent.err).toBe('');
  expect((JSON.parse(sent.out) as AgentLetter).origin).toBe('resident');
  await waitFor(() => (prompts.get(id) ?? []).some(p => p.includes('Add the changelog')));
  await waitFor(() => h.core.threads.require(id).status === 'idle');
  expect((await cli(['thread', 'rename', id, 'Notes, written'])).err).toBe('');
  expect((await cli(['threads'])).out).toContain(`${id} idle "Notes, written" desk=started machine=here`);
  // A thread of the same project it did not start stays the owner's.
  expect((await cli(['thread', 'show', outside])).err).toContain('is not a thread of the projects entrusted to this bot');
  // With no project at all it still starts threads, and keeps what it started.
  await entrust([]);
  const again = await cli(['thread', 'new', 'Notes', 'Write more notes']);
  expect(again.err).toBe('');
  expect((await cli(['thread', 'done', id])).out).toContain(`${id} idle,done`);
  expect(h.core.workforce.projects.follows(agent().id, id)).toBe(true);
});

test('the agent wakes a thread whose turn failed and puts it in Done once it is', async () => {
  const prompts = answering(); const { h, worker, cli, terminal } = await setup();
  h.core.threads.startTurn(worker, 'FAIL-ME');
  await waitFor(() => h.core.threads.require(worker).status === 'error');
  expect((await cli(['thread', 'send', worker, 'Resume the recovery batch'])).err).toBe('');
  await waitFor(() => (prompts.get(worker) ?? []).some(p => p.includes('Resume the recovery batch')));
  await waitFor(() => h.core.threads.require(worker).status === 'idle');

  const done = await cli(['thread', 'done', worker]);
  expect(done.err).toBe('');
  expect(done.out).toContain(`${worker} idle,done`);
  expect(h.core.threads.require(worker).doneAt).toBeNumber();
  expect(lines(worker, h)).toContain('Marked done by Ada, the bot the user entrusted this project to.');
  // The owner's terminal marks done too; a plain archive stays out of the Done list.
  await terminal(['thread', 'unarchive', worker]);
  await terminal(['thread', 'archive', worker]);
  expect((await terminal(['threads', '--archived'])).out).toContain(`${worker} idle,archived`);
  expect((await terminal(['thread', 'done', worker])).out).toContain(`done: ${worker}`);
  expect(h.core.threads.require(worker).doneAt).toBeNumber();
});

test('the owner drives every thread from a terminal, and what it sends is its own prompt', async () => {
  answering(); const { h, worker, outside, project, terminal } = await setup();
  const listed = await terminal(['threads']);
  expect(listed.err).toBe('');
  expect(listed.out).toContain(worker);
  expect(listed.out).toContain(outside);
  expect((await terminal(['projects'])).out).toContain('"Notes"');

  expect((await terminal(['thread', 'send', worker, 'Please rebase'])).err).toBe('');
  await waitFor(() => h.core.journal.listMessages(worker).some(m => m.role === 'user' && m.parts.some(p => p.type === 'text' && p.text === 'Please rebase')));

  const created = await terminal(['thread', 'new', 'test', 'Plan the nightly']);
  expect(created.err).toBe('');
  const id = /thread: (\S+)/.exec(created.out)![1]!;
  expect(h.core.threads.require(id).projectId).toBe(project);
  await waitFor(() => h.core.journal.listMessages(id).some(m => m.role === 'user'));

  await terminal(['thread', 'archive', outside]);
  expect(h.core.threads.require(outside).archived).toBe(true);
  const shown = await terminal(['thread', 'show', worker]);
  expect(shown.err).toBe('');
  expect(shown.out).toContain('last answer: Done in');
  // Without a token in the environment the address alone opens nothing.
  let err = '';
  expect(await runCli(['threads', '--core', h.url], { out: () => undefined, err: s => { err += s; }, env: {}, cwd: h.dataDir })).toBe(1);
  expect(err).toContain('--core needs the token in BOITE_TOKEN');
  // The token never crosses a network in cleartext.
  err = '';
  expect(await runCli(['threads', '--core', 'http://192.0.2.10:3773'], { out: () => undefined, err: s => { err += s; }, env: { BOITE_TOKEN: h.token }, cwd: h.dataDir })).toBe(1);
  expect(err).toContain('expected https://, or http:// on loopback or a Tailscale address');
});

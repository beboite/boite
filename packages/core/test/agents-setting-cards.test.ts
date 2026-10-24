import { afterEach, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentProfile, MessagePart } from '@boite/contracts';
import { runCli } from '../src/cli.ts';
import { connect } from '../src/client.ts';
import { setDriver } from '../src/drivers/index.ts';
import type { TurnContext, TurnResult } from '../src/drivers/types.ts';
import { makeAgent, settled } from './agent-fixture.ts';
import { echoThread, startTestCore, waitFor, type TestCore } from './harness.ts';
import { thrown } from './settle.ts';

const cores: TestCore[] = [];
const restores: (() => void)[] = [];
afterEach(async () => { for (const h of cores.splice(0)) await h.stop(); for (const restore of restores.splice(0)) restore(); });

/** An echo driver that records every prompt per thread and answers in one line. */
function recording(): Map<string, string[]> {
  const prompts = new Map<string, string[]>();
  restores.push(setDriver('echo', { protocol: 'echo', startTurn(ctx: TurnContext) {
    prompts.set(ctx.thread.id, [...(prompts.get(ctx.thread.id) ?? []), ctx.prompt]);
    const id = ctx.emit.startMessage('assistant');
    ctx.emit.part(id, 0, { type: 'text', text: 'Noted.' });
    ctx.emit.complete(id, 'complete');
    const result: TurnResult = { status: 'done', sessionId: `session:${ctx.thread.id}`, usage: null };
    return { done: Promise.resolve(result), stop() {} };
  } }));
  return prompts;
}

async function setup() {
  const prompts = recording();
  const h = await startTestCore(); cores.push(h);
  const owner = await h.connect();
  const { threadId: worker, accountId } = await echoThread(h, owner, 'Release work');
  const folder = (name: string) => { const path = join(h.dataDir, name); mkdirSync(path, { recursive: true }); return path; };
  const notes = await owner.call('projects.add', { path: folder('notes'), name: 'Notes' });
  const other = await owner.call('projects.add', { path: folder('other'), name: 'Other' });
  const { agent, threadId: self } = await makeAgent(h, owner, { instructions: '', selection: { providerId: 'echo', accountId, model: 'echo', effort: null, permissionMode: 'default' } });
  const run = async (args: string[], as: string) => {
    let out = '', err = '';
    const code = await runCli(args, { out: s => { out += s; }, err: s => { err += s; }, env: { BOITE_THREAD_ID: as, BOITE_CORE_URL: h.url, BOITE_AGENT_TOKEN: h.core.agents.tokenFor(as) }, cwd: h.dataDir });
    // Bun 1.4.2 on Windows can free a closed socket's poll request twice when the next connection opens in the same tick.
    await Bun.sleep(5);
    return { code, out, err };
  };
  const profile = () => h.core.workforce.records.get('profile', agent.id) as AgentProfile;
  const cards = (threadId: string) => h.core.threads.listQuestions(threadId).filter(q => q.agentSetting);
  /** The card as drawn in the thread's timeline, with its answer once it settled. */
  const drawn = (threadId: string, questionId: string) => h.core.journal.listMessages(threadId).flatMap(m => m.parts)
    .find((p): p is Extract<MessagePart, { type: 'question' }> => p.type === 'question' && p.questionId === questionId);
  return { h, owner, prompts, worker, notes, other, agent, self, run, profile, cards, drawn };
}

test('cards on an agent thread reach owners without opening it and disappear when settled', async () => {
  const { h, owner, agent, self, worker, profile } = await setup();
  const viewer = await h.connect();
  const grant = h.core.sessions.grant();
  const phone = await connect(h.url, '', { grant: grant.grant, client: { name: 'pwa', version: '0' } });
  const unrelated = await connect(h.url, h.core.agents.tokenFor(worker));
  const asked: string[] = [], answered: string[] = [], messages: string[] = [];
  const phoneAsked: string[] = [], phoneAnswered: string[] = [], unrelatedAsked: string[] = [];
  phone.on('question.asked', question => { phoneAsked.push(question.id); });
  phone.on('question.answered', question => { phoneAnswered.push(question.questionId); });
  unrelated.on('question.asked', question => { unrelatedAsked.push(question.id); });
  viewer.on('question.asked', question => { asked.push(question.id); });
  viewer.on('question.answered', question => { answered.push(question.questionId); });
  viewer.on('message.started', message => { messages.push(message.threadId); });

  // The agents page draws the thread's cards without subscribing to its transcript.
  const card = await owner.call('agents.settings.request', { threadId: self, key: 'dailyBudget', value: 3, reason: 'Allow a busier day' });
  expect(await viewer.call('questions.list', { threadId: self })).toHaveLength(1);
  expect(asked).toEqual([card.questionId]);
  const config = h.core.workforce.resident.config(agent.id);
  await owner.call('agents.runtime.configure', { agentId: agent.id, expectedRevision: profile().revision, config: { ...config, dailyBudgetUsd: 3 } });
  await waitFor(() => answered.includes(card.questionId));
  expect(await viewer.call('questions.list', { threadId: self })).toEqual([]);

  const next = await owner.call('agents.settings.request', { threadId: self, key: 'dailyBudget', value: 4, reason: 'A release day' });
  await viewer.call('agents.settings.apply', { threadId: self, questionId: next.questionId });
  await waitFor(() => answered.includes(next.questionId));
  expect(h.core.workforce.resident.config(agent.id).dailyBudgetUsd).toBe(4);
  const refused = await owner.call('agents.settings.request', { threadId: self, key: 'dailyBudget', value: 5, reason: 'Even more' });
  await viewer.call('questions.answer', { threadId: self, questionId: refused.questionId, optionIds: ['refuse'] });
  await waitFor(() => answered.includes(refused.questionId));
  expect(h.core.workforce.resident.config(agent.id).dailyBudgetUsd).toBe(4);
  await waitFor(() => settled(h, self));

  // Ordinary thread questions and the agent thread's transcript keep their subscription boundary.
  await owner.call('turns.start', { threadId: worker, prompt: 'Prepare a release' });
  await waitFor(() => h.core.journal.listTurns(worker).some(turn => turn.status === 'done'));
  const ordinary = await owner.call('agents.settings.request', { threadId: worker, agent: agent.id, key: 'dailyBudget', value: 6, reason: 'A long release' });
  await owner.call('questions.skip', { threadId: worker, questionId: ordinary.questionId });
  await owner.call('questions.list', {});
  expect(asked).toEqual([card.questionId, next.questionId, refused.questionId]);
  expect(answered).toEqual(asked);
  await phone.call('questions.list', {});
  await unrelated.call('agents.settings.read', { threadId: worker, agent: agent.id });
  expect(phoneAsked).toEqual(asked);
  expect(phoneAnswered).toEqual(answered);
  expect(unrelatedAsked).toEqual([]);
  expect(messages).toEqual([]);
  phone.close(); unrelated.close();
});

test('a discussion asks to entrust projects to an agent; the owner unticks one and applies; the discussion hears what changed', async () => {
  const { h, owner, prompts, worker, notes, other, run, profile, cards, drawn } = await setup();
  // A card is drawn in the thread's last turn.
  await owner.call('turns.start', { threadId: worker, prompt: 'Prepare the release' });
  await waitFor(() => h.core.journal.listTurns(worker).some(t => t.status === 'done'));

  const listed = await run(['settings', 'bot', 'projects', '--bot', 'ada'], worker);
  expect(listed.out).toContain('bot: Ada');
  expect(listed.out).toContain('projects []');
  expect(listed.out).toContain('Notes');
  // A discussion is no agent's conversation: it names the agent.
  expect((await run(['settings', 'bot'], worker)).err).toContain("this thread is no bot's conversation; name one: Ada");

  const asked = await run(['settings', 'bot', 'request', 'projects', '+Notes', '+Other', '--bot', 'Ada', '--why', 'Ada should watch the release projects.'], worker);
  expect(asked.code).toBe(0);
  expect(asked.out).toContain("change: Ada's projects [] ->");
  const [card] = cards(worker);
  expect(card!.text).toBe('Ada should watch the release projects.');
  expect(card!.agentSetting).toMatchObject({ agentId: profile().id, agentName: 'Ada', key: 'projects', previous: [], value: [notes.id, other.id].sort() });
  expect((await run(['settings', 'agent', 'request', 'projects', '+Notes', '--agent', 'Ada', '--why', 'Again'], worker)).err).toContain("a card asking about Ada's projects is already open");
  expect((await run(['settings', 'agent', 'request', 'projects', '+Nowhere', '--agent', 'Ada', '--why', 'Nope'], worker)).err).toContain('no project "Nowhere"');

  // The agent of a thread cannot apply its own card: Apply is the owner's.
  const agentClient = await connect(h.url, h.core.agents.tokenFor(worker));
  expect(await thrown(agentClient.call('agents.settings.apply', { threadId: worker, questionId: card!.id }))).toThrow("not one of the agent's methods");
  agentClient.close();

  await owner.call('agents.settings.apply', { threadId: worker, questionId: card!.id, value: ['Notes'] });
  expect(profile().projectIds).toEqual([notes.id]);
  expect(cards(worker)).toHaveLength(0);
  expect(drawn(worker, card!.id)!.answer).toEqual({ optionIds: ['changed'], value: [notes.id] });
  await waitFor(() => (prompts.get(worker) ?? []).some(p => p.includes('changed: the user set Ada\'s projects to ["Notes"]')));
  expect(prompts.get(worker)!.at(-1)).toContain('> Ada should watch the release projects.');
});

test("an agent asks about its own settings from its thread; a change from its settings page settles the card and the agent hears it there", async () => {
  const { h, owner, agent, self, prompts, run, profile, cards, drawn } = await setup();
  const heard = (text: string) => (prompts.get(self) ?? []).some(p => p.includes(text));

  // Its own thread names no agent; its context block says how to ask.
  expect(prompts.get(self)![0]).toContain('boite settings bot request <key> <value> --why <reason>');
  expect((await run(['settings', 'bot', 'request', 'dailyBudget', '2', '--why', 'Releases cost me two dollars.'], self)).code).toBe(0);
  expect((await run(['settings', 'bot', 'request', 'effort', 'high', '--why', 'Reviews need more thought.'], self)).code).toBe(0);
  expect((await run(['settings', 'agent', 'request', 'model', 'gpt-nothing', '--why', 'Try it.'], self)).err).toContain('the provider does not offer this model');
  const [budget, effort] = cards(self);
  expect(budget!.agentSetting).toMatchObject({ key: 'dailyBudget', previous: null, value: 2 });

  // The owner sets it on the agent's settings page, not on the card.
  const runtime = h.core.workforce.resident.config(agent.id);
  await owner.call('agents.runtime.configure', { agentId: agent.id, expectedRevision: profile().revision, config: { ...runtime, dailyBudgetUsd: 2 } });
  await waitFor(() => cards(self).length === 1);
  expect(drawn(self, budget!.id)!.answer).toEqual({ optionIds: ['applied'], value: 2 });
  await waitFor(() => heard("applied: Ada's dailyBudget is now 2"));

  await owner.call('questions.answer', { threadId: self, questionId: effort!.id, optionIds: ['refuse'] });
  await waitFor(() => heard("refused: Ada's effort stays null"));
  expect(profile().selection.effort).toBeNull();

  // A card about an agent that is archived closes unanswered.
  await waitFor(() => settled(h, self));
  expect((await run(['settings', 'agent', 'request', 'subagents', 'true', '--why', 'I need helpers.'], self)).code).toBe(0);
  const [helpers] = cards(self);
  await owner.call('agents.profile.save', { id: agent.id, expectedRevision: profile().revision, value: { ...profile(), status: 'archived' } });
  await waitFor(() => cards(self).length === 0);
  expect(drawn(self, helpers!.id)!.answer).toBeNull();
});

test('an agent whose stored model its provider no longer lists still takes a projects card; a new unlisted model is refused', async () => {
  const { h, owner, worker, notes, agent, run, profile, cards } = await setup();
  // A gateway once listed `echo/echo`; the provider lists only `echo` now.
  const { id: _id, revision, createdAt: _c, updatedAt: _u, ...draft } = profile();
  h.core.workforce.records.update('profile', agent.id, revision, { ...draft, selection: { ...draft.selection, model: 'echo/echo', effort: 'medium' } });

  await owner.call('turns.start', { threadId: worker, prompt: 'Prepare the release' });
  await waitFor(() => h.core.journal.listTurns(worker).some(t => t.status === 'done'));
  const asked = await run(['settings', 'agent', 'request', 'projects', '+Notes', '--agent', 'Ada', '--why', 'Watch the notes.'], worker);
  expect(asked.err).toBe('');
  const [card] = cards(worker);
  await owner.call('agents.settings.apply', { threadId: worker, questionId: card!.id });
  expect(profile().projectIds).toEqual([notes.id]);
  expect(profile().selection).toMatchObject({ model: 'echo/echo', effort: 'medium' });

  // Choosing a model is still checked.
  expect(await thrown(owner.call('agents.profile.save', { id: agent.id, expectedRevision: profile().revision, value: { ...profile(), selection: { ...profile().selection, model: 'echo/other' } } })))
    .toThrow('the provider does not offer this model');
});

test('a discussion asks the user to create a bot; the owner creates it from the card and the discussion hears its conversation', async () => {
  const { h, owner, prompts, worker, notes, run, drawn } = await setup();
  const creations = () => h.core.threads.listQuestions(worker).filter(q => q.agentCreate);
  const heard = (text: string) => (prompts.get(worker) ?? []).some(p => p.includes(text));
  await owner.call('turns.start', { threadId: worker, prompt: 'Set up a communication bot' });
  await waitFor(() => h.core.journal.listTurns(worker).some(t => t.status === 'done'));
  const manual = join(h.dataDir, 'manual.md');
  await Bun.write(manual, 'Write the release notes.');

  // A taken name, an unknown project or model is refused before any card is drawn.
  expect((await run(['settings', 'bot', 'create', 'ada', '--why', 'Another Ada'], worker)).err).toContain('a bot named "Ada" already exists');
  expect((await run(['settings', 'bot', 'create', 'Herald', '--project', 'Nowhere', '--why', 'Releases'], worker)).err).toContain('no project "Nowhere"');
  expect((await run(['settings', 'bot', 'create', 'Herald', '--model', 'gpt-nothing', '--why', 'Releases'], worker)).err).toContain('no installed model matches "gpt-nothing"');
  expect((await run(['settings', 'bot', 'create', 'Herald'], worker)).err).toContain('needs --why');
  expect(creations()).toHaveLength(0);

  const asked = await run(['settings', 'bot', 'create', 'Herald', '--project', 'Notes', '--domain', 'release communication', '--instructions-file', manual, '--why', 'You asked for a communication bot.'], worker);
  expect(asked.err).toBe('');
  expect(asked.out).toContain('bot: Herald on echo/');
  const [card] = creations();
  expect(card!.text).toBe('You asked for a communication bot.');
  // The thread's own route, with full access as the Agents page creates a bot.
  expect(card!.agentCreate).toMatchObject({ name: 'Herald', domain: 'release communication', instructions: 'Write the release notes.', projectIds: [notes.id], selection: { providerId: 'echo', effort: null, permissionMode: 'bypassPermissions' } });
  expect((await run(['settings', 'bot', 'create', 'herald', '--why', 'Again'], worker)).err).toContain('a card proposing a bot named "herald" is already open');

  // Creating is the owner's: the thread's agent cannot apply its own card.
  const agentClient = await connect(h.url, h.core.agents.tokenFor(worker));
  expect(await thrown(agentClient.call('agents.settings.apply', { threadId: worker, questionId: card!.id }))).toThrow("not one of the agent's methods");
  agentClient.close();

  const bot = await owner.call('agents.settings.apply', { threadId: worker, questionId: card!.id });
  expect(bot).toMatchObject({ name: 'Herald', status: 'active', projectIds: [notes.id], selection: card!.agentCreate!.selection });
  const botThread = h.core.workforce.sessionOf(bot.id)!.threadId;
  expect(creations()).toHaveLength(0);
  expect(drawn(worker, card!.id)!.answer).toEqual({ optionIds: ['created'], value: bot.id });
  await waitFor(() => heard(`created: the bot Herald (${bot.id}) exists`));
  expect(prompts.get(worker)!.at(-1)).toContain(`boite threads send ${botThread} <text>`);
  // Its first turn introduces it, as a bot made on the Agents page.
  await waitFor(() => (prompts.get(botThread) ?? []).length > 0);
});

test('a refused bot card creates nothing, and a bot made on the Agents page settles a card proposing its name', async () => {
  const { h, owner, prompts, worker, run, drawn } = await setup();
  const creations = () => h.core.threads.listQuestions(worker).filter(q => q.agentCreate);
  const heard = (text: string) => (prompts.get(worker) ?? []).some(p => p.includes(text));
  await owner.call('turns.start', { threadId: worker, prompt: 'Two bots' });
  await waitFor(() => h.core.journal.listTurns(worker).some(t => t.status === 'done'));
  expect((await run(['settings', 'bot', 'create', 'Scout', '--why', 'Watch the issues.'], worker)).code).toBe(0);
  expect((await run(['settings', 'bot', 'create', 'Scribe', '--why', 'Write the notes.'], worker)).code).toBe(0);
  const [scout, scribe] = creations();

  await owner.call('questions.answer', { threadId: worker, questionId: scout!.id, optionIds: ['refuse'] });
  await waitFor(() => heard('refused: no bot Scout was created'));
  expect(h.core.workforce.records.list('profile').map(p => p.name)).not.toContain('Scout');

  const made = await owner.call('agents.profile.save', { value: { name: 'scribe', domain: '', instructions: '', avatar: '', status: 'active', projectIds: [], selection: scribe!.agentCreate!.selection } });
  await waitFor(() => creations().length === 0);
  expect(drawn(worker, scribe!.id)!.answer).toEqual({ optionIds: ['created'], value: made.id });
  // The name is taken now: applying a stale card would make a second one.
  expect(await thrown(owner.call('agents.settings.apply', { threadId: worker, questionId: scribe!.id }))).toThrow();
});

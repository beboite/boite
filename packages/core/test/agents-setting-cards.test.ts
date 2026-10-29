import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentProfile, MessagePart, ModelInfo } from '@boite/contracts';
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

test('the native bot eventWakes boolean card reads, validates, applies and reverses without pausing the bot', async () => {
  const { h, owner, agent, worker, run, profile, cards } = await setup();
  await owner.call('turns.start', { threadId: worker, prompt: 'Configure the bot.' });
  await waitFor(() => settled(h, worker));
  expect((await run(['settings', 'bot', 'eventWakes', '--bot', 'Ada'], worker)).out).toContain('eventWakes false');
  expect((await run(['settings', 'bot', 'request', 'eventWakes', 'sometimes', '--bot', 'Ada', '--why', 'Batch project news.'], worker)).code).not.toBe(0);
  for (const enabled of [true, false]) {
    expect((await run(['settings', 'bot', 'request', 'eventWakes', String(enabled), '--bot', 'Ada', '--why', 'Batch project news.'], worker)).code).toBe(0);
    const card = cards(worker).find(q => q.agentSetting?.key === 'eventWakes')!;
    expect(card.agentSetting?.previous).toBe(!enabled);
    await owner.call('agents.settings.apply', { threadId: worker, questionId: card.id });
    expect(h.core.workforce.resident.config(agent.id).eventWakes).toBe(enabled);
    expect(profile().status).toBe('active');
  }
});

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

test('a bot asks to rename itself and to pause, then archive, another bot; the owner applies each card', async () => {
  const { h, owner, self, worker, prompts, run, profile, cards, drawn } = await setup();
  const heard = (text: string) => (prompts.get(self) ?? []).some(p => p.includes(text));
  const { agent: herald } = await owner.call('agents.create', { threadId: worker, name: 'Herald' });
  const heraldNow = () => h.core.workforce.records.get('profile', herald.id) as AgentProfile;
  const apply = async (questionId: string) => { await owner.call('agents.settings.apply', { threadId: self, questionId }); await waitFor(() => !cards(self).some(c => c.id === questionId)); };

  // The words are the name as typed, accents and parentheses included; a name another bot holds is refused.
  expect((await run(['settings', 'bot', 'request', 'name', 'herald', '--why', 'Take its name.'], self)).err).toContain('another bot is named "Herald"');
  expect((await run(['settings', 'bot', 'request', 'avatar', 'a robot', '--why', 'A new face.'], self)).err).toContain('avatar: expected one or two characters');
  const renamed = await run(['settings', 'bot', 'request', 'name', 'Gargouille', '(Sécurité)', '--why', 'The user renamed me.'], self);
  expect(renamed.out).toContain(`change: Ada's name "Ada" -> "Gargouille (Sécurité)"`);
  const [card] = cards(self);
  await apply(card!.id);
  expect(profile().name).toBe('Gargouille (Sécurité)');
  expect(h.core.journal.getThread(self)!.title).toBe('Gargouille (Sécurité)');
  await waitFor(() => heard(`applied: Ada's name is now "Gargouille (Sécurité)"`));

  // Two cards may ask for one free name; once one gives it away, the other cannot apply.
  await owner.call('turns.start', { threadId: worker, prompt: 'Prepare the release' });
  await waitFor(() => h.core.journal.listTurns(worker).some(t => t.status === 'done'));
  expect((await run(['settings', 'bot', 'request', 'name', 'Sentinel', '--bot', 'Herald', '--why', 'A watch name.'], worker)).code).toBe(0);
  expect((await run(['settings', 'bot', 'request', 'name', 'Sentinel', '--why', 'A watch name.'], self)).code).toBe(0);
  await owner.call('agents.settings.apply', { threadId: worker, questionId: cards(worker)[0]!.id });
  expect(heraldNow().name).toBe('Sentinel');
  const second = cards(self)[0]!;
  expect(await thrown(owner.call('agents.settings.apply', { threadId: self, questionId: second.id }))).toThrow('another bot is named "Sentinel"');
  expect(profile().name).toBe('Gargouille (Sécurité)');
  await owner.call('questions.answer', { threadId: self, questionId: second.id, optionIds: ['refuse'] });
  await waitFor(() => cards(self).length === 0 && cards(worker).length === 0);

  // Long instructions come from a file; the change line and the listing show their start.
  const manual = join(h.dataDir, 'manual.md');
  await Bun.write(manual, `Guard the release.\n${'Check every gate. '.repeat(40)}`);
  expect((await run(['settings', 'bot', 'request', 'instructions', '--instructions-file', manual, '--why', 'My new rules.'], self)).out).toContain('characters)');
  await apply(cards(self)[0]!.id);
  expect(profile().instructions).toStartWith('Guard the release.\nCheck every gate.');
  expect((await run(['settings', 'bot'], self)).out).toMatch(/instructions "Guard the release\.\\nCheck.*… \(\d+ characters\)/);

  // Another bot, by name: paused, then archived. An archive card settles as applied, not closed;
  // a card to wake it, drawn from another thread, closes unanswered with it.
  expect((await run(['settings', 'bot', 'request', 'status', 'paused', '--bot', 'Sentinel', '--why', 'The user is away.'], self)).code).toBe(0);
  await apply(cards(self)[0]!.id);
  expect(heraldNow().status).toBe('paused');
  expect((await run(['settings', 'bot', 'status', '--bot', 'Sentinel'], self)).out).toContain('choices: active, paused, archived');
  expect((await run(['settings', 'bot', 'request', 'status', 'active', '--bot', 'Sentinel', '--why', 'The user is back.'], worker)).code).toBe(0);
  const [wake] = cards(worker);
  expect((await run(['settings', 'bot', 'request', 'status', 'archived', '--bot', 'Sentinel', '--why', 'Sentinel is no longer needed.'], self)).code).toBe(0);
  const archive = cards(self)[0]!;
  await apply(archive.id);
  expect(heraldNow().status).toBe('archived');
  expect(drawn(self, archive.id)!.answer).toEqual({ optionIds: ['applied'], value: 'archived' });
  await waitFor(() => cards(worker).length === 0);
  expect(drawn(worker, wake!.id)!.answer).toBeNull();
  expect(profile().status).toBe('active');
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

test('a bot asks to run on another provider; applying the card moves it there on its signed-in login and allows the route', async () => {
  const { h, owner, agent, self, run, profile, cards, drawn } = await setup();
  // A second provider on the echo driver, with its own models and a signed-in default account.
  const shipped = JSON.parse(readFileSync(join(import.meta.dir, '../src/providers/shipped/echo.json'), 'utf8')) as Record<string, unknown>;
  // Its second model's id reads like a reference to the echo provider's model.
  const models: ModelInfo[] = [{ id: 'twin-large', name: 'Twin Large', effort: { levels: [{ id: 'low', label: 'Low' }, { id: 'xhigh', label: 'Extra high' }], default: 'xhigh' } }, { id: 'echo/echo', name: 'Twin Echo' }];
  mkdirSync(join(h.dataDir, 'providers'), { recursive: true });
  writeFileSync(join(h.dataDir, 'providers', 'twin.json'), JSON.stringify({ ...shipped, id: 'twin', name: 'Twin', shortName: 'Twin', models }));
  expect((await owner.call('providers.reload', {})).rejected).toEqual([]);
  h.core.accounts.ensureDefaults();
  const twinAccount = h.core.accounts.list().find(account => account.providerId === 'twin')!.id;
  await owner.call('agents.profile.save', { id: agent.id, expectedRevision: profile().revision, value: { ...profile(), selection: { ...profile().selection, effort: 'low' } } });

  // The reading names every model by its provider, its own first, beyond the one route its settings allow.
  expect(h.core.workforce.resident.config(agent.id).allowedRoutes.map(route => route.model)).toEqual(['echo']);
  const read = await run(['settings', 'bot', 'model'], self);
  expect(read.out).toContain('model "echo/echo"');
  expect(read.out).toContain('choices: Echo (echo/echo), Twin Large (twin/twin-large), Twin Echo (twin/echo/echo)');
  expect((await run(['settings', 'bot', 'request', 'model', 'twin/nothing', '--why', 'Try it.'], self)).err).toContain('the provider does not offer this model');
  expect((await run(['settings', 'bot', 'request', 'model', 'echo', '--why', 'Stay.'], self)).err).toContain('model is already "echo/echo"');

  expect((await run(['settings', 'bot', 'request', 'model', 'twin/twin-large', '--why', 'Reviews need a larger model.'], self)).code).toBe(0);
  const [card] = cards(self);
  expect(card!.agentSetting).toMatchObject({ key: 'model', previous: 'echo/echo', value: 'twin/twin-large' });
  // Turned off since the card was drawn, the provider cannot take the bot: Apply refuses and the card stays open.
  await owner.call('providers.setEnabled', { providerId: 'twin', enabled: false });
  expect(await thrown(owner.call('agents.settings.apply', { threadId: self, questionId: card!.id }))).toThrow('twin is not installed or is turned off');
  expect(profile().selection.providerId).toBe('echo');
  expect(cards(self).map(open => open.id)).toEqual([card!.id]);
  await owner.call('providers.setEnabled', { providerId: 'twin', enabled: true });
  await owner.call('agents.settings.apply', { threadId: self, questionId: card!.id });
  // Its effort carries over where the new model has the level.
  expect(profile().selection).toMatchObject({ providerId: 'twin', accountId: twinAccount, model: 'twin-large', effort: 'low' });
  // The owner's Apply allowed it: the bot's settings list the route, and it is the default one.
  const config = h.core.workforce.resident.config(agent.id);
  expect(config.allowedRoutes.map(route => [route.id, route.name, route.providerId, route.model])).toEqual([['default', 'Default', 'echo', 'echo'], ['twin/twin-large', 'Twin Large', 'twin', 'twin-large']]);
  expect(config.defaultRoute).toMatchObject({ providerId: 'twin', model: 'twin-large' });
  expect(drawn(self, card!.id)!.answer).toEqual({ optionIds: ['applied'], value: 'twin/twin-large' });

  // A model id of the provider it now runs on needs no prefix.
  await waitFor(() => settled(h, self));
  expect((await run(['settings', 'bot', 'request', 'model', 'twin-large', '--why', 'Stay.'], self)).err).toContain('model is already "twin/twin-large"');

  // A card drawn before cards named the provider holds a model id of the bot's provider, slash included.
  const legacy = { agentId: agent.id, agentName: agent.name, key: 'model' as const, previous: 'twin-large', value: 'echo/echo' };
  const { questionId } = h.core.threads.cards.drawAsync(h.core.threads.require(self), { text: 'Older card.', options: [{ id: 'refuse', label: 'Refuse' }], allowText: false, multiple: false, async: true, agentSetting: legacy });
  await owner.call('agents.settings.apply', { threadId: self, questionId });
  expect(profile().selection).toMatchObject({ providerId: 'twin', model: 'echo/echo' });
  expect(drawn(self, questionId)!.answer).toEqual({ optionIds: ['applied'], value: 'twin/echo/echo' });
  await waitFor(() => settled(h, self));

  // Back to echo, then to the twin model whose id reads like the echo reference the card moves from.
  const move = async (to: string, previous: string, off?: string) => {
    expect((await run(['settings', 'bot', 'request', 'model', to, '--why', 'Move.'], self)).code).toBe(0);
    const [open] = cards(self);
    expect(open!.agentSetting).toMatchObject({ previous, value: to });
    if (off !== undefined) {
      // The card names its provider: turned off, Apply refuses rather than read the bot's own model of that id.
      await owner.call('providers.setEnabled', { providerId: off, enabled: false });
      expect(await thrown(owner.call('agents.settings.apply', { threadId: self, questionId: open!.id }))).toThrow(`${off} is not installed or is turned off`);
      expect(cards(self).map(card => card.id)).toEqual([open!.id]);
      await owner.call('providers.setEnabled', { providerId: off, enabled: true });
    }
    await owner.call('agents.settings.apply', { threadId: self, questionId: open!.id });
    expect(drawn(self, open!.id)!.answer).toEqual({ optionIds: ['applied'], value: to });
    await waitFor(() => settled(h, self));
  };
  await move('echo/echo', 'twin/echo/echo', 'echo');
  expect(profile().selection).toMatchObject({ providerId: 'echo', model: 'echo' });
  await move('twin/echo/echo', 'echo/echo');
  expect(profile().selection).toMatchObject({ providerId: 'twin', model: 'echo/echo' });
  expect(h.core.workforce.resident.config(agent.id).allowedRoutes.map(route => `${route.providerId}/${route.model}`)).toEqual(['echo/echo', 'twin/twin-large', 'twin/echo/echo']);
});

test('a discussion creates the bot the user asked for, without a card, and reads its conversation', async () => {
  const { h, owner, prompts, worker, notes, run } = await setup();
  const bots = () => h.core.workforce.records.list('profile').map(p => p.name);
  const manual = join(h.dataDir, 'manual.md');
  await Bun.write(manual, 'Write the release notes.');

  // A taken name, an unknown project or model is refused and creates nothing.
  expect((await run(['settings', 'bot', 'create', 'ada'], worker)).err).toContain('a bot named "Ada" already exists');
  expect((await run(['settings', 'bot', 'create', 'Herald', '--project', 'Nowhere'], worker)).err).toContain('no project "Nowhere"');
  expect((await run(['settings', 'bot', 'create', 'Herald', '--model', 'gpt-nothing'], worker)).err).toContain('no installed model matches "gpt-nothing"');
  expect(bots()).not.toContain('Herald');

  const created = await run(['settings', 'bot', 'create', 'Herald', '--project', 'Notes', '--domain', 'release communication', '--instructions-file', manual], worker);
  expect(created.err).toBe('');
  const bot = h.core.workforce.records.list('profile').find(p => p.name === 'Herald')!;
  // The thread's own route, with full access as the Bots page creates a bot; no card asked the user.
  expect(bot).toMatchObject({ status: 'active', domain: 'release communication', instructions: 'Write the release notes.', projectIds: [notes.id], selection: { providerId: 'echo', effort: null, permissionMode: 'bypassPermissions' } });
  expect(h.core.threads.listQuestions(worker)).toHaveLength(0);
  const botThread = h.core.workforce.sessionOf(bot.id)!.threadId;
  expect(created.out).toContain(`created: Herald (${bot.id})`);
  expect(created.out).toContain(`boite threads send ${botThread} <text>`);
  // Its first turn introduces it, as a bot made on the Bots page.
  await waitFor(() => (prompts.get(botThread) ?? []).length > 0);
  expect((await run(['settings', 'bot', 'create', 'herald'], worker)).err).toContain('a bot named "Herald" already exists');

  // The owner may call it too.
  expect((await owner.call('agents.create', { threadId: worker, name: 'Scout' })).agent.name).toBe('Scout');
});

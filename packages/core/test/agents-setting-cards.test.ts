import { afterEach, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentProfile, MessagePart } from '@boite/contracts';
import { runCli } from '../src/cli.ts';
import { connect } from '../src/client.ts';
import { setDriver } from '../src/drivers/index.ts';
import type { TurnContext, TurnResult } from '../src/drivers/types.ts';
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
  const agent = await owner.call('agents.profile.save', { value: { name: 'Ada', domain: 'Open source', instructions: '', avatar: '', status: 'active', tools: ['messages'], projectIds: [], selection: { providerId: 'echo', accountId, model: 'echo', effort: null, permissionMode: 'default' } } });
  await h.core.workforce.resident.configure({ agentId: agent.id, expectedRevision: agent.revision, config: { ...h.core.workforce.resident.config(agent.id), autoMemory: false } });
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
  return { h, owner, prompts, worker, notes, other, agent, run, profile, cards, drawn };
}

test('agent conversation cards reach owners without opening the hidden thread and disappear when settled', async () => {
  const { h, owner, agent, worker, profile } = await setup();
  await owner.call('agents.message.send', { scope: { kind: 'agent', id: agent.id }, recipientIds: [agent.id], text: 'Hello', requestId: 'hello-card-events' });
  await waitFor(() => h.core.workforce.records.list('work').some(work => work.status === 'done'));
  const self = h.core.workforce.records.sessionFor(agent.id, { kind: 'agent', id: agent.id })!.threadId;
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

  // The conversation displays the session's questions without subscribing to its transcript.
  const card = await owner.call('agents.settings.request', { threadId: self, key: 'maxRunMinutes', value: 30, reason: 'Allow time for builds' });
  expect(await viewer.call('questions.list', { threadId: self })).toHaveLength(1);
  expect(asked).toEqual([card.questionId]);
  const config = h.core.workforce.resident.config(agent.id);
  await owner.call('agents.runtime.configure', { agentId: agent.id, expectedRevision: profile().revision, config: { ...config, maxRunMinutes: 30 } });
  await waitFor(() => answered.includes(card.questionId));
  expect(await viewer.call('questions.list', { threadId: self })).toEqual([]);

  const next = await owner.call('agents.settings.request', { threadId: self, key: 'maxRunMinutes', value: 40, reason: 'A longer build' });
  await viewer.call('agents.settings.apply', { threadId: self, questionId: next.questionId });
  await waitFor(() => answered.includes(next.questionId));
  expect(h.core.workforce.resident.config(agent.id).maxRunMinutes).toBe(40);
  const refused = await owner.call('agents.settings.request', { threadId: self, key: 'maxRunMinutes', value: 50, reason: 'Even longer' });
  await viewer.call('questions.answer', { threadId: self, questionId: refused.questionId, optionIds: ['refuse'] });
  await waitFor(() => answered.includes(refused.questionId));
  expect(h.core.workforce.resident.config(agent.id).maxRunMinutes).toBe(40);

  // Ordinary thread questions and the hidden session's transcript keep their subscription boundary.
  await owner.call('turns.start', { threadId: worker, prompt: 'Prepare a release' });
  await waitFor(() => h.core.journal.listTurns(worker).some(turn => turn.status === 'done'));
  const ordinary = await owner.call('agents.settings.request', { threadId: worker, agent: agent.id, key: 'maxRunMinutes', value: 60, reason: 'A longer release' });
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

  const listed = await run(['settings', 'agent', 'projects', '--agent', 'ada'], worker);
  expect(listed.out).toContain('agent: Ada');
  expect(listed.out).toContain('projects []');
  expect(listed.out).toContain('Notes');
  // A discussion is no agent's conversation: it names the agent.
  expect((await run(['settings', 'agent'], worker)).err).toContain("this thread is no agent's conversation; name one: Ada");

  const asked = await run(['settings', 'agent', 'request', 'projects', '+Notes', '+Other', '--agent', 'Ada', '--why', 'Ada should watch the release projects.'], worker);
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

test("an agent asks about its own settings from its conversation; a change from its settings page settles the card and the agent hears it as work", async () => {
  const { h, owner, agent, run, profile, cards, drawn } = await setup();
  await owner.call('agents.message.send', { scope: { kind: 'agent', id: agent.id }, recipientIds: [agent.id], text: 'Hello', requestId: 'hello-ada-cards-1' });
  await waitFor(() => h.core.workforce.records.list('work').some(w => w.status === 'done'));
  const self = h.core.workforce.records.sessionFor(agent.id, { kind: 'agent', id: agent.id })!.threadId;
  const work = () => h.core.workforce.records.list('work').filter(w => w.agentId === agent.id);

  // Its own conversation names no agent; the run includes the way to ask.
  const runs = h.core.workforce.records.list('run').filter(r => r.agentId === agent.id);
  expect(runs[0]!.context.instructions).toContain('boite settings agent request <key> <value> --why <reason>');
  expect((await run(['settings', 'agent', 'request', 'maxRunMinutes', '30', '--why', 'Releases take me half an hour.'], self)).code).toBe(0);
  expect((await run(['settings', 'agent', 'request', 'effort', 'high', '--why', 'Reviews need more thought.'], self)).code).toBe(0);
  expect((await run(['settings', 'agent', 'request', 'model', 'gpt-nothing', '--why', 'Try it.'], self)).err).toContain('the provider does not offer this model');
  const [minutes, effort] = cards(self);
  expect(minutes!.agentSetting).toMatchObject({ key: 'maxRunMinutes', previous: 10, value: 30 });

  // The owner sets it on the agent's settings page, not on the card.
  const runtime = h.core.workforce.resident.config(agent.id);
  await owner.call('agents.runtime.configure', { agentId: agent.id, expectedRevision: profile().revision, config: { ...runtime, maxRunMinutes: 30 } });
  await waitFor(() => cards(self).length === 1);
  expect(drawn(self, minutes!.id)!.answer).toEqual({ optionIds: ['applied'], value: 30 });
  await waitFor(() => work().some(w => w.prompt.includes("applied: Ada's maxRunMinutes is now 30")));

  await owner.call('questions.answer', { threadId: self, questionId: effort!.id, optionIds: ['refuse'] });
  await waitFor(() => work().some(w => w.prompt.includes("refused: Ada's effort stays null")));
  expect(profile().selection.effort).toBeNull();

  // A card about an agent that is archived closes unanswered.
  expect((await run(['settings', 'agent', 'request', 'subagents', 'false', '--why', 'I work alone.'], self)).code).toBe(0);
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

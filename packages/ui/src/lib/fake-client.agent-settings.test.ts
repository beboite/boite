import { expect } from 'vitest';
import { RpcErrorCode, type AgentProfile } from '@boite/contracts';
import { test } from '../test/fake-client';
import type { FakeClient } from './fake-client';

async function agent(client: FakeClient, name = 'Mira'): Promise<AgentProfile> {
  return client.call('agents.profile.save', { value: { name, domain: '', instructions: '', avatar: '', status: 'active', projectIds: [],
    selection: { providerId: 'echo', accountId: 'a-echo', model: 'echo-1', effort: null, permissionMode: 'default' } } });
}

const prompts = async (client: FakeClient, threadId: string) => (await client.call('threads.get', { threadId })).messages
  .filter((message) => message.role === 'user').map((message) => (message.parts[0]?.type === 'text' ? message.parts[0].text : ''));

test('fake eventWakes settings use the same boolean card and preserve the active bot', async ({ createClient }) => {
  const client = await createClient({ delayMs: 0 });
  const mira = await agent(client);
  const { id: threadId } = await client.call('threads.create', { projectId: 'p-boite', providerId: 'echo', accountId: 'a-echo' });
  await client.call('turns.start', { threadId, prompt: 'Configure the bot.' });
  await client.settled();
  const read = await client.call('agents.settings.read', { threadId, agent: mira.id });
  expect(read.settings.find(s => s.key === 'eventWakes')?.value).toBe(true);
  for (const value of [false, true]) {
    const card = await client.call('agents.settings.request', { threadId, agent: mira.id, key: 'eventWakes', value, reason: 'Batch project news' });
    expect(card.setting.previous).toBe(!value);
    const saved = await client.call('agents.settings.apply', { threadId, questionId: card.questionId });
    expect(saved.status).toBe('active');
    expect((await client.call('agents.runtime.get', { agentId: mira.id })).eventWakes).toBe(value);
  }
});

test('fake agent setting cards: read, request, refusals, apply with an edit and the answer the thread reads', async ({ createClient }) => {
  const client = await createClient({ delayMs: 0 });
  const mira = await agent(client);
  const { id: threadId } = await client.call('threads.create', { projectId: 'p-boite', providerId: 'echo', accountId: 'a-echo' });
  await client.call('turns.start', { threadId, prompt: 'hello' });
  await client.settled();

  const read = await client.call('agents.settings.read', { threadId, agent: 'mira' });
  expect(read.agentName).toBe('Mira');
  expect(read.settings.find((setting) => setting.key === 'projects')).toEqual({ key: 'projects', value: [], choices: [{ id: 'p-boite', label: 'boite' }, { id: 'p-notes', label: 'notes' }] });
  expect(read.settings.find((setting) => setting.key === 'effort')?.choices?.map((choice) => choice.id)).toEqual(['low', 'high']);

  // Unknown agent, a value its settings refuse, an unnamed agent from an ordinary thread.
  await expect(client.call('agents.settings.request', { threadId, agent: 'Nobody', key: 'projects', value: ['boite'], reason: 'r' })).rejects.toMatchObject({ code: RpcErrorCode.Refused, data: { field: 'agent' } });
  await expect(client.call('agents.settings.request', { threadId, agent: 'Mira', key: 'model', value: 'gpt-9', reason: 'r' })).rejects.toMatchObject({ code: RpcErrorCode.Refused, data: { field: 'value', key: 'model' } });
  await expect(client.call('agents.settings.request', { threadId, key: 'projects', value: ['boite'], reason: 'r' })).rejects.toMatchObject({ code: RpcErrorCode.Refused, data: { field: 'agent' } });

  const { questionId, setting } = await client.call('agents.settings.request', { threadId, agent: 'Mira', key: 'projects', value: { add: ['boite', 'notes'] }, reason: 'Two projects to follow' });
  expect(setting).toEqual({ agentId: mira.id, agentName: 'Mira', key: 'projects', value: ['p-boite', 'p-notes'], previous: [] });
  const [question] = await client.call('questions.list', { threadId });
  expect(question).toMatchObject({ id: questionId, async: true, text: 'Two projects to follow', options: [{ id: 'refuse', label: 'Refuse' }], agentSetting: setting });
  // One card per agent and key on a thread.
  await expect(client.call('agents.settings.request', { threadId, agent: 'Mira', key: 'projects', value: ['notes'], reason: 'again' })).rejects.toMatchObject({ data: { field: 'key' } });
  // A paired device cannot apply it.
  const phone = await createClient({ delayMs: 0, principal: 'session' });
  await expect(phone.call('agents.settings.apply', { threadId, questionId })).rejects.toMatchObject({ code: RpcErrorCode.Refused });

  await expect(client.call('agents.settings.apply', { threadId, questionId, value: ['nowhere'] })).rejects.toMatchObject({ data: { field: 'value' } });
  const saved = await client.call('agents.settings.apply', { threadId, questionId, value: ['p-notes'] });
  expect(saved.projectIds).toEqual(['p-notes']);
  await client.settled();
  expect(await client.call('questions.list', { threadId })).toEqual([]);
  const part = (await client.call('threads.get', { threadId })).messages.flatMap((message) => message.parts).find((entry) => entry.type === 'question');
  expect(part).toMatchObject({ agentSetting: setting, answer: { optionIds: ['changed'], value: ['p-notes'] } });
  expect((await prompts(client, threadId)).at(-1)).toBe('> Two projects to follow\n\nchanged: the user set Mira\'s projects to ["notes"], not ["boite","notes"]');
  await expect(client.call('agents.settings.apply', { threadId, questionId })).rejects.toMatchObject({ code: RpcErrorCode.NotFound });
});

test('a bot may propose a robot with every shared part, or a four-part code, and nothing else', async ({ createClient }) => {
  const client = await createClient({ delayMs: 0 });
  await agent(client);
  const thread = async () => {
    const { id } = await client.call('threads.create', { projectId: 'p-boite', providerId: 'echo', accountId: 'a-echo' });
    await client.call('turns.start', { threadId: id, prompt: 'hello' });
    await client.settled();
    return id;
  };
  const threadId = await thread();
  await expect(client.call('agents.settings.request', { threadId, agent: 'Mira', key: 'avatar', value: 'bot:a.1.2.3.4.5', reason: 'r' })).rejects.toMatchObject({ code: RpcErrorCode.Refused, data: { field: 'value', key: 'avatar' } });
  const { setting } = await client.call('agents.settings.request', { threadId, agent: 'Mira', key: 'avatar', value: 'bot:d.5.16.12.14.3.2.1', reason: 'A new face' });
  expect(setting.value).toBe('bot:d.5.16.12.14.3.2.1');
  expect((await client.call('agents.settings.request', { threadId: await thread(), agent: 'Mira', key: 'avatar', value: 'bot:c.1.2.3.0', reason: 'The old one' })).setting.value).toBe('bot:c.1.2.3.0');
});

test('fake agent setting cards settle from the agent\'s own settings, and the [agent-settings] marker asks for a project', async ({ createClient }) => {
  const client = await createClient({ delayMs: 0 });
  const mira = await agent(client);
  const { id: threadId } = await client.call('threads.create', { projectId: 'p-notes', providerId: 'echo', accountId: 'a-echo' });
  await client.call('turns.start', { threadId, prompt: 'look after this [agent-settings]' });
  await client.settled();
  const [card] = await client.call('questions.list', { threadId });
  expect(card?.agentSetting).toEqual({ agentId: mira.id, agentName: 'Mira', key: 'projects', value: ['p-notes'], previous: [] });

  const effort = await client.call('agents.settings.request', { threadId, agent: mira.id, key: 'effort', value: 'low', reason: 'Quicker answers' });
  // The settings page saves the same projects the card proposed and another effort than it asked.
  const now = (await client.call('agents.snapshot', {})).profiles.find((profile) => profile.id === mira.id)!;
  await client.call('agents.profile.save', { id: mira.id, expectedRevision: now.revision, value: { ...now, projectIds: ['p-notes'], selection: { ...now.selection, effort: 'high' } } });
  await client.settled();
  expect(await client.call('questions.list', { threadId })).toEqual([]);
  const parts = (await client.call('threads.get', { threadId })).messages.flatMap((message) => message.parts).filter((entry) => entry.type === 'question');
  expect(parts.map((entry) => entry.type === 'question' && [entry.questionId, entry.answer?.optionIds[0]])).toEqual([[card!.id, 'applied'], [effort.questionId, 'changed']]);
  // One change settles both cards; the answers reach the thread as prompts.
  const read = (await prompts(client, threadId)).join('\n\n');
  expect(read).toContain(`> ${card!.text}\n\napplied: Mira's projects are now ["notes"]`);
  expect(read).toContain('> Quicker answers\n\nchanged: the user set Mira\'s effort to "high", not "low"');
});

test("fake agents.create: the core's refusals, then the bot made at once on the thread's route with full access", async ({ createClient }) => {
  const client = await createClient({ delayMs: 0 });
  await agent(client);
  const { id: threadId } = await client.call('threads.create', { projectId: 'p-boite', providerId: 'echo', accountId: 'a-echo' });
  const live = async () => (await client.call('agents.snapshot', {})).profiles.map((profile) => profile.name);

  await expect(client.call('agents.create', { threadId, name: 'mira' })).rejects.toMatchObject({ code: RpcErrorCode.Refused, data: { field: 'name' } });
  await expect(client.call('agents.create', { threadId, name: 'Scribe', projects: ['nowhere'] })).rejects.toMatchObject({ data: { field: 'projects' } });
  await expect(client.call('agents.create', { threadId, name: 'Scribe', model: 'gpt-9' })).rejects.toMatchObject({ data: { field: 'model' } });
  // A model that is not text is refused, not read as omitted (which would take the thread's route).
  await expect(client.call('agents.create', { threadId, name: 'Scribe', model: 123 as unknown as string })).rejects.toMatchObject({ data: { field: 'model' } });
  expect(await live()).not.toContain('Scribe');

  // Bounds hold on the trimmed text, as the name's do.
  const { agent: scribe, threadId: conversation } = await client.call('agents.create', { threadId, name: 'Scribe', domain: ` ${'d'.repeat(500)} `, effort: 'high', projects: ['notes'] });
  expect(scribe).toMatchObject({ name: 'Scribe', domain: 'd'.repeat(500), status: 'active', projectIds: ['p-notes'], selection: { providerId: 'echo', accountId: 'a-echo', model: 'echo-1', effort: 'high', permissionMode: 'bypassPermissions' } });
  expect(conversation).not.toBeNull();
  expect(await client.call('questions.list', { threadId })).toEqual([]);

  // A thread on its provider's default model gives the bot the model marked default, not the first listed.
  const { models } = await client.call('providers.probe', { providerId: 'claude', accountId: 'a-claude-main' });
  const onDefault = await client.call('threads.create', { projectId: 'p-boite', providerId: 'claude', accountId: 'a-claude-main' });
  expect(models[0]!.default).not.toBe(true);
  expect((await client.call('agents.create', { threadId: onDefault.id, name: 'Herald' })).agent.selection.model).toBe(models.find((model) => model.default === true)!.id);
});

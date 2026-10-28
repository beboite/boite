import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { AgentProfile, Message, QuestionRequest } from '@boite/contracts';
import { FakeClient } from '../lib/fake-client';
import { Store } from '../lib/store.svelte';
import AssistantMessage from './AssistantMessage.svelte';
import AgentSettingCard from './AgentSettingCard.svelte';

let mounted: ReturnType<typeof mount> | undefined;
afterEach(async () => {
  if (mounted) await unmount(mounted);
  mounted = undefined;
  document.body.innerHTML = '';
});

function query<T extends Element>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`no ${selector}`);
  return node;
}

/** A store on the trace thread and an agent that holds no project yet. */
async function setup(): Promise<{ client: FakeClient; store: Store; agent: AgentProfile }> {
  const client = new FakeClient({ delayMs: 0 });
  const store = new Store();
  store.attach(client);
  await store.connect();
  await store.open('t-trace');
  const agent = await client.call('agents.profile.save', { value: { name: 'Mira', domain: '', instructions: '', avatar: '', status: 'active', projectIds: [],
    selection: { providerId: 'claude', accountId: 'a-claude-main', model: null, effort: null, permissionMode: 'default' } } });
  return { client, store, agent };
}

function card(store: Store, question: QuestionRequest): void {
  mounted = mount(AgentSettingCard, {
    target: document.body,
    props: {
      store,
      threadId: question.threadId,
      questionId: question.id,
      text: question.text,
      setting: question.agentSetting!,
      answer: null,
      pending: true,
      respond: (optionId: 'refuse') => store.answerQuestion(question.threadId, question.id, [optionId])
    }
  });
  flushSync();
}

async function asked(store: Store, id: string): Promise<QuestionRequest> {
  await vi.waitFor(() => expect(store.pendingQuestions.some((question) => question.id === id)).toBe(true));
  return store.pendingQuestions.find((question) => question.id === id)!;
}

async function verdictRow(store: Store, questionId: string): Promise<void> {
  if (mounted) await unmount(mounted);
  const host = store.openThread!.messages.find((message) => message.parts.some((part) => part.type === 'question' && part.questionId === questionId)) as Message;
  mounted = mount(AssistantMessage, { target: document.body, props: { store, threadId: host.threadId, message: host, signedOut: null, showModel: false } });
  // The timeline loads the card with the first one it draws.
  await vi.waitFor(() => expect(document.querySelector('[data-testid=agent-setting-card]')).not.toBeNull());
}

test('unticking one of two projects applies the rest; the card reads changed and the thread is told', async () => {
  const { client, store, agent } = await setup();
  try {
    const { questionId } = await client.call('agents.settings.request', { threadId: 't-trace', agent: 'Mira', key: 'projects', value: ['boite', 'notes'], reason: 'Both have threads to follow' });
    card(store, await asked(store, questionId));

    expect(query('[data-testid=agent-setting-heading]').textContent).toBe('Suggested change to Mira');
    expect(query('[data-testid=agent-setting-reason]').textContent).toBe('Both have threads to follow');
    const rows = [...document.querySelectorAll<HTMLInputElement>('[data-testid=agent-setting-project]')];
    expect(rows.map((row) => [row.dataset.project, row.checked, row.closest('label')!.textContent!.trim()])).toEqual([
      ['p-boite', true, 'Entrust boite'], ['p-notes', true, 'Entrust notes']
    ]);

    rows[1]!.click();
    flushSync();
    query<HTMLButtonElement>('[data-testid=agent-setting-apply]').click();
    await vi.waitFor(() => expect(store.pendingQuestions.some((question) => question.id === questionId)).toBe(false));
    const saved = (await client.call('agents.snapshot', {})).profiles.find((profile) => profile.id === agent.id)!;
    expect(saved.projectIds).toEqual(['p-boite']);
    await vi.waitFor(() => expect(store.openThread!.messages.some((message) => message.role === 'user' && message.parts.some((part) => part.type === 'text'
      && part.text === '> Both have threads to follow\n\nchanged: the user set Mira\'s projects to ["boite"], not ["boite","notes"]'))).toBe(true));

    await verdictRow(store, questionId);
    expect(query('[data-testid=agent-setting-card]').getAttribute('data-outcome')).toBe('changed');
    expect(query('[data-testid=agent-setting-verdict]').textContent).toBe('Set to boite instead');
    expect(query('[data-testid=agent-setting-subject]').textContent).toBe('Mira · Projects: boite');
  } finally {
    store.detach();
    client.close();
  }
});

test('Apply as proposed reads applied; Refuse reads refused and leaves the agent alone', async () => {
  const { client, store, agent } = await setup();
  try {
    const first = await client.call('agents.settings.request', { threadId: 't-trace', agent: agent.id, key: 'subagents', value: false, reason: 'One task at a time' });
    card(store, await asked(store, first.questionId));
    expect(query('[data-testid=agent-setting-previous]').textContent).toBe('On');
    expect(query('[data-testid=agent-setting-proposed]').textContent).toBe('Off');
    query<HTMLButtonElement>('[data-testid=agent-setting-apply]').click();
    await vi.waitFor(() => expect(store.pendingQuestions.some((question) => question.id === first.questionId)).toBe(false));
    expect((await client.call('agents.runtime.get', { agentId: agent.id })).subagents.enabled).toBe(false);
    await verdictRow(store, first.questionId);
    expect(query('[data-testid=agent-setting-card]').getAttribute('data-outcome')).toBe('applied');
    expect(query('[data-testid=agent-setting-verdict]').textContent).toBe('Applied');
    expect(query('[data-testid=agent-setting-subject]').textContent).toBe('Mira · Subagents: Off');

    await unmount(mounted!);
    const second = await client.call('agents.settings.request', { threadId: 't-trace', agent: agent.id, key: 'autoMemory', value: false, reason: 'The notes are noise' });
    card(store, await asked(store, second.questionId));
    query<HTMLButtonElement>('[data-testid=agent-setting-refuse]').click();
    await vi.waitFor(() => expect(store.pendingQuestions.some((question) => question.id === second.questionId)).toBe(false));
    expect((await client.call('agents.runtime.get', { agentId: agent.id })).autoMemory).toBe(true);
    await verdictRow(store, second.questionId);
    expect(query('[data-testid=agent-setting-card]').getAttribute('data-outcome')).toBe('refuse');
    expect(query('[data-testid=agent-setting-verdict]').textContent).toBe('Refused');
    expect(query('[data-testid=agent-setting-subject]').textContent).toBe('Mira · Update memory after each task: On');
  } finally {
    store.detach();
    client.close();
  }
});

test('a model card names the provider and the model, a probed model id that holds a slash included', async () => {
  const { client, store, agent } = await setup();
  try {
    await store.probeModels('opencode', 'a-opencode');
    const { questionId } = await client.call('agents.settings.request', { threadId: 't-trace', agent: agent.id, key: 'model', value: 'opencode/anthropic/claude-sonnet-5', reason: 'Cheaper for reviews' });
    const question = await asked(store, questionId);
    card(store, question);
    expect(query('[data-testid=agent-setting-proposed]').textContent).toBe('OpenCode · Claude Sonnet 5');
    // A card drawn before cards named the provider holds an id of the bot's own (Claude's): Apply reads it so, and so does the card.
    await unmount(mounted!);
    const { modelRefs: _, ...legacy } = question.agentSetting!;
    card(store, { ...question, agentSetting: legacy });
    expect(query('[data-testid=agent-setting-proposed]').textContent).toBe('opencode/anthropic/claude-sonnet-5');
  } finally {
    store.detach();
    client.close();
  }
});

test('an archived agent closes its card without an answer', async () => {
  const { client, store, agent } = await setup();
  try {
    const { questionId } = await client.call('agents.settings.request', { threadId: 't-trace', agent: agent.id, key: 'subagents', value: false, reason: 'Too many children' });
    await asked(store, questionId);
    await client.call('agents.profile.save', { id: agent.id, expectedRevision: agent.revision, value: { ...agent, status: 'archived' } });
    await vi.waitFor(() => expect(store.pendingQuestions.some((question) => question.id === questionId)).toBe(false));
    await verdictRow(store, questionId);
    expect(query('[data-testid=agent-setting-card]').getAttribute('data-state')).toBe('closed');
    expect(query('[data-testid=agent-setting-verdict]').textContent).toBe('Closed without an answer');
  } finally {
    store.detach();
    client.close();
  }
});

test('an instructions card shows the proposed text; an archive card applied reads applied, not closed', async () => {
  const { client, store, agent } = await setup();
  try {
    const rules = 'Guard the release.\nCheck every gate.';
    const { questionId } = await client.call('agents.settings.request', { threadId: 't-trace', agent: agent.id, key: 'instructions', value: rules, reason: 'The user gave me rules' });
    card(store, await asked(store, questionId));
    expect(query('[data-testid=agent-setting-previous]').textContent).toBe('None');
    expect(query('[data-testid=agent-setting-proposed]').textContent).toBe(`${rules.length} characters`);
    expect(query('[data-testid=agent-setting-text]').textContent).toBe(rules);
    query<HTMLButtonElement>('[data-testid=agent-setting-apply]').click();
    await vi.waitFor(() => expect(store.pendingQuestions.some((question) => question.id === questionId)).toBe(false));

    await unmount(mounted!);
    const archive = await client.call('agents.settings.request', { threadId: 't-trace', agent: 'Mira', key: 'status', value: 'archived', reason: 'Mira is no longer needed' });
    card(store, await asked(store, archive.questionId));
    expect(query('[data-testid=agent-setting-proposed]').textContent).toBe('Archived');
    query<HTMLButtonElement>('[data-testid=agent-setting-apply]').click();
    await vi.waitFor(() => expect(store.pendingQuestions.some((question) => question.id === archive.questionId)).toBe(false));
    expect((await client.call('agents.snapshot', {})).profiles.find((profile) => profile.id === agent.id)?.status).toBe('archived');
    await verdictRow(store, archive.questionId);
    expect(query('[data-testid=agent-setting-card]').getAttribute('data-outcome')).toBe('applied');
    expect(query('[data-testid=agent-setting-subject]').textContent).toBe('Mira · Status: Archived');
  } finally {
    store.detach();
    client.close();
  }
});

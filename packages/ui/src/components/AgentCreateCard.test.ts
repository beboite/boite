import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { Message, QuestionRequest } from '@boite/contracts';
import { FakeClient } from '../lib/fake-client';
import { Store } from '../lib/store.svelte';
import AssistantMessage from './AssistantMessage.svelte';
import AgentCreateCard from './AgentCreateCard.svelte';

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

async function setup(): Promise<{ client: FakeClient; store: Store }> {
  const client = new FakeClient({ delayMs: 0 });
  const store = new Store();
  store.attach(client);
  await store.connect();
  await store.open('t-trace');
  return { client, store };
}

async function card(store: Store, id: string): Promise<QuestionRequest> {
  await vi.waitFor(() => expect(store.pendingQuestions.some((question) => question.id === id)).toBe(true));
  const question = store.pendingQuestions.find((entry) => entry.id === id)!;
  mounted = mount(AgentCreateCard, {
    target: document.body,
    props: {
      store,
      threadId: question.threadId,
      questionId: question.id,
      text: question.text,
      create: question.agentCreate!,
      answer: null,
      pending: true,
      respond: (optionId: 'refuse') => store.answerQuestion(question.threadId, question.id, [optionId])
    }
  });
  flushSync();
  return question;
}

async function verdictRow(store: Store, questionId: string): Promise<void> {
  if (mounted) await unmount(mounted);
  const host = store.openThread!.messages.find((message) => message.parts.some((part) => part.type === 'question' && part.questionId === questionId)) as Message;
  mounted = mount(AssistantMessage, { target: document.body, props: { store, threadId: host.threadId, message: host, signedOut: null, showModel: false } });
  // The timeline loads the card with the first one it draws.
  await vi.waitFor(() => expect(document.querySelector('[data-testid=agent-create-card]')).not.toBeNull());
}

const told = (store: Store, start: string) => store.openThread!.messages.some((message) => message.role === 'user'
  && message.parts.some((part) => part.type === 'text' && part.text.startsWith(start)));

test('Create makes the proposed bot; the card reads created and the thread learns its conversation', async () => {
  const { client, store } = await setup();
  try {
    const { questionId } = await client.call('agents.settings.create', { threadId: 't-trace', name: 'Communication', domain: 'Posts and newsletters', instructions: 'Write the weekly post.', projects: ['notes'], reason: 'You asked for a communication bot' });
    await card(store, questionId);
    expect(query('[data-testid=agent-create-heading]').textContent).toBe('Suggested new bot');
    expect(query('[data-testid=agent-create-reason]').textContent).toBe('You asked for a communication bot');
    expect(query('[data-testid=agent-create-name]').textContent).toBe('Communication');
    expect(query('[data-testid=agent-create-projects]').textContent).toBe('notes');
    expect(query('[data-testid=agent-create-instructions]').textContent).toBe('Write the weekly post.');

    query<HTMLButtonElement>('[data-testid=agent-create-apply]').click();
    await vi.waitFor(() => expect(store.pendingQuestions.some((question) => question.id === questionId)).toBe(false));
    const bot = (await client.call('agents.snapshot', {})).profiles.find((profile) => profile.name === 'Communication')!;
    expect(bot).toMatchObject({ domain: 'Posts and newsletters', instructions: 'Write the weekly post.', projectIds: ['p-notes'], selection: { permissionMode: 'bypassPermissions' } });
    const { threadId: botThread } = await client.call('agents.open', { agentId: bot.id });
    await vi.waitFor(() => expect(told(store, `> You asked for a communication bot\n\ncreated: the bot Communication (${bot.id}) exists and introduces itself in its own conversation.\nIts conversation is thread ${botThread}: boite threads send ${botThread} <text> writes to it.`)).toBe(true));

    await verdictRow(store, questionId);
    expect(query('[data-testid=agent-create-card]').getAttribute('data-outcome')).toBe('created');
    expect(query('[data-testid=agent-create-verdict]').textContent).toBe('Created');
  } finally {
    store.detach();
    client.close();
  }
});

test('Refuse creates nothing, and the same name proposed again is a new card', async () => {
  const { client, store } = await setup();
  try {
    const first = await client.call('agents.settings.create', { threadId: 't-trace', name: 'Scout', reason: 'Watch the releases' });
    await card(store, first.questionId);
    query<HTMLButtonElement>('[data-testid=agent-create-refuse]').click();
    await vi.waitFor(() => expect(store.pendingQuestions.some((question) => question.id === first.questionId)).toBe(false));
    expect((await client.call('agents.snapshot', {})).profiles.some((profile) => profile.name === 'Scout')).toBe(false);
    await vi.waitFor(() => expect(told(store, '> Watch the releases\n\nrefused: no bot Scout was created')).toBe(true));
    await verdictRow(store, first.questionId);
    expect(query('[data-testid=agent-create-card]').getAttribute('data-outcome')).toBe('refuse');
    expect(query('[data-testid=agent-create-verdict]').textContent).toBe('Refused');
    await expect(client.call('agents.settings.create', { threadId: 't-trace', name: 'Scout', reason: 'Asked again' })).resolves.toMatchObject({ create: { name: 'Scout' } });
  } finally {
    store.detach();
    client.close();
  }
});

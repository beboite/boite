import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { Message, QuestionRequest } from '@boite/contracts';
import { FakeClient } from '../lib/fake-client';
import { Store } from '../lib/store.svelte';
import AssistantMessage from './AssistantMessage.svelte';
import SettingRequestCard from './SettingRequestCard.svelte';

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

function card(store: Store, question: QuestionRequest): void {
  mounted = mount(SettingRequestCard, {
    target: document.body,
    props: {
      store,
      text: question.text,
      setting: question.setting!,
      answer: null,
      pending: true,
      respond: (optionId: 'refuse' | 'open') => store.answerQuestion(question.threadId, question.id, [optionId])
    }
  });
  flushSync();
}

async function asked(store: Store, id: string): Promise<QuestionRequest> {
  await vi.waitFor(() => expect(store.pendingQuestions.some((question) => question.id === id)).toBe(true));
  return store.pendingQuestions.find((question) => question.id === id)!;
}

test('Apply writes the setting through settings.set, the card closes as applied and the agent is told', async () => {
  const { client, store } = await setup();
  try {
    const { questionId } = await client.call('settings.request', { threadId: 't-trace', reason: 'Builds stall under the cap', key: 'agentCpuCapPercent', value: 60 });
    card(store, await asked(store, questionId));

    expect(query('[data-testid=setting-reason]').textContent).toBe('Builds stall under the cap');
    expect(query('[data-testid=setting-previous]').textContent).toBe('75%');
    expect(query('[data-testid=setting-proposed]').textContent).toBe('60%');
    expect(query('[data-testid=setting-place]').textContent).toBe('Protection › Resource limits');

    query<HTMLButtonElement>('[data-testid=setting-apply]').click();
    await vi.waitFor(() => expect(store.pendingQuestions.some((question) => question.id === questionId)).toBe(false));
    expect((await client.call('settings.get', {})).agentCpuCapPercent).toBe(60);
    await vi.waitFor(() => expect(store.openThread!.messages.some((message) => message.role === 'user' && message.parts.some((part) => part.type === 'text' && part.text === '> Builds stall under the cap\n\napplied: agentCpuCapPercent is now 60'))).toBe(true));

    // The timeline keeps one quiet row saying what it came to.
    await unmount(mounted!);
    const host = store.openThread!.messages.find((message) => message.parts.some((part) => part.type === 'question' && part.questionId === questionId)) as Message;
    mounted = mount(AssistantMessage, { target: document.body, props: { store, threadId: host.threadId, message: host, signedOut: null, showModel: false } });
    flushSync();
    expect(query('[data-testid=setting-card]').getAttribute('data-outcome')).toBe('applied');
    expect(query('[data-testid=setting-subject]').textContent).toBe('CPU cap for all agents: 60%');
  } finally {
    store.detach();
    client.close();
  }
});

test('a sensitive setting has no Apply: the card opens its card in Settings, and Refuse tells the agent', async () => {
  const { client, store } = await setup();
  try {
    const { questionId } = await client.call('settings.request', { threadId: 't-trace', reason: 'A window keeps hiding', key: 'focusGuard', value: false });
    card(store, await asked(store, questionId));

    expect(document.querySelector('[data-testid=setting-apply]')).toBeNull();
    expect(query('[data-testid=setting-sensitive-hint]')).toBeTruthy();
    query<HTMLButtonElement>('[data-testid=setting-show]').click();
    flushSync();
    expect(store.page).toBe('settings');
    expect(store.settingsTab).toBe('resources');
    expect(store.settingsSection).toMatchObject({ id: 'quiet', flash: true });
    // Opening the page answers nothing: the card waits for the setting to move.
    expect(store.pendingQuestions.some((question) => question.id === questionId)).toBe(true);

    query<HTMLButtonElement>('[data-testid=setting-refuse]').click();
    await vi.waitFor(() => expect(store.pendingQuestions.some((question) => question.id === questionId)).toBe(false));
    await vi.waitFor(() => expect(store.openThread!.messages.some((message) => message.role === 'user' && message.parts.some((part) => part.type === 'text' && part.text === '> A window keeps hiding\n\nrefused: focusGuard stays true'))).toBe(true));
    expect((await client.call('settings.get', {})).focusGuard).toBe(true);
  } finally {
    store.detach();
    client.close();
  }
});

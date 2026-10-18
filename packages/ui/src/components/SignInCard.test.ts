import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { Message, QuestionRequest } from '@boite/contracts';
import { FakeClient } from '../lib/fake-client';
import { rightPanel } from '../lib/right-panel.svelte';
import { Store } from '../lib/store.svelte';
import AssistantMessage from './AssistantMessage.svelte';
import SignInCard from './SignInCard.svelte';

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

async function asked(store: Store, id: string): Promise<QuestionRequest> {
  await vi.waitFor(() => expect(store.pendingQuestions.some((question) => question.id === id)).toBe(true));
  return store.pendingQuestions.find((question) => question.id === id)!;
}

function card(store: Store, question: QuestionRequest): void {
  mounted = mount(SignInCard, {
    target: document.body,
    props: {
      store,
      threadId: question.threadId,
      questionId: question.id,
      text: question.text,
      signIn: question.signIn!,
      answer: null,
      pending: true,
      respond: (optionId: 'done') => store.answerQuestion(question.threadId, question.id, [optionId]),
      skip: () => store.skipQuestion(question.threadId, question.id)
    }
  });
  flushSync();
}

async function timelineRow(store: Store, questionId: string): Promise<void> {
  if (mounted) await unmount(mounted);
  const host = store.openThread!.messages.find((message) => message.parts.some((part) => part.type === 'question' && part.questionId === questionId)) as Message;
  mounted = mount(AssistantMessage, { target: document.body, props: { store, threadId: host.threadId, message: host, signedOut: null, showModel: false } });
  await vi.waitFor(() => expect(document.querySelector('[data-testid=sign-in-card]')).not.toBeNull());
}

test('the card names each site and the profile that keeps it; Open shows the page in the panel, Signed in tells the agent', async () => {
  const { client, store } = await setup();
  const { questionId } = await client.call('browser.signIn', { threadId: 't-trace', reason: 'To download the March invoices', urls: ['https://billing.example.com/login?next=%2Finvoices', 'https://portal.supplier.example/'] });
  // A second ask for a site still on the card is the same card.
  expect(await client.call('browser.signIn', { threadId: 't-trace', reason: 'again', urls: ['https://portal.supplier.example/home'] })).toMatchObject({ questionId, reused: true });
  card(store, await asked(store, questionId));

  expect(query('[data-testid=sign-in-reason]').textContent).toBe('To download the March invoices');
  const sites = [...document.querySelectorAll('[data-testid=sign-in-site]')];
  // The query string can hold a token: the card shows the path only.
  expect(sites.map((site) => site.querySelector('.where')!.textContent)).toEqual(['billing.example.com/login', 'portal.supplier.example']);
  expect(query('[data-testid=sign-in-kept]').textContent).toContain('Kept in the Default profile of');

  query<HTMLButtonElement>('[data-testid=sign-in-open]').click();
  await vi.waitFor(() => expect(rightPanel.for(store.threadKey('t-trace')).surfaces.some((surface) => surface.kind === 'agent-browser')).toBe(true));
  const { tabs } = await client.call('browser.remoteStatus', { threadId: 't-trace' });
  expect(tabs).toMatchObject([{ url: 'https://billing.example.com/login?next=%2Finvoices', profile: 'default', active: true }]);
  // Open again brings the same tab forward.
  query<HTMLButtonElement>('[data-testid=sign-in-open]').click();
  await vi.waitFor(async () => expect((await client.call('browser.remoteStatus', { threadId: 't-trace' })).tabs).toHaveLength(1));
  flushSync();
  expect(query('[data-testid=sign-in-done]').className).toContain('primary');

  query<HTMLButtonElement>('[data-testid=sign-in-done]').click();
  await vi.waitFor(() => expect(store.pendingQuestions.some((question) => question.id === questionId)).toBe(false));
  await vi.waitFor(() => expect(store.openThread!.messages.some((message) => message.role === 'user' && message.parts.some((part) => part.type === 'text'
    && part.text.startsWith('> To download the March invoices\n\nThe user says they signed in to billing.example.com, portal.supplier.example in the Default browser profile')))).toBe(true));

  await timelineRow(store, questionId);
  expect(query('[data-testid=sign-in-card]').getAttribute('data-state')).toBe('answered');
  expect(query('[data-testid=sign-in-verdict]').textContent).toBe('Signed in');
});

test('a skipped card reads skipped in the timeline and its page no longer opens', async () => {
  const { client, store } = await setup();
  const { questionId } = await client.call('browser.signIn', { threadId: 't-trace', reason: 'To read the account page', urls: ['https://bank.example/'] });
  card(store, await asked(store, questionId));
  query<HTMLButtonElement>('[data-testid=sign-in-skip]').click();
  await vi.waitFor(() => expect(store.pendingQuestions.some((question) => question.id === questionId)).toBe(false));
  await expect(client.call('browser.signInOpen', { threadId: 't-trace', questionId, site: 0 })).rejects.toThrow('closed');
  await timelineRow(store, questionId);
  expect(query('[data-testid=sign-in-verdict]').textContent).toBe('Sign-in skipped');
});

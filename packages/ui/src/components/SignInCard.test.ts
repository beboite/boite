import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { Message, QuestionRequest } from '@boite/contracts';
import { FakeClient } from '../lib/fake-client';
import { rightPanel } from '../lib/right-panel.svelte';
import { Store } from '../lib/store.svelte';
import type { AgentsView } from '../lib/agents.svelte';
import AssistantMessage from './AssistantMessage.svelte';
import SignInCard from './SignInCard.svelte';
import AgentPendingQuestions from './agents/AgentPendingQuestions.svelte';

let mounted: ReturnType<typeof mount> | undefined;
afterEach(async () => {
  if (mounted) await unmount(mounted);
  mounted = undefined;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
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

test('on the Agents page, where no panel shows the hidden session thread, Open shows the page in the card', async () => {
  const { client, store } = await setup();
  // A session thread nobody opens: this client is not subscribed to it.
  const hidden = store.threads.find((thread) => thread.id !== 't-trace' && !thread.archived)!.id;
  const { questionId } = await client.call('browser.signIn', { threadId: hidden, reason: 'To read the build logs', urls: ['https://ci.example/login'] });
  await asked(store, questionId);
  const scope = { kind: 'agent' as const, id: 'a-ada' };
  const view = { store, snapshot: { profiles: [], groups: [], work: [], sessions: [{ id: 's-1', agentId: 'a-ada', scope, threadId: hidden }] } };
  mounted = mount(AgentPendingQuestions, { target: document.body, props: { view: view as unknown as AgentsView, scope } });
  await vi.waitFor(() => expect(document.querySelector('[data-testid=sign-in-open]')).not.toBeNull());
  expect(document.querySelector('[data-testid=agent-browser-surface]')).toBeNull();

  query<HTMLButtonElement>('[data-testid=sign-in-open]').click();
  await vi.waitFor(() => expect(query('[data-testid=sign-in-card] [data-testid=agent-browser-tab]')).not.toBeNull());
  expect(document.querySelector('[data-testid=sign-in-card] [role=alert]')).toBeNull();
  const { tabs } = await client.call('browser.remoteStatus', { threadId: hidden });
  expect(tabs).toMatchObject([{ url: 'https://ci.example/login', active: true }]);
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

async function agentCards(count: number): Promise<{ client: FakeClient; store: Store; hidden: string }> {
  const { client, store } = await setup();
  const hidden = store.threads.find((thread) => thread.id !== 't-trace' && !thread.archived)!.id;
  for (let i = 0; i < count; i++) await client.call('browser.signIn', { threadId: hidden, reason: 'To read the build logs', urls: [`https://ci${i}.example/login`] });
  const scope = { kind: 'agent' as const, id: 'a-ada' };
  const view = { store, snapshot: { profiles: [], groups: [], work: [], sessions: [{ id: 's-1', agentId: 'a-ada', scope, threadId: hidden }] } };
  mounted = mount(AgentPendingQuestions, { target: document.body, props: { view: view as unknown as AgentsView, scope } });
  await vi.waitFor(() => expect(document.querySelectorAll('[data-testid=sign-in-open]')).toHaveLength(count));
  return { client, store, hidden };
}

test('two cards on one hidden thread share its subscription: the one that leaves keeps the other browser streaming', async () => {
  const { client, hidden } = await agentCards(2);
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-testid=sign-in-open]')) button.click();
  await vi.waitFor(() => expect(document.querySelectorAll('[data-testid=sign-in-browser]')).toHaveLength(2));
  query<HTMLButtonElement>('[data-testid=sign-in-skip]').click();
  await vi.waitFor(() => expect(document.querySelectorAll('[data-testid=sign-in-card]')).toHaveLength(1));
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(client.coreSubscribers).toContain(hidden);
  await expect(client.call('browser.remoteStatus', { threadId: hidden })).resolves.toMatchObject({ live: true });

  // The last card to leave lets the thread go.
  await unmount(mounted!);
  mounted = undefined;
  await vi.waitFor(() => expect(client.coreSubscribers).not.toContain(hidden));
});

test('a card that leaves while its subscription is on the way lets the thread go when it lands', async () => {
  const { client, hidden } = await agentCards(1);
  const real = client.call.bind(client);
  let land = (): void => {};
  let asked = false, opened = false;
  vi.spyOn(client, 'call').mockImplementation(((method: string, params: { threadId?: string }) => {
    if (method === 'browser.signInOpen') opened = true;
    if (method === 'threads.subscribe' && params.threadId === hidden) {
      asked = true;
      return new Promise((resolve, reject) => { land = () => { real(method as never, params as never).then(resolve, reject); }; });
    }
    return real(method as never, params as never);
  }) as typeof client.call);
  query<HTMLButtonElement>('[data-testid=sign-in-open]').click();
  await vi.waitFor(() => expect(asked).toBe(true));
  await unmount(mounted!);
  mounted = undefined;
  land();
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(client.coreSubscribers).not.toContain(hidden);
  // Nor did it open the page for a card nobody sees.
  expect(opened).toBe(false);
});

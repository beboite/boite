import { afterEach, expect, test, vi } from 'vitest';
import { mount, unmount } from 'svelte';
import { setExperiment } from './experiments';
import { FakeClient } from './fake-client';
import { rightPanel } from './right-panel.svelte';
import { Store } from './store.svelte';
import type { AgentsView } from './agents.svelte';
import ThreadActivity from '../components/ThreadActivity.svelte';
import AgentPendingQuestions from '../components/agents/AgentPendingQuestions.svelte';

let mounted: ReturnType<typeof mount> | undefined;
afterEach(async () => {
  if (mounted) await unmount(mounted);
  mounted = undefined;
  document.body.innerHTML = '';
  setExperiment('resident-agents', false);
});

async function setup(): Promise<{ client: FakeClient; store: Store }> {
  const client = new FakeClient({ delayMs: 0 });
  const store = new Store();
  store.attach(client);
  await store.connect();
  await store.open('t-trace');
  return { client, store };
}

const ask = (client: FakeClient, threadId: string, url: string) =>
  client.call('questions.ask', { threadId, text: 'To read the build logs', options: ['Signed in', 'Skip'], open: url });

/** The thread's panel shows its browser, on that page. */
async function shown(client: FakeClient, store: Store, threadId: string, url: string): Promise<void> {
  const panel = rightPanel.for(store.threadKey(threadId));
  await vi.waitFor(() => expect(panel.active?.kind).toBe('agent-browser'));
  expect(panel.isOpen).toBe(true);
  expect((await client.call('browser.remoteStatus', { threadId })).tabs).toMatchObject([{ url, active: true }]);
}

test('in the thread, Open on a question asked with --open shows its page in the panel, on the Browser tab', async () => {
  const { client, store } = await setup();
  // The dock above the composer holds the card the thread waits on: the seeded one is skipped first.
  for (const question of store.pendingQuestions.filter((pending) => pending.threadId === 't-trace')) await store.skipQuestion('t-trace', question.id);
  await ask(client, 't-trace', 'https://ci.example/login');
  mounted = mount(ThreadActivity, { target: document.body, props: { store } });
  await vi.waitFor(() => expect(document.querySelector('[data-testid=question-open]')).not.toBeNull());
  const open = document.querySelector<HTMLButtonElement>('[data-testid=question-open]')!;
  expect([open.textContent, open.title]).toEqual(['Open', 'https://ci.example/login']);
  open.click();
  await shown(client, store, 't-trace', 'https://ci.example/login');
});

test('on the Agents page, Open goes to the session thread and shows its page in that thread\'s panel', async () => {
  setExperiment('resident-agents', true);
  const { client, store } = await setup();
  // A persistent agent's session thread, not the one open in the chat.
  const hidden = store.threads.find((thread) => thread.id !== 't-trace' && !thread.archived)!.id;
  await ask(client, hidden, 'https://ci.example/login');
  store.showAgents();
  const scope = { kind: 'agent' as const, id: 'a-ada' };
  const view = { store, snapshot: { profiles: [], groups: [], work: [], sessions: [{ id: 's-1', agentId: 'a-ada', scope, threadId: hidden }] } };
  mounted = mount(AgentPendingQuestions, { target: document.body, props: { view: view as unknown as AgentsView, scope } });
  await vi.waitFor(() => expect(document.querySelector('[data-testid=question-open]')).not.toBeNull());
  document.querySelector<HTMLButtonElement>('[data-testid=question-open]')!.click();
  await shown(client, store, hidden, 'https://ci.example/login');
  expect(store.page).toBe('chat');
  expect(store.openThread?.id).toBe(hidden);
});

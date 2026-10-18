import { afterEach, expect, test } from 'vitest';
import type { ThreadSummary } from '@boite/contracts';
import { FakeClient } from './fake-client';
import { Store } from './store.svelte';
import { agentsAtWork, workingThreads } from './work-counts';

const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) { store.client?.close(); store.detach(); } });

async function ready() {
  const store = new Store();
  store.attach(new FakeClient({ delayMs: 0 }));
  await store.connect();
  stores.push(store);
  return store;
}

test('the switch counts the conversations at work on every machine, and says when one needs the user', async () => {
  const first = await ready(), second = await ready();
  const calm = (store: Store) => { store.threads = store.threads.map(thread => ({ ...thread, status: 'idle', openQuestions: 0, backgroundWork: null, unread: false })); };
  calm(first); calm(second);
  expect(workingThreads([first, second])).toEqual({ count: 0, subagents: 0, waiting: false });
  first.threads = first.threads.map(thread => thread.id === 't-scheduler' ? { ...thread, status: 'running' } : thread);
  second.threads = second.threads.map(thread => thread.id === 't-scheduler' ? { ...thread, status: 'queued' } : thread);
  expect(workingThreads([first, second])).toEqual({ count: 2, subagents: 0, waiting: false });
  // A machine that stopped answering keeps its last list, not its place in the count.
  first.connection = 'closed';
  expect(workingThreads([first, second])).toEqual({ count: 1, subagents: 0, waiting: false });
  first.connection = 'ready';
  second.threads = second.threads.map(thread => thread.id === 't-bench' ? { ...thread, status: 'waiting' } : thread);
  expect(workingThreads([first, second])).toEqual({ count: 3, subagents: 0, waiting: true });
  // A thread in an archived project is out of the list, so out of the count.
  second.projects = second.projects.map(project => project.id === second.threads.find(thread => thread.id === 't-bench')!.projectId ? { ...project, archived: true } : project);
  expect(workingThreads([first, second]).waiting).toBe(false);
});

test('the delegated agents under a listed thread add to the count, at any depth, and an archived one or one at rest does not', async () => {
  const store = await ready();
  const base = store.threads.find(thread => thread.id === 't-scheduler')!;
  const child = (id: string, parent: string, fields: Partial<ThreadSummary> = {}) => ({ ...base, id, parentThreadId: parent, status: 'running', ...fields }) as ThreadSummary;
  store.threads = [
    ...store.threads.map(thread => ({ ...thread, status: 'idle', openQuestions: 0, backgroundWork: null, unread: false })),
    child('c-1', 't-scheduler'), child('c-2', 't-scheduler'), child('g-1', 'c-1'),
    child('c-3', 't-scheduler', { status: 'idle' }), child('c-4', 't-scheduler', { archived: true }),
  ] as ThreadSummary[];
  // The parent's turn ended and it waits on its children: one row, three agents.
  expect(workingThreads([store])).toEqual({ count: 4, subagents: 3, waiting: false });
  // A child asking the user counts as at work and turns the badge to the waiting colour.
  store.threads = store.threads.map(thread => thread.id === 'c-3' ? { ...thread, openQuestions: 1 } : thread);
  expect(workingThreads([store])).toEqual({ count: 5, subagents: 4, waiting: true });
  // A grandchild asking turns the badge too, though only its own parent's row reads Needs you.
  store.threads = store.threads.map(thread => thread.id === 'c-3' ? { ...thread, openQuestions: 0 } : thread.id === 'g-1' ? { ...thread, status: 'waiting' } : thread);
  expect(workingThreads([store])).toEqual({ count: 4, subagents: 3, waiting: true });
});

test('an entrusted thread mid-turn counts once among the agents at work', async () => {
  const store = await ready();
  const { agentDirectory } = await import('./agent-directory.svelte');
  store.threads = store.threads.map(thread => ({ ...thread, status: thread.id === 't-scheduler' ? 'running' : 'idle', openQuestions: 0, backgroundWork: null }));
  const snapshot = { profiles: [{ id: 'agent-1', name: 'Mira', status: 'active' }], sessions: [], runs: [], work: [], entrusted: [] };
  agentDirectory(store).snapshot = snapshot as never;
  expect(agentsAtWork([store])).toEqual({ count: 0, waiting: false });
  // Entrusted, and the agent's own work runs in that same thread: one thread, one count.
  agentDirectory(store).snapshot = { ...snapshot, entrusted: [{ threadId: 't-scheduler', agentId: 'agent-1', at: 0 }],
    work: [{ id: 'w-1', agentId: 'agent-1', status: 'running', runId: 'r-1' }], runs: [{ id: 'r-1', threadId: 't-scheduler', startedAt: 0 }] } as never;
  expect(agentsAtWork([store])).toEqual({ count: 1, waiting: false });
});

test('an agent whose own thread rests but asks the user counts, in the waiting colour', async () => {
  const store = await ready();
  const { agentDirectory } = await import('./agent-directory.svelte');
  store.threads = store.threads.map(thread => ({ ...thread, status: 'idle', openQuestions: 0, backgroundWork: null, unread: false,
    ...(thread.id === 't-trace' ? { agentSessionId: 'session-1', openQuestions: 1 } : {}) }));
  agentDirectory(store).snapshot = { profiles: [{ id: 'agent-1', name: 'Mira', status: 'active' }], sessions: [{ id: 'session-1', agentId: 'agent-1' }], work: [], runs: [], entrusted: [] } as never;
  expect(agentsAtWork([store])).toEqual({ count: 1, waiting: true });
});

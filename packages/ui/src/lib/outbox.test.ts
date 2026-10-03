import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { FakeClient } from './fake-client';
import { Store } from './store.svelte';
import { readDraftJournal, writeDraftJournal } from './draft-journal';

// jsdom has no IndexedDB: the durable journal is a recorder here, and the
// synchronous backup in localStorage is what a new Store reads back.
vi.mock('./draft-journal', () => ({ readDraftJournal: vi.fn(async () => null), writeDraftJournal: vi.fn(async () => {}) }));

const stores: Store[] = [];
const clients: FakeClient[] = [];

/** A Store on `machine` whose client records every start, connected only when asked. */
async function machine(id: string, before?: (client: FakeClient) => Promise<void>) {
  const store = new Store();
  store.machineId = id;
  const client = new FakeClient({ delayMs: 0 });
  clients.push(client);
  if (before) { await client.connect(); await before(client); }
  const original = client.call.bind(client);
  const starts: { prompt: string; clientRequestId: string }[] = [];
  vi.spyOn(client, 'call').mockImplementation(async (method, params) => {
    if (method === 'turns.start') starts.push(params as { prompt: string; clientRequestId: string });
    return original(method, params);
  });
  store.attach(client);
  stores.push(store);
  return { store, client, starts, connect: () => store.connect() };
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  for (const store of stores.splice(0)) { store.client?.close(); store.detach(); }
  for (const client of clients.splice(0)) client.close();
  vi.restoreAllMocks();
  vi.mocked(readDraftJournal).mockResolvedValue(null);
  vi.mocked(writeDraftJournal).mockResolvedValue();
});

/** Two prompts written while the machine was away, then the app closed. */
async function writtenAway(threadId?: string) {
  const first = await machine('one');
  await first.connect();
  const thread = threadId ?? first.store.threads.find(row => row.status === 'idle')!.id;
  await first.store.open(thread);
  first.client.drop();
  expect(first.store.connection).not.toBe('ready');
  first.store.queuePrompt(thread, { text: 'Written in the tunnel', attachments: [{ kind: 'file', mimeType: 'text/plain', name: 'note.txt', data: 'aGVsbG8=' }] }, { choice: null });
  first.store.queuePrompt(thread, { text: 'And one more', attachments: [] }, { choice: null });
  const ids = first.store.composerStates[thread]!.queued.map(entry => entry.request!.id);
  expect(new Set(ids).size).toBe(2);
  expect(first.starts).toHaveLength(0);
  first.store.client?.close(); first.store.detach();
  return { thread, ids };
}

async function userPrompts(client: FakeClient, threadId: string): Promise<string[]> {
  const thread = await client.call('threads.get', { threadId });
  return thread.messages.filter(message => message.role === 'user').map(message => JSON.stringify(message.parts));
}

test('prompts written offline survive closing the app and go out in order, once each, under their own ids', async () => {
  const { thread, ids } = await writtenAway();
  // Another machine has its own outbox: nothing of machine one is there.
  const other = await machine('two');
  await other.connect();
  expect(other.store.composerStates[thread]?.queued ?? []).toHaveLength(0);

  const next = await machine('one');
  // Restored before the machine answers, not held: an outbox resends by itself.
  await next.connect();
  await vi.waitFor(() => expect(next.store.composerStates[thread]?.queued).toHaveLength(0), { timeout: 5000 });
  expect(next.starts.map(start => [start.prompt, start.clientRequestId])).toEqual([['Written in the tunnel', ids[0]], ['And one more', ids[1]]]);
  const prompts = await userPrompts(next.client, thread);
  expect(prompts.filter(parts => parts.includes('Written in the tunnel'))).toHaveLength(1);
  expect(prompts.at(-1)).toContain('And one more');
  expect(prompts.find(parts => parts.includes('Written in the tunnel'))).toContain('note.txt');
  expect(other.starts).toHaveLength(0);
});

test('a prompt the machine already took before the answer was lost is not sent twice', async () => {
  const { thread, ids } = await writtenAway();
  const next = await machine('one', async client => {
    // The core took the first prompt; only its answer never reached the phone.
    await client.call('turns.start', { threadId: thread, prompt: 'Written in the tunnel', clientRequestId: ids[0]!,
      attachments: [{ kind: 'file', mimeType: 'text/plain', name: 'note.txt', data: 'aGVsbG8=' }] });
    await client.settled();
  });
  await next.connect();
  await vi.waitFor(() => expect(next.store.composerStates[thread]?.queued).toHaveLength(0), { timeout: 5000 });
  const prompts = await userPrompts(next.client, thread);
  expect(prompts.filter(parts => parts.includes('Written in the tunnel'))).toHaveLength(1);
  expect(prompts.filter(parts => parts.includes('And one more'))).toHaveLength(1);
});

test('a refused outbox prompt stays with its reason and is not sent again until asked', async () => {
  const { thread, ids } = await writtenAway();
  const next = await machine('one');
  const original = vi.mocked(next.client.call).getMockImplementation()!;
  let refuse = true;
  vi.mocked(next.client.call).mockImplementation(async (method, params) => {
    if (method === 'turns.start' && refuse) { refuse = false; throw new Error('The account is signed out'); }
    return original(method, params);
  });
  await next.connect();
  await vi.waitFor(() => expect(next.store.composerStates[thread]?.queued[0]?.request?.failed).toBeDefined(), { timeout: 5000 });
  expect(next.store.composerStates[thread]!.queued[0]!.request!.failed).toContain('signed out');
  expect(next.store.composerStates[thread]!.queued).toHaveLength(2);
  // The failure is kept on the device too.
  const reopened = await machine('one');
  await reopened.connect();
  await vi.waitFor(() => expect(reopened.store.composerStates[thread]?.queued[0]?.request).toMatchObject({ id: ids[0], failed: expect.stringContaining('signed out') }));
  reopened.store.detach();
  next.store.retryQueued(thread, 0);
  await vi.waitFor(() => expect(next.store.composerStates[thread]?.queued).toHaveLength(0), { timeout: 5000 });
  const prompts = await userPrompts(next.client, thread);
  expect(prompts.filter(parts => parts.includes('Written in the tunnel'))).toHaveLength(1);
  expect(prompts.filter(parts => parts.includes('And one more'))).toHaveLength(1);
});

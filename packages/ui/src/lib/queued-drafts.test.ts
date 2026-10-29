import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { FakeClient } from './fake-client';
import { Store } from './store.svelte';
import { readDraftJournal, writeDraftJournal } from './draft-journal';

// jsdom has no IndexedDB: the durable journal is a recorder here, and the
// synchronous backup in localStorage is what a new Store reads back.
vi.mock('./draft-journal', () => ({ readDraftJournal: vi.fn(async () => null), writeDraftJournal: vi.fn(async () => {}) }));

const stores: Store[] = [];
const clients: FakeClient[] = [];

/** Only explicit UI RPCs are recorded; queued draft creation belongs to the core. */
async function machine(id: string) {
  const store = new Store();
  store.machineId = id;
  const client = new FakeClient({ delayMs: 0 });
  clients.push(client);
  const original = client.call.bind(client);
  const creates: { title?: string; clientRequestId?: string }[] = [];
  const starts: { threadId: string; prompt: string; clientRequestId: string }[] = [];
  vi.spyOn(client, 'call').mockImplementation(async (method, params) => {
    if (method === 'threads.create') creates.push(params as { title?: string; clientRequestId?: string });
    if (method === 'turns.start') starts.push(params as { threadId: string; prompt: string; clientRequestId: string });
    return original(method, params);
  });
  store.attach(client);
  stores.push(store);
  return { store, client, creates, starts, original };
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  for (const store of stores.splice(0)) { store.client?.close(); store.detach(); }
  for (const client of clients.splice(0)) client.close();
  vi.restoreAllMocks();
  vi.mocked(readDraftJournal).mockResolvedValue(null);
  vi.mocked(writeDraftJournal).mockResolvedValue();
});


function sendAway(store: Store, text: string) {
  store.queuePrompt('draft', { text, attachments: [] }, { choice: store.defaultChoice() });
}

test('an offline draft starts once through the core record and follows its new conversation', async () => {
  const { store, client, creates, starts } = await machine('one');
  await store.connect();
  const project = store.projects.find(entry => entry.kind !== 'drafts')!;
  store.startDraft(project.id, { fresh: true });
  client.drop();
  sendAway(store, 'Start the migration');
  expect(store.draftEntries[0]).toMatchObject({ text: 'Start the migration', queued: 'waiting' });
  expect(creates).toHaveLength(0);
  await client.restore();
  await vi.waitFor(() => expect(store.openThread?.title).toBe('Start the migration'));
  const threads = (await client.call('threads.list', {})).filter(thread => thread.title === 'Start the migration');
  expect(threads).toHaveLength(1);
  await vi.waitFor(async () => {
    const thread = await client.call('threads.get', { threadId: threads[0]!.id });
    expect(thread.messages.filter(message => message.role === 'user')).toHaveLength(1);
  });
  expect(creates).toHaveLength(0);
  expect(starts).toHaveLength(0);
  expect(store.draftEntries).toHaveLength(0);
});

test('cancelling a queued draft before admission restores its text and does not start it', async () => {
  const { store, client } = await machine('one');
  await store.connect();
  const project = store.projects.find(entry => entry.kind !== 'drafts')!;
  store.startDraft(project.id, { fresh: true });
  client.drop();
  sendAway(store, 'Never mind');
  const row = store.draftEntries[0]!;
  store.cancelQueuedDraft(row.id);
  expect(store.composerStates.draft).toMatchObject({ text: 'Never mind', queued: [] });
  await client.restore();
  await vi.waitFor(() => expect(store.connection).toBe('ready'));
  await client.settled();
  expect((await client.call('threads.list', {})).some(thread => thread.title === 'Never mind')).toBe(false);
});

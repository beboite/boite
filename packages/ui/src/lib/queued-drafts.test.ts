import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { droppedFailure } from './client';
import { FakeClient } from './fake-client';
import { Store } from './store.svelte';
import { readDraftJournal, writeDraftJournal } from './draft-journal';

// jsdom has no IndexedDB: the durable journal is a recorder here, and the
// synchronous backup in localStorage is what a new Store reads back.
vi.mock('./draft-journal', () => ({ readDraftJournal: vi.fn(async () => null), writeDraftJournal: vi.fn(async () => {}) }));

const stores: Store[] = [];
const clients: FakeClient[] = [];

/** A Store on `machine` whose client records every creation and start. */
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

/** What the composer does with Send on a draft whose machine is away. */
function sendAway(store: Store, text: string) {
  store.queuePrompt('draft', { text, attachments: [] }, { choice: store.defaultChoice() });
}

async function titled(client: FakeClient, title: string) {
  return (await client.call('threads.list', {})).filter(thread => thread.title === title);
}

test('a draft sent while its machine is away waits on its row, survives closing the app and starts once, on screen', async () => {
  const first = await machine('one');
  await first.store.connect();
  const project = first.store.projects.find(entry => entry.kind !== 'drafts')!;
  first.store.startDraft(project.id, { fresh: true });
  first.client.drop();
  sendAway(first.store, 'Start the migration');
  // The box empties; the row says the conversation waits for the machine.
  expect(first.store.composerStates.draft!.text).toBe('');
  const [row] = first.store.draftEntries;
  expect(row).toMatchObject({ projectId: project.id, text: 'Start the migration', queued: 'waiting', active: true });
  expect(first.creates).toHaveLength(0);
  first.store.client?.close(); first.store.detach();

  const next = await machine('one');
  await next.store.connect();
  const draftId = row!.id;
  // Back on the draft it was written in, as the next start opens where it was left.
  next.store.startDraft(project.id, { draftId });
  await vi.waitFor(() => expect(next.starts).toHaveLength(1), { timeout: 5000 });
  expect(next.creates).toHaveLength(1);
  const created = next.creates[0]!;
  expect(created.title).toBe('Start the migration');
  expect(next.starts[0]).toMatchObject({ prompt: 'Start the migration', clientRequestId: created.clientRequestId });
  // The draft became that conversation, which is on screen now.
  await vi.waitFor(() => expect(next.store.openThread?.title).toBe('Start the migration'));
  expect(next.store.draftEntries).toHaveLength(0);
  expect(await titled(next.client, 'Start the migration')).toHaveLength(1);
});

test('a start whose answer the link lost is asked again under its id and makes one conversation', async () => {
  const { store, client, creates, starts, original } = await machine('one');
  await store.connect();
  const project = store.projects.find(entry => entry.kind !== 'drafts')!;
  store.startDraft(project.id, { fresh: true });
  client.drop();
  sendAway(store, 'Only once please');
  let lose = true;
  vi.mocked(client.call).mockImplementation(async (method, params) => {
    if (method === 'threads.create') creates.push(params as { title?: string; clientRequestId?: string });
    if (method === 'turns.start') starts.push(params as { threadId: string; prompt: string; clientRequestId: string });
    const result = await original(method, params);
    // The core made it; the link went before its answer arrived.
    if (method === 'threads.create' && lose) { lose = false; client.drop(); throw droppedFailure('connection lost; check the conversation before resending'); }
    return result;
  });
  await client.restore();
  await vi.waitFor(() => expect(creates).toHaveLength(1), { timeout: 5000 });
  expect(starts).toHaveLength(0);
  await vi.waitFor(() => expect(store.connection).toBe('connecting'));
  expect(store.draftEntries[0]).toMatchObject({ queued: 'waiting' });
  await client.restore();
  await vi.waitFor(() => expect(starts).toHaveLength(1), { timeout: 5000 });
  expect(creates).toHaveLength(2);
  expect(creates[1]!.clientRequestId).toBe(creates[0]!.clientRequestId);
  expect(await titled(client, 'Only once please')).toHaveLength(1);
});

test('cancelling a queued start brings its words back into the draft, which no longer starts by itself', async () => {
  const { store, client, creates } = await machine('one');
  await store.connect();
  const project = store.projects.find(entry => entry.kind !== 'drafts')!;
  store.startDraft(project.id, { fresh: true });
  client.drop();
  sendAway(store, 'Never mind');
  const [row] = store.draftEntries;
  store.cancelQueuedDraft(row!.id);
  expect(store.composerStates.draft).toMatchObject({ text: 'Never mind', queued: [] });
  expect(store.draftEntries[0]).toMatchObject({ text: 'Never mind', queued: null });
  await client.restore();
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(creates).toHaveLength(0);
});

test('a refused start keeps its reason on the draft, and Send again starts it', async () => {
  const { store, client, creates, original } = await machine('one');
  await store.connect();
  const project = store.projects.find(entry => entry.kind !== 'drafts')!;
  store.startDraft(project.id, { fresh: true });
  client.drop();
  sendAway(store, 'Signed out meanwhile');
  let refuse = true;
  vi.mocked(client.call).mockImplementation(async (method, params) => {
    if (method === 'threads.create') {
      creates.push(params as { title?: string; clientRequestId?: string });
      if (refuse) { refuse = false; throw new Error('The account is signed out'); }
    }
    return original(method, params);
  });
  await client.restore();
  await vi.waitFor(() => expect(store.draftEntries[0]?.queued).toEqual({ failed: expect.stringContaining('signed out') }), { timeout: 5000 });
  expect(creates).toHaveLength(1);
  store.retryQueued('draft', 0);
  await vi.waitFor(() => expect(store.openThread?.title).toBe('Signed out meanwhile'), { timeout: 5000 });
  expect(creates).toHaveLength(2);
});

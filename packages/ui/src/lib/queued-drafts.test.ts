import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { RpcErrorCode } from '@boite/contracts';
import { RpcFailure, droppedFailure, unansweredFailure } from './client';
import { FakeClient } from './fake-client';
import { Store } from './store.svelte';
import { readDraftJournal, writeDraftJournal } from './draft-journal';

// jsdom has no IndexedDB: the durable journal is a recorder here, and the
// synchronous backup in localStorage is what a new Store reads back.
vi.mock('./draft-journal', () => ({ readDraftJournal: vi.fn(async () => null), writeDraftJournal: vi.fn(async () => {}) }));

const stores: Store[] = [];
const clients: FakeClient[] = [];

/** A Store on `machine` whose client records every creation and start. Its core keeps no composer records, so the frontend starts drafts. */
async function machine(id: string) {
  const store = new Store();
  store.machineId = id;
  const client = new FakeClient({ delayMs: 0, missing: ['composer.list'] });
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
  // The prompt waits in the draft's own queue, under a request id; the row says the conversation waits for the machine.
  expect(first.store.composerStates.draft!.queued).toMatchObject([{ text: 'Start the migration', request: { id: expect.any(String) } }]);
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
  // Moved to another project meanwhile: the retry still asks for what the core may already hold.
  const other = store.projects.find(entry => entry.kind !== 'drafts' && entry.id !== project.id);
  store.draft!.projectId = other!.id;
  await client.restore();
  await vi.waitFor(() => expect(starts).toHaveLength(1), { timeout: 5000 });
  expect(creates).toHaveLength(2);
  expect(creates[1]!.clientRequestId).toBe(creates[0]!.clientRequestId);
  expect(creates[1]).toEqual(creates[0]);
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
  await vi.waitFor(() => expect(store.connection).toBe('ready'));
  // Long enough for a start to have gone out: a queued draft starts within a tick of the machine's lists.
  await new Promise(resolve => setTimeout(resolve, 500));
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
  // The core made nothing: the start is no longer held as asked, so it could be taken back or edited.
  expect(store.draftEntries[0]).not.toHaveProperty('asked');
  expect(store.composerStates.draft!.queued[0]!.request).not.toHaveProperty('start');
  store.retryQueued('draft', 0);
  await vi.waitFor(() => expect(store.openThread?.title).toBe('Signed out meanwhile'), { timeout: 5000 });
  expect(creates).toHaveLength(2);
});

test('a start the core never answered, on a link still up, is not asked again in a loop', async () => {
  const { store, client, creates, original } = await machine('one');
  await store.connect();
  const project = store.projects.find(entry => entry.kind !== 'drafts')!;
  store.startDraft(project.id, { fresh: true });
  client.drop();
  sendAway(store, 'Slow core');
  vi.mocked(client.call).mockImplementation(async (method, params) => {
    if (method === 'threads.create') { creates.push(params as { title?: string; clientRequestId?: string }); throw unansweredFailure('threads.create'); }
    return original(method, params);
  });
  await client.restore();
  await vi.waitFor(() => expect(creates).toHaveLength(1), { timeout: 5000 });
  await new Promise(resolve => setTimeout(resolve, 300));
  // Asked once, then left alone for a while under the same id; the draft still waits.
  expect(creates).toHaveLength(1);
  expect(store.draftEntries[0]).toMatchObject({ queued: 'waiting' });
});

test('at every write on its way to the conversation the queued prompt is kept somewhere on the device', async () => {
  const { store, client, starts } = await machine('one');
  await store.connect();
  const project = store.projects.find(entry => entry.kind !== 'drafts')!;
  store.startDraft(project.id, { fresh: true });
  client.drop();
  sendAway(store, 'Never lost');
  const id = store.composerStates.draft!.queued[0]!.request!.id;
  const kept = () => Object.keys(localStorage).some(name => name.includes(':entry:') && localStorage.getItem(name)!.includes(id));
  expect(kept()).toBe(true);
  // A crash may come after any one write: until the core has the prompt, one of them must still hold it.
  const lost: string[] = [];
  const watch = (name: string) => { if (starts.length === 0 && !kept()) lost.push(name); };
  const set = Storage.prototype.setItem, remove = Storage.prototype.removeItem;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, name: string, value: string) { set.call(this, name, value); watch(name); });
  vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(function (this: Storage, name: string) { remove.call(this, name); watch(name); });
  await client.restore();
  await vi.waitFor(() => expect(starts).toHaveLength(1), { timeout: 5000 });
  expect(lost).toEqual([]);
});

test('a draft whose start is on its way is not deleted: its prompt reaches the conversation the core made', async () => {
  const { store, client, creates, starts, original } = await machine('one');
  await store.connect();
  const project = store.projects.find(entry => entry.kind !== 'drafts')!;
  store.startDraft(project.id, { fresh: true });
  client.drop();
  sendAway(store, 'Already on its way');
  let release: () => void = () => undefined;
  const held = new Promise<void>(resolve => { release = resolve; });
  vi.mocked(client.call).mockImplementation(async (method, params) => {
    if (method === 'threads.create') { creates.push(params as { title?: string; clientRequestId?: string }); await held; }
    if (method === 'turns.start') starts.push(params as { threadId: string; prompt: string; clientRequestId: string });
    return original(method, params);
  });
  await client.restore();
  await vi.waitFor(() => expect(creates).toHaveLength(1), { timeout: 5000 });
  const [row] = store.draftEntries;
  expect(row).toMatchObject({ queued: 'starting' });
  store.discardDraft(row!.id);
  store.cancelQueuedDraft(row!.id);
  expect(store.draftEntries[0]).toMatchObject({ id: row!.id, queued: 'starting' });
  release();
  await vi.waitFor(() => expect(starts).toHaveLength(1), { timeout: 5000 });
  expect(starts[0]!.prompt).toBe('Already on its way');
  expect(store.draftEntries).toHaveLength(0);
});

test('a start asked once is retried as it was asked, across a restart, and is not taken back meanwhile', async () => {
  const first = await machine('one');
  await first.store.connect();
  const project = first.store.projects.find(entry => entry.kind !== 'drafts')!;
  first.store.startDraft(project.id, { fresh: true });
  first.client.drop();
  sendAway(first.store, 'Asked once');
  vi.mocked(first.client.call).mockImplementation(async (method, params) => {
    if (method === 'threads.create') { first.creates.push(params as { title?: string; clientRequestId?: string }); throw unansweredFailure('threads.create'); }
    return first.original(method, params);
  });
  await first.client.restore();
  await vi.waitFor(() => expect(first.creates).toHaveLength(1), { timeout: 5000 });
  const [row] = first.store.draftEntries;
  expect(row).toMatchObject({ queued: 'waiting', asked: true });
  // The core may hold it: neither the row's menu, the cross nor a tap takes it back.
  first.store.cancelQueuedDraft(row!.id);
  first.store.removeQueued('draft', 0);
  expect(first.store.restoreQueued('draft', 0)).toBeUndefined();
  expect(first.store.composerStates.draft!.queued).toHaveLength(1);
  // Moved to another project before the app closes.
  first.store.draft!.projectId = first.store.projects.find(entry => entry.kind !== 'drafts' && entry.id !== project.id)!.id;
  first.store.client?.close(); first.store.detach();

  const next = await machine('one');
  await next.store.connect();
  next.store.startDraft(undefined, { draftId: row!.id });
  await vi.waitFor(() => expect(next.creates).toHaveLength(1), { timeout: 5000 });
  expect(next.creates[0]).toEqual(first.creates[0]);
  expect((next.creates[0] as { projectId?: string }).projectId).toBe(project.id);
});

test('a start asked once and then refused may be taken back: the core made nothing', async () => {
  const first = await machine('one');
  await first.store.connect();
  const project = first.store.projects.find(entry => entry.kind !== 'drafts')!;
  first.store.startDraft(project.id, { fresh: true });
  first.client.drop();
  sendAway(first.store, 'Asked, then refused');
  vi.mocked(first.client.call).mockImplementation(async (method, params) => {
    if (method === 'threads.create') { first.creates.push(params as { title?: string; clientRequestId?: string }); throw unansweredFailure('threads.create'); }
    return first.original(method, params);
  });
  await first.client.restore();
  await vi.waitFor(() => expect(first.creates).toHaveLength(1), { timeout: 5000 });
  const [row] = first.store.draftEntries;
  expect(row).toMatchObject({ asked: true });
  first.store.client?.close(); first.store.detach();

  const next = await machine('one');
  vi.mocked(next.client.call).mockImplementation(async (method, params) => {
    if (method === 'threads.create') { next.creates.push(params as { title?: string; clientRequestId?: string }); throw new Error('The account is signed out'); }
    return next.original(method, params);
  });
  await next.store.connect();
  next.store.startDraft(undefined, { draftId: row!.id });
  await vi.waitFor(() => expect(next.store.draftEntries[0]?.queued).toEqual({ failed: expect.stringContaining('signed out') }), { timeout: 5000 });
  expect(next.store.draftEntries[0]).not.toHaveProperty('asked');
  next.store.cancelQueuedDraft(row!.id);
  expect(next.store.composerStates.draft).toMatchObject({ text: 'Asked, then refused', queued: [] });
});

test('a start whose conversation was deleted since unlocks, and Send again goes under a fresh id', async () => {
  const first = await machine('one');
  await first.store.connect();
  const project = first.store.projects.find(entry => entry.kind !== 'drafts')!;
  first.store.startDraft(project.id, { fresh: true });
  first.client.drop();
  sendAway(first.store, 'Deleted meanwhile');
  vi.mocked(first.client.call).mockImplementation(async (method, params) => {
    if (method === 'threads.create') { first.creates.push(params as { title?: string; clientRequestId?: string }); throw unansweredFailure('threads.create'); }
    return first.original(method, params);
  });
  await first.client.restore();
  await vi.waitFor(() => expect(first.creates).toHaveLength(1), { timeout: 5000 });
  const [row] = first.store.draftEntries;
  expect(row).toMatchObject({ asked: true });
  first.store.client?.close(); first.store.detach();

  const next = await machine('one');
  let deleted = true;
  vi.mocked(next.client.call).mockImplementation(async (method, params) => {
    if (method === 'threads.create') {
      next.creates.push(params as { title?: string; clientRequestId?: string });
      if (deleted) {
        deleted = false;
        throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'the conversation this request started was deleted since', data: { field: 'clientRequestId', reason: 'deleted' } });
      }
    }
    return next.original(method, params);
  });
  await next.store.connect();
  next.store.startDraft(undefined, { draftId: row!.id });
  await vi.waitFor(() => expect(next.store.draftEntries[0]?.queued).toEqual({ failed: expect.stringContaining('deleted since') }), { timeout: 5000 });
  expect(next.store.draftEntries[0]).not.toHaveProperty('asked');
  // Send again goes under a fresh id: the deleted conversation burned the first one.
  next.store.retryQueued('draft', 0);
  await vi.waitFor(() => expect(next.creates).toHaveLength(2), { timeout: 5000 });
  expect(next.creates[1]!.clientRequestId).not.toBe(next.creates[0]!.clientRequestId);
  await vi.waitFor(() => expect(next.store.openThread?.title).toBe('Deleted meanwhile'), { timeout: 5000 });
});

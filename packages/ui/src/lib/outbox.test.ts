import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { unansweredFailure } from './client';
import { FakeClient } from './fake-client';
import { Store } from './store.svelte';
import { readDraftJournal, writeDraftJournal } from './draft-journal';

// jsdom has no IndexedDB: the durable journal is a recorder here, and the
// synchronous backup in localStorage is what a new Store reads back.
vi.mock('./draft-journal', () => ({ readDraftJournal: vi.fn(async () => null), writeDraftJournal: vi.fn(async () => {}) }));

const stores: Store[] = [];
const clients: FakeClient[] = [];

/** A device whose RPC recorder distinguishes explicit sends from core-owned delivery. */
async function machine(id: string, before?: (client: FakeClient) => Promise<void>, delayMs = 0) {
  const store = new Store();
  store.machineId = id;
  const client = new FakeClient({ delayMs });
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


async function userPrompts(client: FakeClient, threadId: string): Promise<string[]> {
  const thread = await client.call('threads.get', { threadId });
  return thread.messages.filter(message => message.role === 'user').map(message => JSON.stringify(message.parts));
}

test('offline input survives a detached Store and reconnects through composer.put without UI turn starts', async () => {
  const first = await machine('one');
  await first.connect();
  await first.store.open('t-trace');
  first.client.drop();
  const file = { kind: 'file' as const, mimeType: 'text/plain', name: 'note.txt', data: 'aGVsbG8=' };
  first.store.queuePrompt('t-trace', { text: 'Written in the tunnel', attachments: [file] }, { choice: null });
  first.store.queuePrompt('t-trace', { text: 'And one more', attachments: [] }, { choice: null });
  const ids = first.store.composerStates['t-trace']!.queued.map(entry => entry.id);
  first.store.detach(); first.client.close();
  const next = await machine('one');
  await next.connect();
  await vi.waitFor(() => expect(next.store.composerStates['t-trace']?.queued ?? []).toHaveLength(0));
  const prompts = await userPrompts(next.client, 't-trace');
  expect(prompts.filter(parts => parts.includes('Written in the tunnel'))).toHaveLength(1);
  expect(prompts.find(parts => parts.includes('Written in the tunnel'))).toContain('note.txt');
  expect(prompts.filter(parts => parts.includes('And one more'))).toHaveLength(1);
  expect(next.starts).toHaveLength(0);
  const remote = await next.client.call('composer.list', {});
  const snapshot = remote.find(row => row.id === 't-trace')!;
  await next.client.call('composer.put', { section: 'inputs', id: 't-trace', expectedRevision: snapshot.revision,
    value: { input: { text: '', attachments: [], paused: false, queued: ids.map((id, at) => ({ id: id!, text: at ? 'And one more' : 'Written in the tunnel', attachments: [] })) } } });
  await next.client.settled();
  expect((await userPrompts(next.client, 't-trace')).filter(parts => parts.includes('Written in the tunnel'))).toHaveLength(1);
});

test('a prompt the machine took but never answered is asked again under its id, not handed back to resend', async () => {
  // iOS freezes a page sent to the background: back on screen, the call's
  // 120 s timer fires at once while the core already holds the prompt.
  const phone = await machine('one');
  await phone.connect();
  const thread = phone.store.threads.find(row => row.status === 'idle')!.id;
  await phone.store.open(thread);
  const original = vi.mocked(phone.client.call).getMockImplementation()!;
  let lose = true;
  vi.mocked(phone.client.call).mockImplementation(async (method, params) => {
    const result = await original(method, params);
    if (method === 'turns.start' && lose) { lose = false; throw unansweredFailure('turns.start'); }
    return result;
  });
  // Accepted: the composer clears the box instead of offering the text again.
  expect(await phone.store.send('It works', thread)).toBe(true);
  expect(phone.starts).toHaveLength(2);
  expect(phone.starts[1]!.clientRequestId).toBe(phone.starts[0]!.clientRequestId);
  expect((await userPrompts(phone.client, thread)).filter(parts => parts.includes('It works'))).toHaveLength(1);
});

test('an outbox prompt put back in the box and sent unchanged keeps its request id', async () => {
  const phone = await machine('one');
  await phone.connect();
  const thread = phone.store.threads.find(row => row.status === 'idle')!.id;
  await phone.store.open(thread);
  phone.client.drop();
  phone.store.queuePrompt(thread, { text: 'Written in the tunnel', attachments: [] }, { choice: null });
  const id = phone.store.composerStates[thread]!.queued[0]!.request!.id;
  const entry = phone.store.restoreQueued(thread, 0)!;
  expect(phone.store.composerStates[thread]!.queued).toHaveLength(0);
  await phone.client.restore();
  await vi.waitFor(() => expect(phone.store.connection).toBe('ready'));
  // The core took it before the answer was lost.
  await phone.client.call('turns.start', { threadId: thread, prompt: entry.text, clientRequestId: id });
  await phone.client.settled();
  expect(await phone.store.send(entry.text, thread)).toBe(true);
  expect(phone.starts.map(start => start.clientRequestId)).toEqual([id, id]);
  expect((await userPrompts(phone.client, thread)).filter(parts => parts.includes('Written in the tunnel'))).toHaveLength(1);
});

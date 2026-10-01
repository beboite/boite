import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { flushSync, tick } from 'svelte';
import { FakeClient } from './fake-client';
import { Store } from './store.svelte';
import { strings } from './strings';
import { writeDraftJournal } from './draft-journal';

// jsdom has no IndexedDB: the durable journal is a recorder here, and reads come back empty.
vi.mock('./draft-journal', () => ({ readDraftJournal: vi.fn(async () => null), writeDraftJournal: vi.fn(async () => {}) }));

const stores: Store[] = [];
async function ready(machine = '', local = false) {
  const store = new Store();
  store.machineId = machine;
  store.localCore = local;
  store.attach(new FakeClient({ delayMs: 0 }));
  await store.connect();
  stores.push(store);
  return store;
}
beforeEach(() => localStorage.clear());
afterEach(() => { vi.useRealTimers(); for (const store of stores.splice(0)) { store.client?.close(); store.detach(); } });

test('unsent text survives a new Store without a clean shutdown and stays machine-scoped', async () => {
  const first = await ready('one');
  first.editComposerText('t-trace', 'Keep these words');
  const restored = await ready('one');
  expect(restored.composerStates['t-trace']?.text).toBe('Keep these words');
  expect((await ready('two')).composerStates['t-trace']).toBeUndefined();
  restored.editComposerText('t-trace', '');
  expect((await ready('one')).composerStates['t-trace']?.text ?? '').toBe('');
});

test('a local core moving to another port keeps its drafts', async () => {
  const first = await ready('http://localhost:4000', true);
  first.editComposerText('t-trace', 'A local reply');
  const next = await ready('http://localhost:5000', true);
  expect(next.composerStates['t-trace']?.text).toBe('A local reply');
});

test('storage failures keep the text in memory and explain that it could not be saved', async () => {
  const store = await ready();
  const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Full', 'QuotaExceededError'); });
  try {
    store.editComposerText('t-trace', 'Still here');
    expect(store.composerStates['t-trace']?.text).toBe('Still here');
    expect(store.error).toBe(strings.errors.draftStorage);
  } finally { write.mockRestore(); }
});

test('unresolved attachment placeholders cannot reach a turn or create a thread', async () => {
  const store = await ready();
  const attachment = { kind: 'file' as const, mimeType: 'text/plain', name: 'unread.txt', data: '', pendingDraftAsset: 'fixture-asset' };
  store.startDraft(store.projects[0]!.id);
  const count = store.threads.length;
  expect(await store.submit('Keep the file', store.defaultChoice()!, [attachment])).toBe(false);
  expect(store.threads).toHaveLength(count);
  expect(store.error).toBe(strings.errors.draftAttachment);
  expect(await store.send('Keep the file', 't-trace', [attachment])).toBe(false);
  expect(store.error).toBe(strings.errors.draftAttachment);
});

test('moving a draft cannot overwrite another project draft', async () => {
  const store = await ready();
  const [a, b] = store.projects;
  store.startDraft(a!.id);
  store.editComposerText('draft', 'First');
  store.startDraft(b!.id);
  store.editComposerText('draft', 'Second');
  store.setDraftProject(a!.id);
  expect(store.draft?.projectId).toBe(b!.id);
  expect(store.error).toBe(strings.errors.draftExists);
  store.startDraft(a!.id);
  expect(store.composerStates.draft?.text).toBe('First');
});

test('a created thread keeps its text after a refused send without leaving a second draft', async () => {
  const store = await ready();
  store.startDraft(store.projects[0]!.id);
  store.editComposerText('draft', 'Please keep this failed send');
  const send = vi.spyOn(store, 'send').mockResolvedValue(false);
  expect(await store.submit('Please keep this failed send', store.defaultChoice()!)).toBe(false);
  await tick();
  const id = store.openThread!.id;
  expect(store.draftEntries).toHaveLength(0);
  expect((await ready()).composerStates[id]?.text).toBe('Please keep this failed send');
  send.mockRestore();
});

test('new conversation drafts retain their project and text after navigation and restart', async () => {
  const store = await ready();
  const [a, b] = store.projects;
  expect(a && b).toBeTruthy();
  store.startDraft(a!.id);
  store.editComposerText('draft', 'First project prompt');
  store.startDraft(b!.id);
  expect(store.composerStates.draft?.text ?? '').toBe('');
  store.editComposerText('draft', 'Second project prompt');
  await tick();
  const restored = await ready();
  restored.startDraft(a!.id);
  expect(restored.composerStates.draft?.text).toBe('First project prompt');
  restored.startDraft(b!.id);
  expect(restored.composerStates.draft?.text).toBe('Second project prompt');
});

test('typing reaches the durable journal once it pauses, a new file at once', async () => {
  const store = await ready('durable');
  const writes = vi.mocked(writeDraftJournal);
  writes.mockClear();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  for (const text of ['K', 'Ke', 'Kee', 'Keep']) {
    store.editComposerText('t-trace', text);
    flushSync();
    await vi.advanceTimersByTimeAsync(100);
  }
  // Every key is in the synchronous backup already; none of them cloned the journal into IndexedDB.
  expect(JSON.parse(localStorage.getItem(Object.keys(localStorage).find(key => key.startsWith('boite.unsent'))!)!).inputs['t-trace'].text).toBe('Keep');
  expect(writes).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1000);
  expect(writes).toHaveBeenCalledOnce();
  expect((writes.mock.lastCall![1] as { inputs: Record<string, { text: string }> }).inputs['t-trace']!.text).toBe('Keep');

  // A picture exists nowhere else yet: its bytes go down without waiting for a pause.
  writes.mockClear();
  store.composerStates['t-trace']!.attachments = [{ kind: 'image', mimeType: 'image/png', name: 'shot.png', data: 'aGVsbG8=' }];
  flushSync();
  await vi.advanceTimersByTimeAsync(0);
  expect(writes).toHaveBeenCalledOnce();

  // Typing that never pauses still reaches it within the longest wait.
  writes.mockClear();
  for (let at = 0; at < 60; at++) {
    store.editComposerText('t-trace', `Keep ${'x'.repeat(at)}`);
    await vi.advanceTimersByTimeAsync(100);
  }
  expect(writes.mock.calls.length).toBeGreaterThanOrEqual(1);
  expect(writes.mock.calls.length).toBeLessThanOrEqual(2);
});

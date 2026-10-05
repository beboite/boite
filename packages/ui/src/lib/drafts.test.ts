import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { flushSync, tick } from 'svelte';
import { FakeClient } from './fake-client';
import { Store } from './store.svelte';
import { strings } from './strings';
import { readDraftJournal, writeDraftJournal } from './draft-journal';
import { webcrypto } from 'node:crypto';

// jsdom has no IndexedDB: the durable journal is a recorder here, and reads come back empty.
vi.mock('./draft-journal', () => ({ readDraftJournal: vi.fn(async () => null), writeDraftJournal: vi.fn(async () => {}) }));

const stores: Store[] = [];
async function ready(machine = '', local = false, dataDir?: string) {
  const store = new Store();
  store.machineId = machine;
  store.localCore = local;
  const client = new FakeClient({ delayMs: 0 });
  if (dataDir) { await client.connect(); client.core!.dataDir = dataDir; }
  store.attach(client);
  await store.connect();
  stores.push(store);
  return store;
}
beforeEach(() => localStorage.clear());
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); for (const store of stores.splice(0)) { store.client?.close(); store.detach(); } vi.restoreAllMocks(); vi.mocked(readDraftJournal).mockResolvedValue(null); vi.mocked(writeDraftJournal).mockResolvedValue(); });

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
  const journal = await vi.importActual<typeof import('./draft-journal')>('./draft-journal');
  vi.mocked(readDraftJournal).mockImplementation(journal.readDraftJournal);
  vi.mocked(writeDraftJournal).mockImplementation(journal.writeDraftJournal);
  vi.stubGlobal('indexedDB', undefined);
  const store = await ready();
  const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Full', 'QuotaExceededError'); });
  try {
    store.editComposerText('t-trace', 'Still here');
    expect(store.composerStates['t-trace']?.text).toBe('Still here');
    expect(store.error).toBe(strings.errors.draftStorage);
    expect(await store.flushDrafts()).toBe(false);
    expect(store.composerStates['t-trace']?.text).toBe('Still here');
  } finally { write.mockRestore(); }
});

test('a real journal checkpoint recovers input when the synchronous backup is denied', async () => {
  const journal = await vi.importActual<typeof import('./draft-journal')>('./draft-journal');
  vi.mocked(readDraftJournal).mockImplementation(journal.readDraftJournal);
  vi.mocked(writeDraftJournal).mockImplementation(journal.writeDraftJournal);
  const persisted = new Map<string, unknown>();
  // Only the browser API is synthetic; Store and both journal functions run.
  const transaction = vi.fn((_name: string, _mode: string, _options?: { durability: string }) => {
    const tx = {
      oncomplete: null as (() => void) | null, onabort: null as (() => void) | null, error: null,
      abort() { tx.onabort?.(); },
      objectStore() { return {
        get(key: string) {
          const request = { result: structuredClone(persisted.get(key)) };
          queueMicrotask(() => tx.oncomplete?.());
          return request;
        },
        put(value: unknown, key: string) {
          const snapshot = structuredClone(value);
          queueMicrotask(() => { persisted.set(key, snapshot); tx.oncomplete?.(); });
        }
      }; }
    };
    return tx;
  });
  const db = { transaction, close: vi.fn() };
  vi.stubGlobal('indexedDB', { open() {
    const request = { result: db, onsuccess: null as (() => void) | null };
    queueMicrotask(() => request.onsuccess?.());
    return request;
  } });
  const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Full', 'QuotaExceededError'); });
  try {
    const store = await ready('durable-without-backup');
    store.editComposerText('t-trace', 'Kept by the durable journal');
    expect(await store.flushDrafts()).toBe(true);
    expect(transaction).toHaveBeenCalledWith('drafts', 'readwrite', { durability: 'strict' });
    expect(persisted.size).toBe(1);
    expect(localStorage.length).toBe(0);
    const recovered = await ready('durable-without-backup');
    expect(recovered.composerStates['t-trace']?.text).toBe('Kept by the durable journal');
  } finally {
    for (const store of stores) { store.client?.close(); store.detach(); }
    window.dispatchEvent(new Event('pagehide'));
    write.mockRestore();
  }
});

test('an empty landing draft during a failed read preserves unread durable text and explicit deletions', async () => {
  const durable = { updatedAt: 1, inputs: {}, drafts: {
    null: { draft: { projectId: null, worktree: false }, input: { text: 'An older durable draft', attachments: [], queued: [] } }
  } };
  vi.mocked(readDraftJournal).mockRejectedValueOnce(new Error('IndexedDB unavailable'));
  const unavailable = await ready('unread-drafts');
  unavailable.startDraft(null);
  unavailable.editComposerText('t-trace', 'A reply during the storage failure');
  expect(await unavailable.flushDrafts()).toBe(false);

  vi.mocked(readDraftJournal).mockResolvedValue(durable);
  const recovered = await ready('unread-drafts');
  expect(recovered.composerStates['t-trace']?.text).toBe('A reply during the storage failure');
  recovered.startDraft(null);
  expect(recovered.composerStates.draft?.text).toBe('An older durable draft');
  recovered.editComposerText('draft', '');
  await recovered.flushDrafts();
  const cleared = await ready('unread-drafts');
  cleared.startDraft(null);
  expect(cleared.composerStates.draft?.text ?? '').toBe('');
});

test.each([
  { typed: null, parked: false },
  { typed: 'New text while reconnecting', parked: false },
  { typed: 'New text while reconnecting', parked: true }
])('a deferred reconnect recovers an untouched draft and preserves newer input: $typed, parked=$parked', async ({ typed, parked }) => {
  const store = await ready('deferred-read');
  store.booted = true;
  const durable = { updatedAt: 1, inputs: {
    't-trace': { text: 'Previously saved reply', attachments: [], queued: [] }
  }, drafts: {
    '"p-boite"': { draft: { projectId: 'p-boite', worktree: false }, input: { text: 'Previously saved input', attachments: [], queued: [] } }
  } };
  let release!: (value: unknown) => void;
  vi.mocked(readDraftJournal).mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
  store.client?.close();
  store.attach(new FakeClient({ delayMs: 0 }));
  store.composerStates = {}; store.projects = []; store.threads = [];
  const connecting = store.connect();
  try {
    await vi.waitFor(() => expect(store.projects.some(project => project.id === 'p-boite')).toBe(true));
    // Clicking a blank composer creates its caret state before a late read.
    store.composerStates['t-trace'] = { text: '', attachments: [], queued: [], sending: false, paused: false };
    store.startDraft('p-boite');
    if (typed !== null) { store.editComposerText('draft', typed); store.setDraftWorktree(true); }
    if (parked) store.startDraft(null);
  } finally { release(durable); await connecting; }
  if (parked) store.startDraft('p-boite');
  const expected = typed ?? 'Previously saved input';
  expect(store.composerStates.draft?.text).toBe(expected);
  expect(store.draft?.worktree).toBe(typed !== null);
  expect(store.composerStates['t-trace']?.text).toBe('Previously saved reply');
  store.editComposerText('t-parser', 'An unrelated reply');
  expect(await store.flushDrafts()).toBe(true);
  const checkpoint = vi.mocked(writeDraftJournal).mock.calls.at(-1)![1] as typeof durable;
  expect(checkpoint.drafts['"p-boite"']?.input.text).toBe(expected);
  vi.mocked(readDraftJournal).mockResolvedValue(checkpoint);
  const recovered = await ready('deferred-read');
  recovered.startDraft('p-boite');
  expect(recovered.composerStates.draft?.text).toBe(expected);
  expect(recovered.composerStates['t-parser']?.text).toBe('An unrelated reply');
  expect(recovered.composerStates['t-trace']?.text).toBe('Previously saved reply');
});

test('cancelling a deferred reconnect keeps new input without replacing the unread journal', async () => {
  const store = await ready('cancel-pending-read');
  store.booted = true;
  const durable = { updatedAt: 1, inputs: {
    't-parser': { text: 'An unread saved reply', attachments: [], queued: [] }
  }, drafts: {
    '\"p-boite\"': { draft: { projectId: 'p-boite', worktree: false }, input: { text: 'Previously saved input', attachments: [], queued: [] } }
  } };
  let release!: (value: unknown) => void;
  vi.mocked(readDraftJournal).mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
  store.client?.close();
  const client = new FakeClient({ delayMs: 0 });
  store.attach(client);
  store.composerStates = {}; store.projects = []; store.threads = [];
  const connecting = store.connect();
  let flushed = true;
  let writesBeforeCancel = -1;
  try {
    await vi.waitFor(() => expect(store.projects.some(project => project.id === 'p-boite')).toBe(true));
    vi.mocked(writeDraftJournal).mockClear();
    store.startDraft('p-boite');
    store.editComposerText('draft', 'New input before cancellation');
    store.setDraftWorktree(true);
    store.editComposerText('t-trace', 'A new reply before cancellation');
    flushed = await store.flushDrafts();
    writesBeforeCancel = vi.mocked(writeDraftJournal).mock.calls.length;
    store.detach(); client.close();
    store.composerStates = {}; store.draft = null;
  } finally { release(durable); await connecting; client.close(); }
  vi.mocked(readDraftJournal).mockResolvedValue(durable);
  const recovered = await ready('cancel-pending-read');
  recovered.startDraft('p-boite');
  expect(recovered.composerStates.draft?.text).toBe('New input before cancellation');
  expect(recovered.draft?.worktree).toBe(true);
  expect(recovered.composerStates['t-trace']?.text).toBe('A new reply before cancellation');
  expect(recovered.composerStates['t-parser']?.text).toBe('An unread saved reply');
  expect(flushed).toBe(false);
  expect(writesBeforeCancel).toBe(0);
  expect(await recovered.flushDrafts()).toBe(true);
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
  expect(Object.values(localStorage).some(value => value.includes('"text":"Keep"'))).toBe(true);
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

test('typing touches only its own backup while 300 unrelated inputs remain recoverable', async () => {
  const store = await ready('large-journal');
  for (let at = 0; at < 300; at++) store.composerStates[`saved-${at}`] = { text: 'x'.repeat(4000), attachments: [], queued: [], sending: false, paused: true };
  flushSync(); await store.flushDrafts();
  for (let at = 0; at < 5; at++) store.editComposerText('t-trace', `warm ${at}`);
  const write = vi.spyOn(Storage.prototype, 'setItem');
  const samples: number[] = [];
  for (let at = 0; at < 40; at++) {
    const started = performance.now(); store.editComposerText('t-trace', `typed ${at}`); samples.push(performance.now() - started);
  }
  const characters = write.mock.calls.reduce((sum, [, value]) => sum + value.length, 0);
  const sorted = samples.toSorted((a, b) => a - b);
  console.log(JSON.stringify({ workload: '300 inputs x 4000 chars, 40 edits', measuredAt: new Date().toISOString(), medianMs: sorted[20], p95Ms: sorted[38], backupCharactersWritten: characters, writes: write.mock.calls.length }));
  write.mockRestore();
  const restored = await ready('large-journal');
  expect(restored.composerStates['saved-299']?.text).toBe('x'.repeat(4000));
  expect(restored.composerStates['t-trace']?.text).toBe('typed 39');
  expect(characters).toBeLessThan(40 * 10_000);
});

test.each(['HTTP', 'unavailable'] as const)('plain HTTP randomness handles steering retries and attachment backup: %s', async capability => {
  const store = await ready(`crypto-${capability}`);
  const client = store.client!;
  const call = client.call.bind(client);
  let attempts = 0;
  const spy = vi.spyOn(client, 'call').mockImplementation((method, params) => {
    if (method !== 'turns.steer') return call(method, params);
    attempts++;
    return attempts === 1 ? Promise.reject(new Error('Uncertain socket result')) : Promise.resolve({ accepted: false }) as ReturnType<typeof call>;
  });
  vi.stubGlobal('crypto', capability === 'HTTP' ? { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) } : {});
  const first = store.steer('New instructions', 't-trace', 'synthetic-running-turn', [], []);
  await expect(first).resolves.toBeNull();
  expect(store.error).not.toBeNull(); store.error = null;
  if (capability === 'HTTP') {
    await expect(store.steer('New instructions', 't-trace', 'synthetic-running-turn', [], [])).resolves.toBe(false);
    const ids = spy.mock.calls.filter(([method]) => method === 'turns.steer').map(([, params]) => (params as { clientRequestId: string }).clientRequestId);
    expect(ids).toHaveLength(2); expect(ids[0]).toBe(ids[1]); expect(ids[0]).toMatch(/^[a-zA-Z0-9_-]{20,}$/);
  }
  store.composerStates['t-trace'] = { text: 'Attached input', attachments: [{ kind: 'file', mimeType: 'text/plain', name: 'file.txt', data: 'aGVsbG8=' }], queued: [], sending: false, paused: true };
  expect(() => store.editComposerText('t-trace', 'Preserved input')).not.toThrow();
  expect(store.composerStates['t-trace']?.text).toBe('Preserved input');
  if (capability === 'HTTP') {
    expect(await store.flushDrafts()).toBe(true);
    expect((vi.mocked(writeDraftJournal).mock.lastCall![1] as { inputs: Record<string, { attachments: { data: string }[] }> }).inputs['t-trace']!.attachments[0]!.data).toBe('aGVsbG8=');
  } else { expect(store.error).toBe(strings.errors.draftStorage); expect(await store.flushDrafts()).toBe(false); }
});

test('attachment persistence uses secure HTTP randomness without losing synchronous crash recovery', async () => {
  const store = await ready('HTTP-attachment');
  const fullCrypto = globalThis.crypto;
  vi.stubGlobal('crypto', { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) });
  store.composerStates['t-trace'] = { text: 'Attached input', attachments: [{ kind: 'file', mimeType: 'text/plain', name: 'http.txt', data: 'aGVsbG8=' }], queued: [], sending: false, paused: true };
  expect(() => store.editComposerText('t-trace', 'Saved on HTTP')).not.toThrow();
  // FakeClient bootstrap has separate UUID callers; this test scopes HTTP to persistence.
  vi.stubGlobal('crypto', fullCrypto);
  const recovered = await ready('HTTP-attachment');
  expect(recovered.composerStates['t-trace']).toMatchObject({ text: 'Saved on HTTP', attachments: [{ data: 'aGVsbG8=' }] });
});

test('removed assets leave the index only after a pending durable journal settles and never resurrect', async () => {
  const store = await ready('asset-lifetime');
  const payload = 'A'.repeat(262_144);
  let index: Map<unknown, unknown> | undefined;
  const set = Map.prototype.set;
  vi.spyOn(Map.prototype, 'set').mockImplementation(function (this: Map<unknown, unknown>, key, value) { if (key === payload) index = this; return set.call(this, key, value); });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let durable: unknown;
  const writes = vi.mocked(writeDraftJournal);
  writes.mockImplementationOnce(async (_key, value) => { durable = value; await gate; });
  writes.mockImplementation(async (_key, value) => { durable = value; });
  const input = { text: 'Keep shared file', attachments: [{ kind: 'file' as const, mimeType: 'text/plain', name: 'large.txt', data: payload }], queued: [], sending: false, paused: true };
  store.composerStates['t-trace'] = input;
  store.composerStates['t-parser'] = { ...input };
  flushSync();
  expect(index?.has(payload)).toBe(true);
  store.composerStates['t-trace']!.attachments = []; flushSync();
  expect(index?.has(payload)).toBe(true);
  store.composerStates['t-parser']!.attachments = []; flushSync();
  store.composerStates['t-trace']!.text = 'Latest before pagehide';
  window.dispatchEvent(new Event('pagehide'));
  expect(index?.has(payload)).toBe(true);
  release(); await vi.waitFor(() => expect(writes.mock.calls.length).toBeGreaterThanOrEqual(2));
  expect(await store.flushDrafts()).toBe(true);
  expect(index?.has(payload)).toBe(false);
  vi.mocked(readDraftJournal).mockResolvedValue(durable);
  const restored = await ready('asset-lifetime');
  expect(restored.composerStates['t-trace']?.attachments).toEqual([]);
  expect(restored.composerStates['t-trace']?.text).toBe('Latest before pagehide');
  expect(restored.composerStates['t-parser']?.attachments).toEqual([]);
  vi.mocked(readDraftJournal).mockResolvedValue({ inputs: { malformed: { attachments: [{ kind: 'file', mimeType: 'text/plain', assetId: 'unreachable-old-asset', data: payload }] } } });
  await ready('malformed-asset');
  expect(index?.has(payload)).toBe(false);
});

test('legacy migration keeps inline files and unknown assets recoverable when durable storage is unavailable', async () => {
  const first = await ready('legacy'); first.editComposerText('t-trace', 'Bootstrap');
  const key = Object.keys(localStorage).find(key => key.startsWith('boite.unsent'))!.split(':entry:')[0]!;
  first.detach();
  const updatedAt = Date.now() + 1000;
  const reference = { id: 'save', url: 'https://fixture.test', selector: '#save', text: 'Save', bounds: { x: 0, y: 0, width: 20, height: 20 } };
  const inline = { text: 'Legacy text', editing: 'message-to-edit', attachments: [{ kind: 'file', mimeType: 'text/plain', name: 'legacy.txt', data: 'bGVnYWN5' }], previewReferences: [reference], queued: [{ text: 'Queued legacy', attachments: [], previewReferences: [reference] }] };
  const unknown = { text: 'Keep unknown', attachments: [{ kind: 'file', mimeType: 'text/plain', name: 'missing.txt', assetId: 'unknown-asset' }], queued: [] };
  const legacy = { updatedAt, inputs: { 't-trace': inline, 't-parser': unknown }, drafts: { '"p-boite"': { draft: { projectId: 'p-boite', worktree: true }, input: { ...inline, text: 'Parked project' } } } };
  const oldBackup = JSON.stringify(legacy); localStorage.setItem(key, oldBackup);
  vi.mocked(readDraftJournal).mockRejectedValueOnce(new Error('IndexedDB denied'));
  const restored = await ready('legacy');
  expect(restored.error).toBe(strings.errors.draftStorage);
  expect(restored.composerStates['t-trace']).toMatchObject({ text: 'Legacy text', editing: 'message-to-edit', attachments: [{ data: 'bGVnYWN5' }], previewReferences: [reference], queued: [{ text: 'Queued legacy', previewReferences: [reference] }], paused: true });
  expect(restored.composerStates['t-parser']?.attachments[0]).toMatchObject({ pendingDraftAsset: 'unknown-asset' });
  restored.startDraft('p-boite'); expect(restored.draft?.worktree).toBe(true); expect(restored.composerStates.draft?.text).toBe('Parked project');
  restored.composerStates['t-parser']!.attachments = []; restored.editComposerText('t-parser', 'Removed unknown');
  expect(await restored.flushDrafts()).toBe(false);
  expect(localStorage.getItem(key)).toBe(oldBackup);
  vi.stubGlobal('indexedDB', {}); // The recorder below acknowledges the strict durable write.
  vi.mocked(readDraftJournal).mockResolvedValue({ ...legacy, inputs: { ...legacy.inputs, 't-parser': { ...unknown, attachments: [{ ...unknown.attachments[0], data: 'bm93IGF2YWlsYWJsZQ==' }] } } });
  const recovered = await ready('legacy');
  expect(recovered.composerStates['t-trace']?.attachments[0]?.data).toBe('bGVnYWN5');
  expect(recovered.composerStates['t-parser']).toMatchObject({ text: 'Removed unknown', attachments: [] });
  expect(await recovered.flushDrafts()).toBe(true);
  expect(localStorage.getItem(key)).toBeNull();
  vi.mocked(readDraftJournal).mockResolvedValue(null);
  expect((await ready('legacy', false, '/isolated-data-directory')).composerStates['t-trace']).toBeUndefined();
});

test('an incognito draft starts a hidden conversation that leaving erases, and the device keeps none of its words', async () => {
  const store = await ready('one');
  store.startDraft(null);
  expect(store.draftInDrafts).toBe(true);
  store.setDraftIncognito(true);
  store.editComposerText('draft', 'Unsent secret');
  // A draft taken to a project leaves the switch behind; back in the drafts it is chosen again.
  store.setDraftProject(store.projects.find(p => p.kind !== 'drafts')!.id);
  expect(store.draft?.incognito).toBeUndefined();
  store.setDraftProject(null);
  store.setDraftIncognito(true);
  expect(store.draft?.incognito).toBe(true);
  await store.flushDrafts();
  expect(Object.values(localStorage).some(value => value.includes('Unsent secret'))).toBe(false);
  expect(JSON.stringify(vi.mocked(writeDraftJournal).mock.calls)).not.toContain('Unsent secret');

  expect(await store.submit('Secret plan', store.defaultChoice()!)).toBe(true);
  const thread = store.openThread!;
  expect(thread.incognito).toBe(true);
  expect(thread.cwd).toContain('/incognito/');
  // Off every list: the sidebar groups and the device's saved text.
  expect(store.threadsOf(thread.projectId!).some(row => row.id === thread.id)).toBe(false);
  store.editComposerText(thread.id, 'Typed while incognito');
  await store.flushDrafts();
  expect(Object.values(localStorage).some(value => value.includes('Typed while incognito'))).toBe(false);
  expect((await ready('one')).composerStates[thread.id]).toBeUndefined();

  // Leaving is enough: the core erases it, with nothing to restore.
  store.startDraft(null);
  await vi.waitFor(() => expect(store.threads.some(row => row.id === thread.id)).toBe(false));
  expect(store.draft?.incognito).toBeUndefined();
  expect((await store.client!.call('threads.list', {})).some(row => row.id === thread.id)).toBe(false);
  expect(await store.client!.call('threads.deleted', {})).toEqual([]);
});

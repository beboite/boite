import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ATTACHMENTS_PER_TURN, ATTACHMENTS_TOTAL_MAX_BYTES, RpcErrorCode, type ComposerRecord, type RpcMethodName, type Thread } from '@boite/contracts';
import { RpcFailure } from './client';
import { FakeClient } from './fake-client';
import { FakeComposerState } from './fake-client/composer';
import { Store } from './store.svelte';
import { bytes } from './format';
import { fill, strings } from './strings';
import { takeFiles } from './composer-attachments';
import { checkpoint, undoStep } from './composer-history';
import { isLoading } from './draft-attachments';

// One transparent pixel.
const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

// jsdom has no IndexedDB: the durable journal is a recorder here, and the
// synchronous backup in localStorage is what a restarted Store reads back.
vi.mock('./draft-journal', () => ({ readDraftJournal: vi.fn(async () => null), writeDraftJournal: vi.fn(async () => {}) }));

const stores: Store[] = [];
const clients: FakeClient[] = [];

type Device = Awaited<ReturnType<typeof device>>;

/**
 * A device on `machineId` whose client records its calls. `hold` keeps the
 * answer of its first `composer.list` until released, as a slow link would.
 */
async function device(machineId: string, client: FakeClient, options: { hold?: Promise<void>; holdPushes?: Promise<void>; connect?: boolean } = {}) {
  clients.push(client);
  const original = client.call.bind(client);
  const subscribe = client.on.bind(client);
  const pushes: ((record: ComposerRecord) => void)[] = [];
  let held = options.hold;
  const calls = vi.spyOn(client, 'call').mockImplementation(async (method, params) => {
    if (method === 'composer.list' && held) {
      const gate = held;
      held = undefined;
      const snapshot = await original(method, params);
      await gate;
      return snapshot;
    }
    return original(method, params);
  });
  vi.spyOn(client, 'on').mockImplementation((event, handler) => {
    if (event === 'composer.updated') {
      const receive = handler as (record: ComposerRecord) => void;
      pushes.push(receive);
      return subscribe('composer.updated', record => {
        if (options.holdPushes) void options.holdPushes.then(() => receive(record));
        else receive(record);
      });
    }
    return subscribe(event, handler);
  });
  const store = new Store();
  store.machineId = machineId;
  store.attach(client);
  stores.push(store);
  if (options.connect !== false) await store.connect();
  /** Delivers a record as the core's push would, late or out of order. */
  const push = (record: ComposerRecord) => { for (const handler of pushes) handler(record); };
  return { store, client, calls, push, original };
}

function called(device: Device, method: RpcMethodName, where: (params: Record<string, unknown>) => boolean = () => true) {
  return device.calls.mock.calls.filter(([name, params]) => name === method && where(params as Record<string, unknown>));
}
const putsOf = (device: Device, id?: string) => called(device, 'composer.put', params => id === undefined || params.id === id);

async function userTexts(client: FakeClient, threadId: string) {
  const thread: Thread = await client.call('threads.get', { threadId });
  return thread.messages.filter(message => message.role === 'user')
    .flatMap(message => message.parts.flatMap(part => part.type === 'text' ? [part.text] : []));
}

/** What the core's conversation received. The fake's peers keep one thread copy each, and the core runs a queue in the one that last wrote it. */
async function delivered(devices: Device[], threadId: string) {
  return (await Promise.all(devices.map(side => userTexts(side.client, threadId)))).flat();
}

async function recordOf(client: FakeClient, section: ComposerRecord['section'], id: string) {
  return (await client.call('composer.list', {})).find(row => row.section === section && row.id === id);
}

/** What the composer does on Send while a turn may run: the prompt joins the queue and the box empties. */
function queue(store: Store, threadId: string, text: string) {
  store.queuePrompt(threadId, { text, attachments: [] });
  const state = store.composerStates[threadId]!;
  state.text = '';
}

/** Longer than the sync's pause between keystrokes, so a put that would go has gone. */
const quiet = () => new Promise(resolve => setTimeout(resolve, 900));

beforeEach(() => localStorage.clear());
afterEach(() => {
  for (const store of stores.splice(0)) { store.client?.close(); store.detach(); }
  for (const client of clients.splice(0)) client.close();
  vi.restoreAllMocks();
});

test('typing on one device reaches the other in place, in one put for a burst, and clearing it clears both', async () => {
  const desk = await device('desk', new FakeClient({ delayMs: 0 }));
  const phone = await device('phone', desk.client.composerPeer({ delayMs: 0, principal: 'session' }));
  for (const text of ['H', 'He', 'Hel', 'Hello', 'Hello phone']) desk.store.editComposerText('t-trace', text);
  await vi.waitFor(() => expect(phone.store.composerStates['t-trace']?.text).toBe('Hello phone'));
  expect(putsOf(desk, 't-trace')).toHaveLength(1);
  const box = phone.store.composerStates['t-trace']!;
  desk.store.editComposerText('t-trace', 'Hello phone, again');
  await vi.waitFor(() => expect(box.text).toBe('Hello phone, again'));
  // The record lands in the box already there: an open composer keeps its element and focus.
  expect(phone.store.composerStates['t-trace']).toBe(box);
  expect(putsOf(phone)).toHaveLength(0);
  phone.store.editComposerText('t-trace', '');
  await vi.waitFor(() => expect(desk.store.composerStates['t-trace']?.text ?? '').toBe(''));
  expect((await recordOf(desk.client, 'inputs', 't-trace'))?.value).toBeNull();
});

test('an attachment is uploaded once however often its box is saved, and fetched only when shown', async () => {
  const desk = await device('desk', new FakeClient({ delayMs: 0 }));
  const phone = await device('phone', desk.client.composerPeer({ delayMs: 0, principal: 'session' }));
  const file = { kind: 'file' as const, mimeType: 'text/plain', name: 'notes.txt', data: btoa('Bytes uploaded once') };
  desk.store.editComposerText('t-trace', 'See');
  desk.store.composerStates['t-trace']!.attachments.push({ ...file });
  for (const text of ['See the', 'See the notes', 'See the notes file']) {
    const before = putsOf(desk, 't-trace').length;
    desk.store.editComposerText('t-trace', text);
    await vi.waitFor(() => expect(putsOf(desk, 't-trace').length).toBe(before + 1));
  }
  expect(called(desk, 'composer.asset.put')).toHaveLength(1);
  expect(JSON.stringify(putsOf(desk, 't-trace'))).not.toContain(file.data);
  await vi.waitFor(() => expect(phone.store.composerStates['t-trace']).toMatchObject({ text: 'See the notes file', attachments: [{ name: 'notes.txt' }] }));
  await quiet();
  expect(called(phone, 'composer.asset.get')).toHaveLength(0);
  await phone.store.open('t-trace');
  await vi.waitFor(() => expect(phone.store.composerStates['t-trace']?.attachments[0]?.data).toBe(file.data));
  expect(called(phone, 'composer.asset.get')).toHaveLength(1);
  expect(called(phone, 'composer.asset.put')).toHaveLength(0);
  // Restarted, the phone that fetched the bytes still knows the core holds them.
  await quiet();
  stores.splice(stores.indexOf(phone.store), 1);
  phone.store.detach();
  const reloaded = await device('phone', desk.client.composerPeer({ delayMs: 0, principal: 'session' }));
  await vi.waitFor(() => expect(reloaded.store.composerStates['t-trace']?.attachments[0]?.data).toBe(file.data));
  reloaded.store.editComposerText('t-trace', 'See the notes file from the phone');
  await vi.waitFor(async () => expect((await recordOf(desk.client, 'inputs', 't-trace'))?.value?.input).toMatchObject({ text: 'See the notes file from the phone', attachments: [{ name: 'notes.txt' }] }));
  expect(called(reloaded, 'composer.asset.put')).toHaveLength(0);
  // Restarted, the desk still knows the core holds those bytes and sends them up no more.
  await quiet();
  stores.splice(stores.indexOf(desk.store), 1);
  desk.store.detach();
  const back = await device('desk', desk.client.composerPeer({ delayMs: 0, principal: 'session' }));
  await vi.waitFor(() => expect(back.store.composerStates['t-trace']?.attachments[0]?.data).toBe(file.data));
  back.store.editComposerText('t-trace', 'See the notes file again');
  await vi.waitFor(async () => expect((await recordOf(desk.client, 'inputs', 't-trace'))?.value?.input).toMatchObject({ text: 'See the notes file again', attachments: [{ name: 'notes.txt' }] }));
  expect(called(back, 'composer.asset.put')).toHaveLength(0);
});

test('a shared queue is delivered once by the core, never by either frontend, and Send now tells the core', async () => {
  const desk = await device('desk', new FakeClient({ delayMs: 0 }));
  const phone = await device('phone', desk.client.composerPeer({ delayMs: 0, principal: 'session' }));
  desk.store.editComposerText('t-trace', 'Run the benches');
  queue(desk.store, 't-trace', 'Run the benches');
  await vi.waitFor(async () => expect(await userTexts(desk.client, 't-trace')).toContain('Run the benches'));
  await vi.waitFor(() => {
    expect(desk.store.composerStates['t-trace']?.queued).toHaveLength(0);
    expect(phone.store.composerStates['t-trace']?.queued ?? []).toHaveLength(0);
  });
  // The queuing put goes after the box empties: no record holds the prompt twice.
  for (const [, params] of putsOf(desk, 't-trace')) {
    const value = (params as { value: ComposerRecord['value'] }).value;
    expect(value?.input.text === 'Run the benches' && value.input.queued.length > 0).toBe(false);
  }
  // A paused queue waits until Send now, which the core gets as a flag on the record.
  desk.store.composerStates['t-trace']!.paused = true;
  queue(desk.store, 't-trace', 'Then summarize');
  await vi.waitFor(() => expect(phone.store.composerStates['t-trace']?.queued).toMatchObject([{ text: 'Then summarize' }]));
  await phone.store.sendQueuedNow('t-trace');
  await vi.waitFor(async () => expect(await delivered([desk, phone], 't-trace')).toContain('Then summarize'));
  expect(putsOf(phone, 't-trace').some(([, params]) => (params as { sendNow?: true }).sendNow === true)).toBe(true);
  await quiet();
  const texts = await delivered([desk, phone], 't-trace');
  expect(texts.filter(text => text === 'Run the benches')).toHaveLength(1);
  expect(texts.filter(text => text === 'Then summarize')).toHaveLength(1);
  for (const side of [desk, phone]) expect(called(side, 'turns.start').length + called(side, 'turns.steer').length).toBe(0);
});

test('edits made on both sides while one was offline all survive: the core keeps its box, the other text moves to a draft', async () => {
  const desk = await device('desk', new FakeClient({ delayMs: 0 }));
  const phone = await device('phone', desk.client.composerPeer({ delayMs: 0, principal: 'session' }));
  desk.store.editComposerText('t-trace', 'Base');
  await vi.waitFor(() => expect(phone.store.composerStates['t-trace']?.text).toBe('Base'));
  phone.client.drop();
  await phone.client.settled();
  desk.store.editComposerText('t-trace', 'Desk words');
  desk.store.editComposerText('t-descriptors', 'Desk only');
  phone.store.editComposerText('t-trace', 'Phone words');
  phone.store.editComposerText('t-scheduler', 'Phone only');
  await vi.waitFor(async () => expect((await recordOf(desk.client, 'inputs', 't-descriptors'))?.value?.input.text).toBe('Desk only'));
  await phone.client.restore();
  await vi.waitFor(() => {
    for (const side of [desk, phone]) {
      expect(side.store.composerStates['t-trace']?.text).toBe('Desk words');
      expect(side.store.composerStates['t-descriptors']?.text).toBe('Desk only');
      expect(side.store.composerStates['t-scheduler']?.text).toBe('Phone only');
      expect(side.store.draftEntries.filter(entry => entry.text === 'Phone words')).toHaveLength(1);
    }
  });
  await quiet();
  for (const side of [desk, phone]) expect(side.store.draftEntries.filter(entry => entry.text === 'Phone words')).toHaveLength(1);
});

test('a picture still being read when its words move to a draft lands in that draft, beside its reference', async () => {
  const desk = await device('desk', new FakeClient({ delayMs: 0 }));
  const phone = await device('phone', desk.client.composerPeer({ delayMs: 0, principal: 'session' }));
  desk.store.editComposerText('t-trace', 'Base');
  await vi.waitFor(() => expect(phone.store.composerStates['t-trace']?.text).toBe('Base'));
  phone.client.drop();
  await phone.client.settled();
  desk.store.editComposerText('t-trace', 'Desk words');
  await vi.waitFor(async () => expect((await recordOf(desk.client, 'inputs', 't-trace'))?.value?.input.text).toBe('Desk words'));
  const read = FileReader.prototype.readAsDataURL;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(FileReader.prototype, 'readAsDataURL').mockImplementation(function (this: FileReader, blob: Blob) { void gate.then(() => read.call(this, blob)); });
  phone.store.editComposerText('t-trace', 'Phone words');
  const taking = takeFiles(phone.store, phone.store.composerStates['t-trace']!, [new File([Uint8Array.from(atob(PIXEL), c => c.charCodeAt(0))], 'pixel.png', { type: 'image/png' })], null, () => {});
  expect(phone.store.composerStates['t-trace']!.text).toBe('Phone words [Image 1] ');
  await phone.client.restore();
  await vi.waitFor(() => expect(phone.store.composerStates['t-trace']?.text).toBe('Desk words'));
  // Opened and typed in while the read goes on: that draft's own undo steps hold the placeholder.
  const aside = phone.store.draftEntries.find(entry => entry.text === 'Phone words [Image 1] ')!;
  phone.store.startDraft(undefined, { draftId: aside.id });
  await vi.waitFor(() => expect(phone.store.composerStates.draft?.text).toBe('Phone words [Image 1] '));
  const box = phone.store.composerStates.draft!;
  checkpoint(box);
  phone.store.editComposerText('draft', 'Phone words [Image 1] more');
  release();
  await taking;
  // The core's copy of the draft holds the picture its `[Image 1]` names, not a reference to nothing.
  await vi.waitFor(async () => {
    const record = (await desk.client.call('composer.list', {})).find(row => row.section === 'drafts' && row.value?.input.text === 'Phone words [Image 1] more');
    expect(record?.value?.input.attachments.map(file => file.kind)).toEqual(['image']);
  });
  const step = undoStep(box)!;
  expect(step.text).toBe('Phone words [Image 1] ');
  expect(step.attachments.map(file => [file.kind, isLoading(file)])).toEqual([['image', false]]);
});

test('a late list and an out-of-order push never take a newer record back', async () => {
  const desk = await device('desk', new FakeClient({ delayMs: 0 }));
  desk.store.editComposerText('t-trace', 'First');
  await vi.waitFor(async () => expect((await recordOf(desk.client, 'inputs', 't-trace'))?.value?.input.text).toBe('First'));
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const phone = await device('phone', desk.client.composerPeer({ delayMs: 0, principal: 'session' }), { hold, connect: false });
  const connecting = phone.store.connect();
  await vi.waitFor(() => expect(called(phone, 'composer.list')).toHaveLength(1));
  const first = (await recordOf(desk.client, 'inputs', 't-trace'))!;
  // Pushed while the list is still on its way, which answers with the record before it.
  desk.store.editComposerText('t-trace', 'Second');
  await vi.waitFor(async () => expect((await recordOf(desk.client, 'inputs', 't-trace'))?.revision).toBe(first.revision + 1));
  release();
  await connecting;
  await vi.waitFor(() => expect(phone.store.composerStates['t-trace']?.text).toBe('Second'));
  phone.push(first);
  await quiet();
  expect(phone.store.composerStates['t-trace']?.text).toBe('Second');
  expect((await recordOf(desk.client, 'inputs', 't-trace'))?.value?.input.text).toBe('Second');
});

test('switching machine A, then B, then A again keeps each machine\'s records and ignores the first visit\'s late list', async () => {
  const a = new FakeClient({ delayMs: 0 });
  const b = new FakeClient({ delayMs: 0 });
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const desk = await device('a', a, { hold, connect: false });
  const phone = await device('phone', a.composerPeer({ delayMs: 0, principal: 'session' }));
  clients.push(b);
  const bCalls = vi.spyOn(b, 'call');
  const connecting = desk.store.connect();
  await vi.waitFor(() => expect(called(desk, 'composer.list')).toHaveLength(1));
  phone.store.editComposerText('t-trace', 'Written on A');
  await vi.waitFor(async () => expect((await recordOf(a, 'inputs', 't-trace'))?.value?.input.text).toBe('Written on A'));
  desk.store.composerStates = {};
  desk.store.machineId = 'b';
  desk.store.attach(b);
  await desk.store.connect();
  desk.store.editComposerText('t-trace', 'Written on B');
  await vi.waitFor(async () => expect((await b.call('composer.list', {})).find(row => row.id === 't-trace')?.value?.input.text).toBe('Written on B'));
  desk.store.composerStates = {};
  desk.store.machineId = 'a';
  desk.store.attach(a);
  await desk.store.connect();
  await vi.waitFor(() => expect(desk.store.composerStates['t-trace']?.text).toBe('Written on A'));
  phone.store.editComposerText('t-trace', 'Newest on A');
  await vi.waitFor(() => expect(desk.store.composerStates['t-trace']?.text).toBe('Newest on A'));
  const revision = (await recordOf(a, 'inputs', 't-trace'))!.revision;
  // The first visit's list answers now, with what A held before anything was typed.
  release();
  await connecting;
  await quiet();
  expect(desk.store.composerStates['t-trace']?.text).toBe('Newest on A');
  expect((await recordOf(a, 'inputs', 't-trace'))?.revision).toBe(revision);
  expect(bCalls.mock.calls.some(([method, params]) => method === 'composer.put' && JSON.stringify(params).includes('on A'))).toBe(false);
  expect((await b.call('composer.list', {})).find(row => row.id === 't-trace')?.value?.input.text).toBe('Written on B');
});

test('a device back from a restart neither restores what another cleared nor sends a queue the core already ran', async () => {
  const desk = await device('desk', new FakeClient({ delayMs: 0 }));
  let phone = await device('phone', desk.client.composerPeer({ delayMs: 0, principal: 'session' }));
  const project = desk.store.projects.find(entry => entry.kind !== 'drafts')!;
  desk.store.editComposerText('t-trace', 'Remove me');
  desk.store.composerStates['t-descriptors'] = { text: '', attachments: [], queued: [], sending: false, paused: true };
  queue(desk.store, 't-descriptors', 'Queued once');
  desk.store.startDraft(project.id, { fresh: true });
  desk.store.editComposerText('draft', 'Draft to delete');
  await vi.waitFor(() => {
    expect(phone.store.composerStates['t-trace']?.text).toBe('Remove me');
    expect(phone.store.composerStates['t-descriptors']?.queued).toMatchObject([{ text: 'Queued once' }]);
    expect(phone.store.draftEntries.some(entry => entry.text === 'Draft to delete')).toBe(true);
  });
  const draftId = desk.store.draftEntries.find(entry => entry.text === 'Draft to delete')!.id;
  // The phone's own copy, which a restart reads before the core answers.
  const cached = Object.keys(localStorage).filter(key => key.includes('phone')).map(key => localStorage.getItem(key) ?? '').join('\n');
  for (const text of ['Remove me', 'Queued once', 'Draft to delete']) expect(cached).toContain(text);
  stores.splice(stores.indexOf(phone.store), 1);
  phone.store.detach();
  phone.client.close();
  desk.store.editComposerText('t-trace', '');
  desk.store.composerStates['t-descriptors']!.paused = false;
  desk.store.editComposerText('t-descriptors', '');
  desk.store.discardDraft(draftId);
  await vi.waitFor(async () => expect(await userTexts(desk.client, 't-descriptors')).toContain('Queued once'));
  await vi.waitFor(async () => {
    expect((await recordOf(desk.client, 'inputs', 't-trace'))?.value).toBeNull();
    expect((await recordOf(desk.client, 'drafts', draftId))?.value ?? null).toBeNull();
    expect((await recordOf(desk.client, 'inputs', 't-descriptors'))?.value?.input.queued ?? []).toHaveLength(0);
  });
  phone = await device('phone', desk.client.composerPeer({ delayMs: 0, principal: 'session' }));
  await vi.waitFor(() => expect(called(phone, 'composer.list')).toHaveLength(1));
  await quiet();
  for (const side of [desk, phone]) {
    expect(side.store.composerStates['t-trace']?.text ?? '').toBe('');
    expect(side.store.composerStates['t-descriptors']?.queued ?? []).toHaveLength(0);
    expect(side.store.draftEntries.some(entry => entry.text === 'Draft to delete')).toBe(false);
  }
  expect((await recordOf(desk.client, 'inputs', 't-trace'))?.value).toBeNull();
  expect((await recordOf(desk.client, 'drafts', draftId))?.value ?? null).toBeNull();
  expect((await userTexts(desk.client, 't-descriptors')).filter(text => text === 'Queued once')).toHaveLength(1);
  expect(called(phone, 'turns.start')).toHaveLength(0);
});

test.each([false, true])('an offline draft (incognito=%s) starts on the core and opens its conversation once', async incognito => {
  const desk = await device('desk', new FakeClient({ delayMs: 0 }));
  const project = desk.store.projects.find(entry => entry.kind !== 'drafts')!;
  desk.store.startDraft(incognito ? null : project.id, { fresh: true });
  if (incognito) desk.store.setDraftIncognito(true);
  const draftId = desk.store.draft!.id!;
  const before = new Set((await desk.client.call('threads.list', {})).map(thread => thread.id));
  desk.client.drop();
  await desk.client.settled();
  desk.store.queuePrompt('draft', { text: 'Start the migration', attachments: [] }, { choice: desk.store.defaultChoice() });
  desk.store.composerStates.draft!.text = '';
  expect(desk.store.draftEntries.find(entry => entry.text === 'Start the migration')?.queued).toBe('waiting');
  await desk.client.restore();
  let startedId = '';
  await vi.waitFor(async () => {
    const started = (await desk.client.call('threads.list', {})).filter(thread => !before.has(thread.id));
    expect(started).toHaveLength(1);
    startedId = started[0]!.id;
    expect(desk.store.openThread?.id).toBe(startedId);
    expect(await userTexts(desk.client, startedId)).toEqual(['Start the migration']);
  });
  await quiet();
  expect(called(desk, 'threads.create')).toHaveLength(0);
  expect(called(desk, 'turns.start')).toHaveLength(0);
  expect(desk.store.draftEntries.some(entry => entry.text === 'Start the migration')).toBe(false);
  expect((await desk.client.call('threads.list', {})).filter(thread => !before.has(thread.id))).toHaveLength(1);
  expect(await userTexts(desk.client, startedId)).toEqual(['Start the migration']);
  if (incognito) {
    expect(desk.store.openThread?.incognito).toBe(true);
    expect(JSON.stringify(localStorage)).not.toContain(draftId);
    expect(JSON.stringify(localStorage)).not.toContain(startedId);
  }
});

test('an incognito queue uses private core records and assets without a frontend runner', async () => {
  const desk = await device('desk', new FakeClient({ delayMs: 0 }));
  const phone = await device('phone', desk.client.composerPeer({ delayMs: 0, principal: 'session' }));
  const choice = desk.store.defaultChoice()!;
  const drafts = await desk.client.call('projects.drafts', {});
  const secret = await desk.client.call('threads.create', { projectId: drafts.id, providerId: choice.providerId, accountId: choice.accountId,
    permissionMode: choice.permissionMode, effort: choice.effort, speed: choice.speed ?? null, ...(choice.model ? { model: choice.model } : {}), incognito: true });
  await vi.waitFor(() => expect(desk.store.threads.some(thread => thread.id === secret.id && thread.incognito)).toBe(true));
  const file = { kind: 'file' as const, mimeType: 'text/plain', name: 'secret.txt', data: btoa('Never uploaded') };
  desk.store.composerStates[secret.id] = { text: '', attachments: [{ ...file }], queued: [], sending: false, paused: false };
  desk.store.editComposerText(secret.id, 'Secret words');
  await quiet();
  queue(desk.store, secret.id, 'Secret prompt');
  await vi.waitFor(() => expect(putsOf(desk, secret.id).length).toBeGreaterThan(0));
  await vi.waitFor(async () => expect(await userTexts(desk.client, secret.id)).toEqual(['Secret prompt']));
  await quiet();
  expect(called(desk, 'turns.start')).toHaveLength(0);
  expect(called(desk, 'composer.asset.put')).toMatchObject([['composer.asset.put', { incognito: true }]]);
  expect((await recordOf(desk.client, 'inputs', secret.id))?.value?.input.queued).toEqual([]);
  expect(await recordOf(phone.client, 'inputs', secret.id)).toBeUndefined();
  expect(JSON.stringify(localStorage)).not.toContain('private-');
  expect(JSON.stringify(localStorage)).not.toContain(secret.id);
  expect(phone.store.composerStates[secret.id]).toBeUndefined();
});

test('a synchronized public draft can switch to incognito and deliver without retaining its public record', async () => {
  const desk = await device('desk', new FakeClient({ delayMs: 0 }));
  desk.store.startDraft(null, { fresh: true });
  desk.store.editComposerText('draft', 'Public draft');
  const publicId = desk.store.draft!.id!;
  await vi.waitFor(async () => expect((await recordOf(desk.client, 'drafts', publicId))?.value?.input.text).toBe('Public draft'));
  desk.store.setDraftIncognito(true);
  desk.store.editComposerText('draft', 'Private continuation');
  desk.store.queuePrompt('draft', { text: 'Private continuation', attachments: [] }, { choice: desk.store.defaultChoice() });
  desk.store.composerStates.draft!.text = '';
  await vi.waitFor(() => expect(desk.store.openThread?.incognito).toBe(true));
  const threadId = desk.store.openThread!.id;
  await vi.waitFor(async () => expect(await userTexts(desk.client, threadId)).toEqual(['Private continuation']));
  await vi.waitFor(async () => expect((await recordOf(desk.client, 'drafts', publicId))?.value ?? null).toBeNull());
  expect(JSON.stringify(localStorage)).not.toContain('Private continuation');
});

test.each(['toggle', 'project'])('a private draft becomes durable through %s under a new composer identity', async via => {
  const desk = await device('desk', new FakeClient({ delayMs: 0 }));
  const phone = await device('phone', desk.client.composerPeer({ delayMs: 0, principal: 'session' }));
  desk.store.startDraft(null, { fresh: true });
  desk.store.setDraftIncognito(true);
  desk.store.editComposerText('draft', 'Private before changing mode');
  const privateId = desk.store.draft!.id!;
  // A reconnect publishes the private box before any queued start exists.
  desk.client.drop();
  await desk.client.restore();
  await vi.waitFor(async () => expect((await recordOf(desk.client, 'drafts', privateId))?.value?.draft?.incognito).toBe(true));
  expect(await recordOf(phone.client, 'drafts', privateId)).toBeUndefined();
  if (via === 'toggle') desk.store.setDraftIncognito(false);
  else desk.store.setDraftProject(desk.store.projects.find(entry => entry.kind !== 'drafts')!.id);
  const publicId = desk.store.draft!.id!;
  expect(publicId).not.toBe(privateId);
  desk.store.editComposerText('draft', 'Public after changing mode');
  await vi.waitFor(async () => expect((await recordOf(phone.client, 'drafts', publicId))?.value?.input.text).toBe('Public after changing mode'));
  await vi.waitFor(async () => expect((await recordOf(desk.client, 'drafts', privateId))?.value ?? null).toBeNull());
  expect((await recordOf(phone.client, 'drafts', publicId))?.value?.draft?.incognito).toBeUndefined();
  expect(JSON.stringify(localStorage)).not.toContain(privateId);
});

test('a never-submitted offline draft can change privacy without submitting its queue twice', async () => {
  const desk = await device('desk', new FakeClient({ delayMs: 0 }));
  desk.store.startDraft(null, { fresh: true });
  const publicId = desk.store.draft!.id!;
  desk.client.drop();
  await desk.client.settled();
  desk.store.queuePrompt('draft', { text: 'Change privacy before admission', attachments: [] }, { choice: desk.store.defaultChoice() });
  desk.store.setDraftIncognito(true);
  expect(desk.store.draft?.incognito).toBe(true);
  expect(desk.store.draft?.id).not.toBe(publicId);
  await desk.client.restore();
  await vi.waitFor(() => expect(desk.store.openThread?.incognito).toBe(true));
  expect(await userTexts(desk.client, desk.store.openThread!.id)).toEqual(['Change privacy before admission']);
  expect((await desk.client.call('threads.list', {})).filter(row => row.title === 'Change privacy before admission')).toHaveLength(1);
});

test('a draft whose start is already admitted refuses privacy changes with a visible reason', async () => {
  const desk = await device('desk', new FakeClient({ delayMs: 0 }));
  const project = await desk.client.call('projects.drafts', {});
  desk.store.startDraft(null, { fresh: true });
  desk.store.setDraftIncognito(true);
  const privateId = desk.store.draft!.id!;
  desk.client.drop();
  desk.store.queuePrompt('draft', { text: 'Already admitted', attachments: [], request: {
    id: 'admitted-start', choice: desk.store.defaultChoice(), queuedAt: Date.now(), start: { projectId: project.id, worktree: false, incognito: true },
  } });
  desk.store.setDraftIncognito(false);
  expect(desk.store.draft).toMatchObject({ id: privateId, incognito: true });
  expect(desk.store.error).toBe(strings.drafts.privacyQueued);
  desk.store.error = null;
  desk.store.setDraftProject(desk.store.projects.find(entry => entry.kind !== 'drafts')!.id);
  expect(desk.store.draft).toMatchObject({ id: privateId, incognito: true });
  expect(desk.store.error).toBe(strings.drafts.privacyQueued);
});

test('a restart leaves running a queue the core holds, though the journal brings every queue back paused', async () => {
  const desk = await device('desk', new FakeClient({ delayMs: 0 }));
  let phone = await device('phone', desk.client.composerPeer({ delayMs: 0, principal: 'session' }));
  // This conversation waits on a request: the core holds its queue without running it yet.
  queue(desk.store, 't-scheduler', 'After the answer');
  await vi.waitFor(() => expect(phone.store.composerStates['t-scheduler']?.queued).toMatchObject([{ text: 'After the answer' }]));
  stores.splice(stores.indexOf(phone.store), 1);
  phone.store.detach();
  phone.client.close();
  phone = await device('phone', desk.client.composerPeer({ delayMs: 0, principal: 'session' }));
  await vi.waitFor(() => expect(called(phone, 'composer.list')).toHaveLength(1));
  await quiet();
  // The origin the core stamped comes back with the entry, so the turn it starts still names it.
  expect(phone.store.composerStates['t-scheduler']).toMatchObject({ paused: false, queued: [{ text: 'After the answer', sentFrom: null }] });
  expect(putsOf(phone, 't-scheduler')).toHaveLength(0);
  expect((await recordOf(desk.client, 'inputs', 't-scheduler'))?.value?.input).toMatchObject({ paused: false, queued: [{ text: 'After the answer' }] });
  // A prompt queued offline never reached the core: after another restart the queue waits paused, as before.
  phone.client.drop();
  await phone.client.settled();
  queue(phone.store, 't-scheduler', 'Queued offline');
  stores.splice(stores.indexOf(phone.store), 1);
  phone.store.detach();
  phone.client.close();
  phone = await device('phone', desk.client.composerPeer({ delayMs: 0, principal: 'session' }));
  await vi.waitFor(() => expect(called(phone, 'composer.list')).toHaveLength(1));
  await quiet();
  expect(phone.store.composerStates['t-scheduler']).toMatchObject({ paused: true, queued: [{ text: 'After the answer' }, { text: 'Queued offline' }] });
  expect(called(phone, 'composer.put', params => params.id === 't-scheduler' && (params.value as ComposerRecord['value'])?.input.paused === false)).toHaveLength(0);
});

test('a restarted device keeps its draft\'s model and takes the record\'s only when its journal predates saved models', async () => {
  let desk = await device('desk', new FakeClient({ delayMs: 0 }));
  const project = desk.store.projects.find(entry => entry.kind !== 'drafts')!;
  desk.store.startDraft(project.id, { fresh: true });
  const choice = { ...desk.store.defaultChoice()!, model: 'echo-2' };
  desk.store.draftChoice = choice;
  desk.store.editComposerText('draft', 'Keep my model');
  const id = desk.store.draft!.id!;
  await vi.waitFor(async () => expect((await recordOf(desk.client, 'drafts', id))?.value?.choice).toEqual(choice));
  await quiet();
  const restart = async (journal: (entry: { value: Record<string, unknown> }) => void, options: { synced?: boolean } = {}) => {
    stores.splice(stores.indexOf(desk.store), 1);
    desk.store.detach();
    const peer = desk.client.composerPeer({ delayMs: 0, principal: 'session' });
    desk.client.close();
    const key = Object.keys(localStorage).find(name => name.includes('desk') && name.endsWith(`:entry:${JSON.stringify(['drafts', id])}`))!;
    const entry = JSON.parse(localStorage.getItem(key)!);
    journal(entry);
    localStorage.setItem(key, JSON.stringify(entry));
    // A client older than the sync left no baseline either.
    if (options.synced === false) for (const name of Object.keys(localStorage)) if (name.includes('desk') && name.endsWith(':composer')) localStorage.removeItem(name);
    desk = await device('desk', peer);
    await vi.waitFor(() => expect(called(desk, 'composer.list')).toHaveLength(1));
    await quiet();
  };
  await restart(entry => expect(entry.value.choice).toEqual(choice));
  desk.store.startDraft(project.id, { draftId: id });
  expect(desk.store.draftChoice).toEqual(choice);
  expect(putsOf(desk, id)).toHaveLength(0);
  // An entry written before drafts kept their model reads as no choice: the record's stands.
  await restart(entry => { delete entry.value.choice; });
  desk.store.startDraft(project.id, { draftId: id });
  expect(desk.store.draftChoice).toEqual(choice);
  expect(called(desk, 'composer.put', params => params.id === id && (params.value as ComposerRecord['value'])?.choice === null)).toHaveLength(0);
  expect((await recordOf(desk.client, 'drafts', id))?.value?.choice).toEqual(choice);
  await restart(entry => { delete entry.value.choice; }, { synced: false });
  desk.store.startDraft(project.id, { draftId: id });
  expect(desk.store.draftChoice).toEqual(choice);
  expect(called(desk, 'composer.put', params => params.id === id && (params.value as ComposerRecord['value'])?.choice === null)).toHaveLength(0);
  expect((await recordOf(desk.client, 'drafts', id))?.value?.choice).toEqual(choice);
  // A default chosen on purpose and saved as such is this device's change, not a gap to fill.
  await restart(entry => { entry.value.choice = null; });
  desk.store.startDraft(project.id, { draftId: id });
  expect(desk.store.draftChoice).toBeNull();
  await vi.waitFor(async () => expect((await recordOf(desk.client, 'drafts', id))?.value).toMatchObject({ input: { text: 'Keep my model' }, choice: null }));
});

test('a put the core keeps failing is tried again after a pause, not on every tick, and goes through once the core recovers', async () => {
  const desk = await device('desk', new FakeClient({ delayMs: 0 }));
  let full = true;
  desk.calls.mockImplementation(async (method, params) => {
    if (method === 'composer.put' && full) throw new RpcFailure({ code: RpcErrorCode.Internal, message: 'disk full' });
    return desk.original(method, params);
  });
  desk.store.editComposerText('t-trace', 'Stored once the disk has room');
  await new Promise(resolve => setTimeout(resolve, 2000));
  expect(putsOf(desk, 't-trace')).toHaveLength(1);
  full = false;
  await vi.waitFor(async () => expect((await recordOf(desk.client, 'inputs', 't-trace'))?.value?.input.text).toBe('Stored once the disk has room'), { timeout: 8000 });
  expect(putsOf(desk, 't-trace')).toHaveLength(2);
}, 15_000);

test('a box the core refuses as over its attachment limit says so and keeps every word and picture on the device', async () => {
  const desk = await device('desk', new FakeClient({ delayMs: 0 }));
  const text = 'a prompt that describes every problem at once. '.repeat(1300);
  desk.store.editComposerText('t-trace', text);
  // What cancelling a queued draft leaves: its queue merged into one box, past what one message may carry.
  desk.store.composerStates['t-trace']!.attachments = Array.from({ length: ATTACHMENTS_PER_TURN + 1 }, (_, index) =>
    ({ kind: 'image' as const, mimeType: 'image/png', name: `shot-${index}.png`, data: btoa(`picture ${index}`) }));
  desk.store.editComposerText('t-trace', text + 'and the end');
  await vi.waitFor(() => expect(desk.store.error).toBe(fill(strings.errors.draftOverLimit, { count: String(ATTACHMENTS_PER_TURN), max: bytes(ATTACHMENTS_TOTAL_MAX_BYTES) })));
  const box = desk.store.composerStates['t-trace']!;
  expect(box.text).toBe(text + 'and the end');
  expect(box.attachments).toHaveLength(ATTACHMENTS_PER_TURN + 1);
  expect((await recordOf(desk.client, 'inputs', 't-trace'))?.value ?? null).toBeNull();
  // Once it fits again, it reaches the core and the warning it raised goes.
  box.attachments = box.attachments.slice(0, ATTACHMENTS_PER_TURN);
  desk.store.editComposerText('t-trace', text + 'and the end, trimmed');
  await vi.waitFor(async () => expect((await recordOf(desk.client, 'inputs', 't-trace'))?.value?.input.attachments).toHaveLength(ATTACHMENTS_PER_TURN));
  expect(desk.store.error).toBeNull();
});

test('a box over the limit, then emptied back to what the core holds, drops its warning with no put to make', async () => {
  const desk = await device('desk', new FakeClient({ delayMs: 0 }));
  desk.store.editComposerText('t-trace', 'one prompt, too many pictures');
  desk.store.composerStates['t-trace']!.attachments = Array.from({ length: ATTACHMENTS_PER_TURN + 1 }, (_, index) =>
    ({ kind: 'image' as const, mimeType: 'image/png', name: `shot-${index}.png`, data: btoa(`picture ${index}`) }));
  desk.store.editComposerText('t-trace', 'one prompt, too many pictures.');
  await vi.waitFor(() => expect(desk.store.error).toBe(fill(strings.errors.draftOverLimit, { count: String(ATTACHMENTS_PER_TURN), max: bytes(ATTACHMENTS_TOTAL_MAX_BYTES) })));
  const puts = putsOf(desk, 't-trace').length;
  // Cleared: the core never held this box, so the empty one matches it and nothing goes up.
  desk.store.composerStates['t-trace']!.attachments = [];
  desk.store.editComposerText('t-trace', '');
  await vi.waitFor(() => expect(desk.store.error).toBeNull());
  expect(putsOf(desk, 't-trace')).toHaveLength(puts);
});

test('a box trimmed while the core was refusing it as over the limit goes up without another edit', async () => {
  const desk = await device('desk', new FakeClient({ delayMs: 0 }));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let held = 0;
  desk.calls.mockImplementation(async (method, params) => {
    if (method === 'composer.put' && held++ === 0) await gate;
    return desk.original(method, params);
  });
  desk.store.editComposerText('t-trace', 'one prompt, too many pictures');
  desk.store.composerStates['t-trace']!.attachments = Array.from({ length: ATTACHMENTS_PER_TURN + 1 }, (_, index) =>
    ({ kind: 'image' as const, mimeType: 'image/png', name: `shot-${index}.png`, data: btoa(`picture ${index}`) }));
  desk.store.editComposerText('t-trace', 'one prompt, too many pictures.');
  await vi.waitFor(() => expect(held).toBe(1));
  // The user takes a picture out while that put is still on its way: the edit's own flush finds the key busy.
  const box = desk.store.composerStates['t-trace']!;
  box.attachments = box.attachments.slice(0, ATTACHMENTS_PER_TURN);
  desk.store.editComposerText('t-trace', 'one prompt, the right number of pictures.');
  await new Promise(resolve => setTimeout(resolve, 1200));
  release();
  await vi.waitFor(async () => expect((await recordOf(desk.client, 'inputs', 't-trace'))?.value?.input.attachments).toHaveLength(ATTACHMENTS_PER_TURN), { timeout: 4000 });
});

test('the open draft follows the worktree switch and model another device chose for it', async () => {
  const desk = await device('desk', new FakeClient({ delayMs: 0 }));
  const phone = await device('phone', desk.client.composerPeer({ delayMs: 0, principal: 'session' }));
  const project = desk.store.projects.find(entry => entry.kind !== 'drafts')!;
  desk.store.startDraft(project.id, { fresh: true });
  desk.store.draftChoice = desk.store.defaultChoice();
  desk.store.editComposerText('draft', 'Draft on both');
  await vi.waitFor(() => expect(phone.store.draftEntries.some(entry => entry.text === 'Draft on both')).toBe(true));
  const id = phone.store.draftEntries.find(entry => entry.text === 'Draft on both')!.id;
  phone.store.startDraft(project.id, { draftId: id });
  await vi.waitFor(() => expect(phone.store.composerStates.draft?.text).toBe('Draft on both'));
  const choice = { ...desk.store.defaultChoice()!, model: 'echo-2' };
  desk.store.setDraftWorktree(true);
  desk.store.draftChoice = choice;
  await vi.waitFor(() => {
    expect(phone.store.draft).toMatchObject({ id, worktree: true });
    expect(phone.store.draftChoice).toMatchObject({ model: 'echo-2' });
  });
  await quiet();
  expect((await recordOf(desk.client, 'drafts', id))?.value).toMatchObject({ draft: { worktree: true }, choice: { model: 'echo-2' } });
  // The phone types offline while the desk changes only the switch and the model: both changes stay.
  phone.client.drop();
  await phone.client.settled();
  phone.store.editComposerText('draft', 'Draft on both, from the phone');
  desk.store.setDraftWorktree(false);
  desk.store.draftChoice = { ...choice, model: 'echo-3' };
  await vi.waitFor(async () => expect((await recordOf(desk.client, 'drafts', id))?.value).toMatchObject({ draft: { worktree: false }, choice: { model: 'echo-3' } }));
  await phone.client.restore();
  await vi.waitFor(async () => {
    expect((await recordOf(desk.client, 'drafts', id))?.value).toMatchObject({ input: { text: 'Draft on both, from the phone' }, draft: { worktree: false }, choice: { model: 'echo-3' } });
    for (const side of [desk, phone]) {
      expect(side.store.composerStates.draft?.text).toBe('Draft on both, from the phone');
      expect(side.store.draft).toMatchObject({ id, worktree: false });
      expect(side.store.draftChoice).toMatchObject({ model: 'echo-3' });
    }
  });
});

test('a prompt queued through repeated conflicting writes stays queued and reaches the core later', async () => {
  const desk = await device('desk', new FakeClient({ delayMs: 0 }));
  const phone = await device('phone', desk.client.composerPeer({ delayMs: 0, principal: 'session' }));
  desk.store.composerStates['t-trace'] = { text: '', attachments: [], queued: [], sending: false, paused: true };
  queue(desk.store, 't-trace', 'Already there');
  await vi.waitFor(() => expect(phone.store.composerStates['t-trace']?.queued).toMatchObject([{ text: 'Already there' }]));
  // Each of the phone's next writes loses the race to another device clearing the queue.
  let conflicts = 0;
  phone.calls.mockImplementation(async (method, params) => {
    const put = params as { id?: string };
    if (method === 'composer.put' && put.id === 't-trace' && conflicts < 3) {
      conflicts++;
      const current = (await phone.original('composer.list', {})).find(row => row.id === 't-trace')!;
      const value = JSON.parse(JSON.stringify(current.value)) as NonNullable<ComposerRecord['value']>;
      value.input.queued = [];
      await phone.original('composer.put', { section: 'inputs', id: 't-trace', expectedRevision: current.revision, value });
    }
    return phone.original(method, params);
  });
  queue(phone.store, 't-trace', 'Do not lose this');
  await vi.waitFor(() => expect(conflicts).toBe(3));
  await quiet();
  expect(phone.store.composerStates['t-trace']?.queued.map(entry => entry.text)).toEqual(['Do not lose this']);
  await vi.waitFor(async () => expect((await recordOf(desk.client, 'inputs', 't-trace'))?.value?.input.queued.map(entry => entry.text)).toEqual(['Do not lose this']), { timeout: 8000 });
  await vi.waitFor(() => expect(desk.store.composerStates['t-trace']?.queued.map(entry => entry.text)).toEqual(['Do not lose this']));
}, 15_000);

test('an attachment a restarted core dropped goes up again from the device that holds its bytes', async () => {
  const core = new FakeComposerState();
  const desk = await device('desk', new FakeClient({ delayMs: 0, composerState: core }));
  const file = { kind: 'file' as const, mimeType: 'text/plain', name: 'kept.txt', data: btoa('Bytes the core lost') };
  desk.store.composerStates['t-trace'] = { text: '', attachments: [{ ...file }], queued: [], sending: false, paused: false };
  desk.store.editComposerText('t-trace', 'With a file');
  await vi.waitFor(async () => expect((await recordOf(desk.client, 'inputs', 't-trace'))?.value?.input.attachments).toHaveLength(1));
  desk.client.drop();
  await desk.client.settled();
  // What its restart keeps: records only, no asset any more.
  core.assets.clear();
  desk.store.editComposerText('t-trace', 'With a file, still');
  await desk.client.restore();
  await vi.waitFor(async () => expect((await recordOf(desk.client, 'inputs', 't-trace'))?.value?.input).toMatchObject({ text: 'With a file, still', attachments: [{ name: 'kept.txt' }] }));
  expect(called(desk, 'composer.asset.put')).toHaveLength(2);
  expect([...core.assets.values()]).toEqual([file]);
});

test('a list that fails on a live link is asked again later, and what was typed meanwhile reaches the core', async () => {
  const desk = await device('desk', new FakeClient({ delayMs: 0 }), { connect: false });
  let lists = 0;
  desk.calls.mockImplementation(async (method, params) => {
    if (method === 'composer.list' && lists++ === 0) throw new RpcFailure({ code: RpcErrorCode.Internal, message: 'list timed out' });
    return desk.original(method, params);
  });
  await desk.store.connect();
  desk.store.editComposerText('t-trace', 'Typed after a failed list');
  await vi.waitFor(async () => expect((await recordOf(desk.client, 'inputs', 't-trace'))?.value?.input.text).toBe('Typed after a failed list'), { timeout: 8000 });
}, 15_000);

test('a resync on the same link while a put is out leaves the record free for the next edit', async () => {
  const desk = await device('desk', new FakeClient({ delayMs: 0 }));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let held = false;
  desk.calls.mockImplementation(async (method, params) => {
    const answer = desk.original(method, params);
    if (method === 'composer.put' && !held) { held = true; await gate; }
    return answer;
  });
  desk.store.editComposerText('t-trace', 'First');
  await vi.waitFor(() => expect(held).toBe(true));
  // The connection's own resync after a reconnect to the same, still ready client.
  const lists = called(desk, 'composer.list').length;
  await desk.store.connect();
  await vi.waitFor(() => expect(called(desk, 'composer.list').length).toBeGreaterThan(lists));
  release();
  await quiet();
  desk.store.editComposerText('t-trace', 'Second');
  await vi.waitFor(async () => expect((await recordOf(desk.client, 'inputs', 't-trace'))?.value?.input.text).toBe('Second'));
});

test('a permanently deleted thread clears its offline input and journal without retrying', async () => {
  const core = new FakeComposerState();
  const desk = await device('desk', new FakeClient({ delayMs: 0, composerState: core }));
  desk.store.editComposerText('t-trace', 'Synced before deletion');
  await vi.waitFor(async () => expect((await recordOf(desk.client, 'inputs', 't-trace'))?.value?.input.text).toBe('Synced before deletion'));
  desk.client.drop();
  await desk.client.settled();
  desk.store.editComposerText('t-trace', 'Written offline');
  desk.store.composerStates['t-trace']!.paused = true;
  queue(desk.store, 't-trace', 'Queued offline');
  desk.store.editComposerText('t-trace', 'Written offline after queuing');
  // A different device purged the thread while this client missed its event.
  core.records.clear();
  let refused = 0;
  desk.calls.mockImplementation(async (method, params) => {
    if (method === 'composer.put' && (params as { id?: string }).id === 't-trace') {
      refused++;
      throw new RpcFailure({ code: RpcErrorCode.NotFound, message: 'composer.id: expected an existing thread', data: { reason: 'thread-deleted', threadId: 't-trace', field: 'composer.id' } });
    }
    return desk.original(method, params);
  });
  await desk.client.restore();
  await vi.waitFor(() => expect(refused).toBe(1));
  await vi.waitFor(() => {
    expect(desk.store.composerStates['t-trace']?.text ?? '').toBe('');
    expect(desk.store.composerStates['t-trace']?.queued ?? []).toEqual([]);
  });
  await new Promise(resolve => setTimeout(resolve, 5300));
  expect(refused).toBe(1);
  desk.store.detach();
  const reloaded = await device('desk', new FakeClient({ delayMs: 0, composerState: core }));
  await quiet();
  expect(reloaded.store.composerStates['t-trace']?.text ?? '').toBe('');
  expect(reloaded.store.composerStates['t-trace']?.queued ?? []).toEqual([]);
  expect(putsOf(reloaded, 't-trace')).toHaveLength(0);
  expect(await recordOf(reloaded.client, 'inputs', 't-trace')).toBeUndefined();
});

test('a queued prompt without an id, as a refused send leaves it, survives another device changing the same queue', async () => {
  const desk = await device('desk', new FakeClient({ delayMs: 0 }));
  const phone = await device('phone', desk.client.composerPeer({ delayMs: 0, principal: 'session' }));
  desk.store.composerStates['t-trace'] = { text: '', attachments: [], queued: [], sending: false, paused: true };
  queue(desk.store, 't-trace', 'Already there');
  await vi.waitFor(() => expect(phone.store.composerStates['t-trace']?.queued).toMatchObject([{ text: 'Already there' }]));
  phone.client.drop();
  await phone.client.settled();
  phone.store.composerStates['t-trace']!.queued.unshift({ text: 'Refused while offline', attachments: [] });
  queue(desk.store, 't-trace', 'Desk added');
  await vi.waitFor(async () => expect((await recordOf(desk.client, 'inputs', 't-trace'))?.value?.input.queued).toHaveLength(2));
  await phone.client.restore();
  const texts = ['Already there', 'Desk added', 'Refused while offline'];
  await vi.waitFor(async () => {
    expect((await recordOf(desk.client, 'inputs', 't-trace'))?.value?.input.queued.map(entry => entry.text)).toEqual(texts);
    for (const side of [desk, phone]) expect(side.store.composerStates['t-trace']?.queued.map(entry => entry.text)).toEqual(texts);
  });
});

test.each(['composer.asset.put', 'composer.put'] as const)('an id-less prompt restored during %s survives and reaches the core with an identity', async heldMethod => {
  const desk = await device('desk', new FakeClient({ delayMs: 0 }));
  const file = { kind: 'file' as const, mimeType: 'text/plain', name: 'notes.txt', data: btoa('Upload in flight') };
  desk.store.composerStates['t-trace'] = { text: '', attachments: heldMethod === 'composer.asset.put' ? [file] : [], queued: [], sending: false, paused: true };
  let release!: () => void, started!: () => void;
  let hold: Promise<void> | undefined = new Promise(resolve => { release = resolve; });
  const inFlight = new Promise<void>(resolve => { started = resolve; });
  desk.calls.mockImplementation(async (method, params) => {
    const answer = await desk.original(method, params);
    if (method === heldMethod && hold) { const gate = hold; hold = undefined; started(); await gate; }
    return answer;
  });
  queue(desk.store, 't-trace', 'Already queued');
  await inFlight;
  // A cached queue written before ids were required becomes local while the request is pending.
  desk.store.composerStates['t-trace']!.queued.push({ text: 'Recovered from an old journal', attachments: [] });
  release();
  const texts = ['Already queued', 'Recovered from an old journal'];
  await vi.waitFor(async () => {
    const remote = (await recordOf(desk.client, 'inputs', 't-trace'))?.value?.input.queued;
    const local = desk.store.composerStates['t-trace']?.queued;
    expect(remote?.map(entry => entry.text)).toEqual(texts);
    expect(local?.map(entry => entry.text)).toEqual(texts);
    expect(remote?.every(entry => !!entry.id)).toBe(true);
    expect(local?.map(entry => entry.id)).toEqual(remote?.map(entry => entry.id));
    expect(new Set(remote?.map(entry => entry.id)).size).toBe(texts.length);
  });
});

test('a send the core refuses as early joins the queue, though a put of that queue is still on its way', async () => {
  const desk = await device('desk', new FakeClient({ delayMs: 0 }));
  desk.store.composerStates['t-trace'] = { text: '', attachments: [], queued: [], sending: false, paused: true };
  let release!: () => void, putting!: () => void;
  let hold: Promise<void> | undefined = new Promise(resolve => { release = resolve; });
  const inFlight = new Promise<void>(resolve => { putting = resolve; });
  desk.calls.mockImplementation(async (method, params) => {
    // The core has just opened a turn this device has not heard of.
    if (method === 'turns.start') throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'this thread already has an in-flight turn',
      data: { threadId: 't-trace', reason: 'turn-in-flight', thread: { ...desk.store.threads.find(row => row.id === 't-trace')!, status: 'running' } } });
    const answer = await desk.original(method, params);
    if (method === 'composer.put' && hold) { const gate = hold; hold = undefined; putting(); await gate; }
    return answer;
  });
  queue(desk.store, 't-trace', 'Already queued');
  await inFlight;
  expect(await desk.store.send('Refused as early', 't-trace')).toBe(true);
  release();
  // The put's answer reads as a change of the core's (it stamps each entry): the held prompt follows the core's queue, as a new one of this device's does.
  const texts = ['Already queued', 'Refused as early'];
  await vi.waitFor(async () => {
    expect(desk.store.composerStates['t-trace']?.queued.map(entry => entry.text)).toEqual(texts);
    expect((await recordOf(desk.client, 'inputs', 't-trace'))?.value?.input.queued.map(entry => entry.text)).toEqual(texts);
  });
});

test('words and file names that read like a local file id still reach the core, in the box and in the queue', async () => {
  const desk = await device('desk', new FakeClient({ delayMs: 0 }));
  const file = { kind: 'file' as const, mimeType: 'text/plain', name: '"local:notes".txt', data: btoa('Named oddly') };
  desk.store.composerStates['t-trace'] = { text: '', attachments: [], queued: [], sending: false, paused: true };
  queue(desk.store, 't-trace', 'Queued "local:cache" note');
  desk.store.composerStates['t-trace']!.attachments.push({ ...file });
  desk.store.editComposerText('t-trace', 'Box "local:cache" note');
  await vi.waitFor(async () => expect((await recordOf(desk.client, 'inputs', 't-trace'))?.value?.input).toMatchObject({
    text: 'Box "local:cache" note', attachments: [{ name: file.name }], queued: [{ text: 'Queued "local:cache" note' }] }));
});

test('a /goal2 queued offline runs as a reviewed goal after a restart', async () => {
  const desk = await device('desk', new FakeClient({ delayMs: 0 }));
  let phone = await device('phone', desk.client.composerPeer({ delayMs: 0, principal: 'session' }));
  phone.client.drop();
  await phone.client.settled();
  queue(phone.store, 't-trace', '/goal2 Ship the release');
  stores.splice(stores.indexOf(phone.store), 1);
  phone.store.detach();
  phone.client.close();
  phone = await device('phone', desk.client.composerPeer({ delayMs: 0, principal: 'session' }));
  await vi.waitFor(() => expect(phone.store.composerStates['t-trace']?.queued).toMatchObject([{ text: '/goal2 Ship the release' }]));
  await phone.store.sendQueuedNow('t-trace');
  await vi.waitFor(async () => expect((await phone.client.call('threads.get', { threadId: 't-trace' })).activity?.goal)
    .toMatchObject({ objective: 'Ship the release', review: expect.anything() }));
  expect(await delivered([desk, phone], 't-trace')).not.toContain('/goal2 Ship the release');
});


test('an old core refuses queue admission before the UI clears the input', async () => {
  const desk = await device('old-core', new FakeClient({ delayMs: 0, missing: ['composer.list'] }));
  desk.store.editComposerText('t-trace', 'Keep these words');
  expect(desk.store.queuePrompt('t-trace', { text: 'Keep these words', attachments: [] })).toBe(false);
  expect(desk.store.composerStates['t-trace']).toMatchObject({ text: 'Keep these words', queued: [] });
  expect(desk.store.error).toMatch(/update/i);
  expect(called(desk, 'turns.start')).toHaveLength(0);
});


test.each(['flag', 'lineage'] as const)('private transfer before thread.created never writes metadata or journal content (%s)', async source => {
  const desk = await device('private-order', new FakeClient({ delayMs: 0 }));
  const writes = vi.spyOn(Storage.prototype, 'setItem');
  const id = 'private-before-thread-created';
  const value = { input: { text: 'Private transferred box', attachments: [{ kind: 'file' as const, mimeType: 'text/plain', name: 'secret.txt', assetId: 'private-transfer-asset' }], paused: true,
    queued: [{ id: 'private-transfer-entry', text: 'Private transferred prompt', attachments: [], ...(source === 'lineage' ? { request: { id: 'private-start', choice: null, queuedAt: 1, start: { projectId: 'p', worktree: false, incognito: true } } } : {}) }] } };
  desk.push({ section: 'inputs', id, revision: 1, updatedAt: 1, value, ...(source === 'flag' ? { privateMode: true as const } : {}) });
  await desk.store.flushDrafts();
  desk.push({ section: 'inputs', id, revision: 2, updatedAt: 2, value: null, ...(source === 'flag' ? { privateMode: true as const } : {}) });
  await desk.store.flushDrafts();
  for (const args of writes.mock.calls) for (const word of [id, 'private-transfer-entry', 'private-transfer-asset', 'Private transferred']) expect(JSON.stringify(args)).not.toContain(word);
});

test.each(['remove', 'restore'] as const)('a private prompt taken back with %s leaves the core queue before the next turn', async action => {
  const desk = await device('private-mutation', new FakeClient({ delayMs: 0 }));
  const project = await desk.client.call('projects.drafts', {});
  const choice = desk.store.defaultChoice()!;
  const { model, ...selection } = choice;
  const secret = await desk.client.call('threads.create', { ...selection, projectId: project.id, ...(model ? { model } : {}), incognito: true });
  desk.store.composerStates[secret.id] = { text: '', attachments: [], queued: [], sending: false, paused: true };
  queue(desk.store, secret.id, 'Removed private prompt');
  await vi.waitFor(async () => expect((await recordOf(desk.client, 'inputs', secret.id))?.value?.input.queued).toHaveLength(1));
  if (action === 'remove') desk.store.removeQueued(secret.id, 0);
  else expect(desk.store.restoreQueued(secret.id, 0)?.text).toBe('Removed private prompt');
  await vi.waitFor(async () => expect((await recordOf(desk.client, 'inputs', secret.id))?.value?.input.queued ?? []).toEqual([]));
  await desk.store.send('Next private turn', secret.id);
  await desk.client.settled();
  expect(await userTexts(desk.client, secret.id)).toEqual(['Next private turn']);
});

test('retrying a private failed queue explicitly sends its resumed state to the core', async () => {
  const desk = await device('private-retry', new FakeClient({ delayMs: 0 }));
  const project = await desk.client.call('projects.drafts', {});
  const choice = desk.store.defaultChoice()!;
  const { model, ...selection } = choice;
  const secret = await desk.client.call('threads.create', { ...selection, projectId: project.id, ...(model ? { model } : {}), incognito: true });
  await desk.client.call('composer.put', { section: 'inputs', id: secret.id, expectedRevision: 0, value: { input: { text: '', attachments: [], paused: true,
    queued: [{ id: 'private-retry-entry', text: 'Private retry once', attachments: [], request: { id: 'private-retry-request', choice, queuedAt: 1, failed: 'Refused once' } }] } } });
  await vi.waitFor(() => expect(desk.store.composerStates[secret.id]?.queued[0]?.request?.failed).toBe('Refused once'));
  desk.store.retryQueued(secret.id, 0);
  await vi.waitFor(async () => expect(await userTexts(desk.client, secret.id)).toEqual(['Private retry once']));
  expect((await recordOf(desk.client, 'inputs', secret.id))?.value?.input.queued).toEqual([]);
});

test('a draft launch put protects cancel, remove, restore, discard and privacy before its admission answer', async () => {
  let release!: () => void, held = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const desk = await device('held-admission', new FakeClient({ delayMs: 0 }), { holdPushes: gate });
  desk.store.startDraft(null, { fresh: true });
  const id = desk.store.draft!.id!;
  desk.calls.mockImplementation(async (method, params) => {
    const answer = await desk.original(method, params);
    if (method === 'composer.put' && (params as { id?: string }).id === id && !held) { held = true; await gate; }
    return answer;
  });
  try {
    desk.store.queuePrompt('draft', { text: 'One admitted launch', attachments: [] }, { choice: desk.store.defaultChoice() });
    await vi.waitFor(() => expect(held).toBe(true));
    await vi.waitFor(async () => expect((await desk.original('threads.list', {})).filter(row => row.title === 'One admitted launch')).toHaveLength(1));
    expect(desk.store.composerStates.draft!.queued[0]?.request?.start).toBeUndefined();
    desk.store.cancelQueuedDraft(id);
    expect(desk.store.composerStates.draft!.queued).toHaveLength(1);
    expect(desk.store.error).toBe(strings.drafts.launchQueued);
    desk.store.removeQueued('draft', 0);
    expect(desk.store.composerStates.draft!.queued).toHaveLength(1);
    expect(desk.store.restoreQueued('draft', 0)).toBeUndefined();
    desk.store.discardDraft(id);
    expect(desk.store.draft?.id).toBe(id);
    desk.store.setDraftIncognito(true);
    expect(desk.store.draft).toMatchObject({ id });
    expect(desk.store.draft?.incognito).toBeUndefined();
    expect(desk.store.error).toBe(strings.drafts.privacyQueued);
  } finally { release(); }
  await vi.waitFor(() => expect(desk.store.openThread?.title).toBe('One admitted launch'));
  expect(desk.store.openThread?.incognito).toBeFalsy();
  await desk.client.settled();
  expect((await desk.client.call('threads.list', {})).filter(row => row.title === 'One admitted launch')).toHaveLength(1);
  expect(await userTexts(desk.client, desk.store.openThread!.id)).toEqual(['One admitted launch']);
});


test('a private direct send refused as turn-in-flight explicitly synchronizes its held prompt', async () => {
  const desk = await device('private-refusal', new FakeClient({ delayMs: 0 }));
  const project = await desk.client.call('projects.drafts', {});
  const { model, ...choice } = desk.store.defaultChoice()!;
  const secret = await desk.client.call('threads.create', { ...choice, projectId: project.id, ...(model ? { model } : {}), incognito: true });
  desk.store.composerStates[secret.id] = { text: '', attachments: [], queued: [], sending: false, paused: true };
  desk.calls.mockImplementation(async (method, params) => {
    if (method === 'turns.start') throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'turn in flight',
      data: { reason: 'turn-in-flight', threadId: secret.id, thread: { ...secret, status: 'running' } } });
    return desk.original(method, params);
  });
  expect(await desk.store.send('Private refused input', secret.id)).toBe(true);
  await vi.waitFor(async () => expect((await recordOf(desk.client, 'inputs', secret.id))?.value?.input.queued).toMatchObject([{ text: 'Private refused input' }]));
});

test.each(['cancel', 'discard'] as const)('a never-submitted private offline draft can be taken back with %s', async action => {
  const desk = await device('private-offline-cancel', new FakeClient({ delayMs: 0 }));
  desk.store.startDraft(null, { fresh: true }); desk.store.setDraftIncognito(true);
  const id = desk.store.draft!.id!;
  desk.client.drop(); await desk.client.settled();
  desk.store.queuePrompt('draft', { text: 'Do not launch offline draft', attachments: [] }, { choice: desk.store.defaultChoice() });
  if (action === 'cancel') {
    desk.store.cancelQueuedDraft(id);
    expect(desk.store.composerStates.draft).toMatchObject({ text: 'Do not launch offline draft', queued: [] });
  } else desk.store.discardDraft(id);
  await desk.client.restore();
  await quiet();
  expect((await desk.client.call('threads.list', {})).some(row => row.title === 'Do not launch offline draft')).toBe(false);
  expect(desk.store.error).toBeNull();
});

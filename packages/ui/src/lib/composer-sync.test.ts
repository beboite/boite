import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { RpcErrorCode, type ComposerRecord, type RpcMethodName, type Thread } from '@boite/contracts';
import { RpcFailure } from './client';
import { FakeClient } from './fake-client';
import { FakeComposerState } from './fake-client/composer';
import { Store } from './store.svelte';

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
async function device(machineId: string, client: FakeClient, options: { hold?: Promise<void>; connect?: boolean } = {}) {
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
    if (event === 'composer.updated') pushes.push(handler as (record: ComposerRecord) => void);
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

test('a draft sent while its machine was away is started by the core, and the device opens that conversation once', async () => {
  const desk = await device('desk', new FakeClient({ delayMs: 0 }));
  const project = desk.store.projects.find(entry => entry.kind !== 'drafts')!;
  desk.store.startDraft(project.id, { fresh: true });
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
});

test('an incognito conversation never reaches the core\'s records and keeps the frontend\'s own queue', async () => {
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
  await vi.waitFor(() => expect(called(desk, 'turns.start', params => params.threadId === secret.id)).toHaveLength(1));
  await quiet();
  expect(putsOf(desk, secret.id)).toHaveLength(0);
  expect(called(desk, 'composer.asset.put')).toHaveLength(0);
  expect(await recordOf(desk.client, 'inputs', secret.id)).toBeUndefined();
  expect(phone.store.composerStates[secret.id]).toBeUndefined();
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
  expect(phone.store.composerStates['t-scheduler']).toMatchObject({ paused: false, queued: [{ text: 'After the answer' }] });
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

test('a put the core keeps failing is tried again after a pause, not on every tick', async () => {
  const desk = await device('desk', new FakeClient({ delayMs: 0 }));
  desk.calls.mockImplementation(async (method, params) => {
    if (method === 'composer.put') throw new RpcFailure({ code: RpcErrorCode.Internal, message: 'disk full' });
    return desk.original(method, params);
  });
  desk.store.editComposerText('t-trace', 'Never stored');
  await new Promise(resolve => setTimeout(resolve, 2000));
  expect(putsOf(desk, 't-trace')).toHaveLength(1);
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

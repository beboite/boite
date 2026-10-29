import { afterEach, expect, test, vi } from 'vitest';
import { RpcErrorCode, type ComposerChoice, type ComposerRecord, type ComposerValue } from '@boite/contracts';
import { FakeClient } from './fake-client';

const clients: FakeClient[] = [];
afterEach(() => { for (const client of clients.splice(0)) client.close(); vi.restoreAllMocks(); });
async function ready(delayMs = 0) {
  const client = new FakeClient({ delayMs });
  clients.push(client);
  await client.connect();
  return client;
}
const value = (text: string): ComposerValue => ({ input: { text, attachments: [], queued: [], paused: false } });

test('a paired snapshot creates a fresh thread without overwriting a copied conversation', async () => {
  const owner = await ready();
  const source = await owner.call('threads.get', { threadId: 't-trace' });
  const selection = { projectId: source.projectId!, providerId: source.providerId, accountId: source.accountId };
  const original = await owner.call('threads.create', { ...selection, title: 'Created before pairing' });
  const peer = owner.composerPeer({ delayMs: 0 });
  clients.push(peer);
  await peer.connect();
  const created = await peer.call('threads.create', { ...selection, title: 'Created after pairing' });
  expect(created.id).not.toBe(original.id);
  expect((await peer.call('threads.get', { threadId: original.id })).title).toBe('Created before pairing');
  expect((await peer.call('threads.list', {})).filter(thread => thread.id === original.id || thread.id === created.id)).toHaveLength(2);
});

test('soft deletion preserves composer input but purging rejects an offline resurrection', async () => {
  const client = await ready();
  const first = await client.call('composer.put', { section: 'inputs', id: 't-trace', expectedRevision: 0, value: value('Kept during undo') });
  await client.call('threads.remove', { threadId: 't-trace' });
  expect((await client.call('composer.list', {})).find(row => row.id === 't-trace')?.value?.input.text).toBe('Kept during undo');
  const edited = await client.call('composer.put', { section: 'inputs', id: 't-trace', expectedRevision: first.record.revision, value: value('Offline edit during undo') });
  expect(edited.accepted).toBe(true);
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 366 * 86_400_000);
  expect(await client.call('threads.deleted', {})).toEqual([]);
  expect((await client.call('composer.list', {})).some(row => row.id === 't-trace')).toBe(false);
  await expect(client.call('composer.put', { section: 'inputs', id: 't-trace', expectedRevision: 0, value: value('Must not reappear') }))
    .rejects.toMatchObject({ code: RpcErrorCode.NotFound, data: { reason: 'thread-deleted', threadId: 't-trace', field: 'composer.id' } });
});

test('replaying a launched draft after purging its thread never creates a second thread', async () => {
  const client = await ready();
  const thread = await client.call('threads.get', { threadId: 't-trace' });
  const choice: ComposerChoice = { providerId: thread.providerId, accountId: thread.accountId, model: thread.model,
    effort: thread.effort, permissionMode: thread.permissionMode, speed: thread.speed ?? null };
  const draft = value('');
  draft.draft = { projectId: thread.projectId, worktree: false };
  draft.choice = choice;
  draft.input.queued.push({ id: 'unacknowledged-first', text: 'Old first prompt', attachments: [], choice });
  await client.call('composer.put', { section: 'drafts', id: 'unacknowledged-draft', expectedRevision: 0, value: draft });
  let launched!: string;
  await vi.waitFor(async () => {
    const threads = await client.call('threads.list', {});
    launched = threads.find(row => row.title === 'Old first prompt')!.id;
    expect(launched).toBeTruthy();
  });
  await client.call('threads.remove', { threadId: launched });
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 366 * 86_400_000);
  await client.call('threads.deleted', {});
  const saved = (await client.call('composer.list', {})).find(row => row.id === 'unacknowledged-draft')!;
  await client.call('composer.put', { section: 'drafts', id: saved.id, expectedRevision: saved.revision, value: draft });
  await vi.waitFor(async () => expect((await client.call('composer.list', {})).find(row => row.id === saved.id)?.value?.input.paused).toBe(true));
  expect((await client.call('threads.list', {})).some(row => row.title === 'Old first prompt')).toBe(false);
});

test('composer records use revisions and share clearing with a paired client', async () => {
  const owner = await ready();
  const phone = owner.composerPeer({ principal: 'session', delayMs: 0 });
  clients.push(phone);
  await phone.connect();
  const events: ComposerRecord[] = [];
  phone.on('composer.updated', row => events.push(row));
  const first = await owner.call('composer.put', { section: 'inputs', id: 't-trace', expectedRevision: 0, value: value('Continue on the phone') });
  expect(first.accepted).toBe(true);
  expect((await phone.call('composer.list', {}))[0]?.value?.input.text).toBe('Continue on the phone');
  const stale = await phone.call('composer.put', { section: 'inputs', id: 't-trace', expectedRevision: 0, value: value('Stale overwrite') });
  expect(stale).toEqual({ accepted: false, record: first.record });
  const cleared = await phone.call('composer.put', { section: 'inputs', id: 't-trace', expectedRevision: first.record.revision, value: null });
  expect(cleared.record.revision).toBe(first.record.revision + 1);
  expect(events.at(-1)?.value).toBeNull();
  expect((await owner.call('composer.list', {}))[0]?.value).toBeNull();
});

test('attachment assets are reusable and records never carry their bytes', async () => {
  const client = await ready();
  const attachment = { kind: 'file' as const, name: 'keep.txt', mimeType: 'text/plain', data: btoa('Keep these bytes') };
  const first = await client.call('composer.asset.put', { attachment });
  const second = await client.call('composer.asset.put', { attachment });
  expect(second).toEqual(first);
  const input = value('One upload');
  const { data: _data, ...meta } = attachment;
  input.input.attachments.push({ ...meta, assetId: first.assetId });
  const result = await client.call('composer.put', { section: 'inputs', id: 't-trace', expectedRevision: 0, value: input });
  expect(JSON.stringify(result)).not.toContain(attachment.data);
  expect(await client.call('composer.asset.get', first)).toEqual(attachment);
});

test('accepted queued input is delivered after the socket drops', async () => {
  const client = await ready();
  await client.call('turns.start', { threadId: 't-trace', prompt: 'First turn' });
  const input = value('Still a draft');
  input.input.queued.push({ id: 'composer-followup', text: 'Accepted followup', attachments: [], request: { id: 'composer-followup', choice: null, queuedAt: Date.now() } });
  await client.call('composer.put', { section: 'inputs', id: 't-trace', expectedRevision: 0, value: input });
  client.drop();
  await client.settled();
  await client.restore();
  await vi.waitFor(async () => {
    const rows = await client.call('composer.list', {});
    expect(rows.find(row => row.id === 't-trace')?.value?.input.queued).toHaveLength(0);
  });
  const thread = await client.call('threads.get', { threadId: 't-trace' });
  expect(thread.messages.filter(message => message.role === 'user').flatMap(message => message.parts.flatMap(part => part.type === 'text' ? [part.text] : []))).toContain('Accepted followup');
  expect((await client.call('composer.list', {}))[0]?.value?.input.text).toBe('Still a draft');
});

test('agent clients cannot access another user\'s drafts', async () => {
  const client = await ready();
  client.becomes('agent');
  await expect(client.call('composer.list', {})).rejects.toThrow(/owner|agent/);
});

test('a frozen queued turn only accepts steering with its own execution choice', async () => {
  const client = await ready(25);
  const thread = await client.call('threads.get', { threadId: 't-trace' });
  const picker: ComposerChoice = { providerId: thread.providerId, accountId: thread.accountId, permissionMode: thread.permissionMode,
    model: thread.model, effort: thread.effort, speed: thread.speed ?? null };
  const captured: ComposerChoice = { ...picker, effort: picker.effort === 'high' ? 'low' : 'high' };
  const first = value('');
  first.input.queued.push({ id: 'frozen-selection', text: 'Run with the captured choice', attachments: [], choice: captured,
    request: { id: 'frozen-selection', choice: captured, queuedAt: Date.now() } });
  await client.call('composer.put', { section: 'inputs', id: thread.id, expectedRevision: 0, value: first });
  const running = await client.call('threads.get', { threadId: thread.id });
  expect(running.turns.at(-1)?.execution?.effort).toBe(captured.effort);
  expect(running.effort).toBe(picker.effort);
  const saved = (await client.call('composer.list', {})).find(row => row.id === thread.id)!;
  const next = value('');
  next.input.queued.push({ id: 'picker-followup', text: 'Wait for the picker choice', attachments: [], choice: picker });
  await client.call('composer.put', { section: 'inputs', id: thread.id, expectedRevision: saved.revision, value: next, sendNow: true });
  const after = await client.call('threads.get', { threadId: thread.id });
  expect(after.messages.some(message => message.parts.some(part => part.type === 'text' && part.text === 'Wait for the picker choice'))).toBe(false);
  expect((await client.call('composer.list', {})).find(row => row.id === thread.id)?.value?.input.queued.map(item => item.id)).toEqual(['picker-followup']);
});

const choiceOf = (thread: ComposerChoice): ComposerChoice => ({ providerId: thread.providerId, accountId: thread.accountId, permissionMode: thread.permissionMode,
  model: thread.model, effort: thread.effort, speed: thread.speed ?? null });
const queuedIds = async (client: FakeClient, id: string) => (await client.call('composer.list', {})).find(row => row.id === id)?.value?.input.queued.map(item => item.id) ?? [];
const userTexts = async (client: FakeClient, id: string) => (await client.call('threads.get', { threadId: id })).messages.filter(message => message.role === 'user')
  .flatMap(message => message.parts.flatMap(part => part.type === 'text' ? [part.text] : []));

test('Send now outlasts a permission the turn waits on, and a queue emptied meanwhile leaves no Send now behind', async () => {
  const client = await ready();
  const thread = await client.call('threads.get', { threadId: 't-trace' });
  const choice = choiceOf(thread);
  const asked = async () => {
    await vi.waitFor(async () => expect(await client.call('permissions.list', { threadId: thread.id })).toHaveLength(1));
    return (await client.call('permissions.list', { threadId: thread.id }))[0]!.id;
  };
  const put = async (queued: ComposerValue['input']['queued'], sendNow = false) => {
    const saved = (await client.call('composer.list', {})).find(row => row.id === thread.id);
    const next = value('');
    next.input.queued = queued;
    await client.call('composer.put', { section: 'inputs', id: thread.id, expectedRevision: saved?.revision ?? 0, value: next, ...(sendNow ? { sendNow } : {}) });
  };
  await client.call('turns.start', { threadId: thread.id, prompt: '[permission] Write the notes' });
  let request = await asked();
  const turns = (await client.call('threads.get', { threadId: thread.id })).turns.length;
  await put([{ id: 'urgent-steer', text: 'Also add a summary', attachments: [], choice }], true);
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(await queuedIds(client, thread.id)).toEqual(['urgent-steer']);
  await client.call('permissions.answer', { requestId: request, decision: 'allow' });
  await vi.waitFor(async () => expect(await queuedIds(client, thread.id)).toEqual([]));
  await vi.waitFor(async () => expect((await client.call('threads.get', { threadId: thread.id })).status).toBe('idle'));
  // Steered into the turn that asked: no turn of its own.
  expect((await client.call('threads.get', { threadId: thread.id })).turns).toHaveLength(turns);
  await client.call('turns.start', { threadId: thread.id, prompt: '[permission] Write more notes' });
  request = await asked();
  await put([{ id: 'withdrawn', text: 'Never mind', attachments: [], choice }], true);
  await put([]);
  await put([{ id: 'after-turn', text: 'Wait for this turn', attachments: [], choice }]);
  await client.call('permissions.answer', { requestId: request, decision: 'allow' });
  await vi.waitFor(async () => expect(await queuedIds(client, thread.id)).toEqual([]));
  const after = await client.call('threads.get', { threadId: thread.id });
  expect(after.turns).toHaveLength(turns + 2);
  expect(await userTexts(client, thread.id)).toContain('Wait for this turn');
});

test('queued prompts share a turn when their choice is the same in any key order or speed form, and split where a boundary differs', async () => {
  const client = await ready();
  const thread = await client.call('threads.get', { threadId: 't-trace' });
  const { speed: _speed, ...noSpeed } = choiceOf(thread);
  const reordered = Object.fromEntries(Object.entries(choiceOf(thread)).reverse()) as unknown as ComposerChoice;
  const seen = (await userTexts(client, thread.id)).length;
  const input = value('');
  input.input.queued = [
    { id: 'batch-first', text: 'First', attachments: [], choice: noSpeed as ComposerChoice },
    { id: 'batch-second', text: 'Second', attachments: [], choice: reordered },
    { id: 'batch-after', text: 'After the tool', attachments: [], choice: choiceOf(thread), afterBoundary: 'tool-1' },
  ];
  await client.call('composer.put', { section: 'inputs', id: thread.id, expectedRevision: 0, value: input });
  await vi.waitFor(async () => expect(await queuedIds(client, thread.id)).toEqual([]));
  expect((await userTexts(client, thread.id)).slice(seen)).toEqual(['First\n\nSecond', 'After the tool']);
});

test('a queued /goal2 starts a reviewed goal, its stale goal2 experiment id ignored', async () => {
  const client = await ready();
  const thread = await client.call('threads.get', { threadId: 't-trace' });
  const input = value('');
  input.input.queued.push({ id: 'reviewed-goal', text: '/goal2 Ship the release', attachments: [], choice: choiceOf(thread), experiments: ['goal2'] as never });
  await client.call('composer.put', { section: 'inputs', id: thread.id, expectedRevision: 0, value: input });
  await vi.waitFor(async () => expect((await client.call('threads.get', { threadId: thread.id })).activity?.goal).toMatchObject({ objective: 'Ship the release', review: expect.anything() }));
  expect(await userTexts(client, thread.id)).not.toContain('/goal2 Ship the release');
});

test.each(['running', 'idle'] as const)('queued %s inputs follow the live permission mode instead of the captured one', async state => {
  const client = await ready(25);
  const thread = await client.call('threads.get', { threadId: 't-trace' });
  const choice = choiceOf(thread);
  const before = thread.turns.length;
  const active = state === 'running' ? await client.call('turns.start', { threadId: thread.id, prompt: 'Keep working ' + 'Continue reviewing the workspace. '.repeat(100) }) : null;
  const queued = value('');
  queued.input.paused = true;
  queued.input.queued.push({ id: `live-mode-${state}`, text: 'Follow the current mode', attachments: [], choice });
  const saved = await client.call('composer.put', { section: 'inputs', id: thread.id, expectedRevision: 0, value: queued });
  await client.call('threads.update', { threadId: thread.id, permissionMode: 'yolo' });
  queued.input.paused = false;
  await client.call('composer.put', { section: 'inputs', id: thread.id, expectedRevision: saved.record.revision, value: queued, sendNow: true });
  await vi.waitFor(async () => expect(await queuedIds(client, thread.id)).toEqual([]));
  const current = await client.call('threads.get', { threadId: thread.id });
  expect(current.permissionMode).toBe('yolo');
  expect(current.turns).toHaveLength(before + 1);
  expect(current.turns.at(-1)?.execution?.permissionMode).toBe('yolo');
  const message = current.messages.find(message => message.parts.some(part => part.type === 'text' && part.text === 'Follow the current mode'));
  expect(message?.turnId).toBe(active?.id ?? current.turns.at(-1)?.id);
});

test('a live mode update does not hide an effort change and return in the fake', async () => {
  const client = await ready(25);
  const thread = await client.call('threads.get', { threadId: 't-trace' });
  await client.call('turns.start', { threadId: thread.id, prompt: 'Keep reviewing. '.repeat(100) });
  const next = value('');
  next.input.queued.push({ id: 'mode-after-effort-return', text: 'Wait for the new selection', attachments: [], choice: choiceOf(thread) });
  await client.call('composer.put', { section: 'inputs', id: thread.id, expectedRevision: 0, value: next });
  await client.call('threads.update', { threadId: thread.id, effort: thread.effort === 'high' ? 'low' : 'high' });
  await client.call('threads.update', { threadId: thread.id, effort: thread.effort });
  await client.call('threads.update', { threadId: thread.id, permissionMode: 'yolo' });
  const saved = (await client.call('composer.list', {})).find(row => row.id === thread.id)!;
  await client.call('composer.put', { section: 'inputs', id: thread.id, expectedRevision: saved.revision, value: saved.value, sendNow: true });
  expect(await queuedIds(client, thread.id)).toEqual(['mode-after-effort-return']);
  expect(await userTexts(client, thread.id)).not.toContain('Wait for the new selection');
});

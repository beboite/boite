import { expect, vi } from 'vitest';
import { flushSync } from 'svelte';
import { test } from '../test/fake-client';
import type { Attachment, RpcParams, RpcResult } from '@boite/contracts';
import { ATTACHMENTS_PER_TURN, RpcErrorCode } from '@boite/contracts';
import { RpcFailure } from './client';
import { DRAFT_STASH_KEY } from './prefs';

const image: Attachment = { kind: 'image', mimeType: 'image/png', name: 'shot.png', data: 'aGVsbG8=' };
const callsOf = (spy: { mock: { calls: unknown[][] } }, method: string): [string, unknown][] =>
  spy.mock.calls.filter(([name]) => name === method) as [string, unknown][];
function visible() { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); }
function draft(store: import('./store.svelte').Store) {
  visible();
  store.startDraft('p-boite', { fresh: true });
  store.draftChoice = { providerId: 'echo', accountId: 'a-echo', permissionMode: 'default', model: 'echo-1', effort: null };
  store.composerStates[DRAFT_STASH_KEY]!.text = 'First prompt';
  flushSync();
  return store.draftChoice!;
}

test('typing prepares without publishing or sending and Send claims the same workspace', async ({ ready }) => {
  visible();
  const { store, client } = await ready();
  const spy = vi.spyOn(client, 'call');
  const choice = draft(store);
  await vi.waitFor(() => expect(callsOf(spy, 'drafts.prepare')).toHaveLength(1));
  const params = callsOf(spy, 'drafts.prepare')[0]![1] as RpcParams<'drafts.prepare'>;
  const prepared = await client.call('drafts.prepare', params);
  expect(store.threads.some(row => row.id === prepared.threadId)).toBe(false);
  expect(callsOf(spy, 'turns.start')).toHaveLength(0);
  expect(await store.submit('First prompt', choice)).toBe(true);
  expect(callsOf(spy, 'threads.create')[0]![1]).toMatchObject({ preparationId: params.preparationId, subscribe: true });
  expect(store.openThread?.id).toBe(prepared.threadId);
});

test('abandoning an in-flight preparation releases its exact id again after the late result', async ({ ready }) => {
  visible();
  const { store, client } = await ready();
  const call = client.call.bind(client);
  let resolve!: (value: RpcResult<'drafts.prepare'>) => void;
  const gate = new Promise<RpcResult<'drafts.prepare'>>(done => { resolve = done; });
  const spy = vi.spyOn(client, 'call').mockImplementation((method, params) => method === 'drafts.prepare' ? gate : call(method, params));
  draft(store);
  await vi.waitFor(() => expect(callsOf(spy, 'drafts.prepare')).toHaveLength(1));
  const { preparationId } = callsOf(spy, 'drafts.prepare')[0]![1] as RpcParams<'drafts.prepare'>;
  store.startDraft('p-notes', { fresh: true });
  flushSync();
  await vi.waitFor(() => expect(callsOf(spy, 'drafts.release')).toContainEqual(['drafts.release', { preparationId }]));
  resolve({ preparationId, threadId: 'stale-thread' });
  await vi.waitFor(() => expect(callsOf(spy, 'drafts.release').filter(([, p]) => (p as { preparationId: string }).preparationId === preparationId)).toHaveLength(2));
  expect(store.openThread).toBeNull();
  expect(store.threads.some(row => row.id === 'stale-thread')).toBe(false);
});

test('a draft prepared in the drafts and sent after removing them goes to new drafts, not the removed project', async ({ ready }) => {
  visible();
  const { store, client } = await ready();
  const spy = vi.spyOn(client, 'call');
  store.startDraft(null, { fresh: true });
  store.draftChoice = { providerId: 'echo', accountId: 'a-echo', permissionMode: 'default', model: 'echo-1', effort: null };
  store.composerStates[DRAFT_STASH_KEY]!.text = 'Sort my photos';
  flushSync();
  await vi.waitFor(() => expect(callsOf(spy, 'drafts.prepare')).toHaveLength(1));
  const first = callsOf(spy, 'drafts.prepare')[0]![1] as RpcParams<'drafts.prepare'>;
  await vi.waitFor(() => expect(store.draftsProject?.id).toBe(first.projectId));
  // The draft has no project of its own: it lists under the drafts.
  expect(store.draftEntries.find(entry => entry.active)).toMatchObject({ projectId: first.projectId });
  await store.removeProject(first.projectId);
  expect(store.draft).toMatchObject({ projectId: null });
  expect(store.composerStates[DRAFT_STASH_KEY]?.text).toBe('Sort my photos');
  expect(await store.submit('Sort my photos', store.draftChoice!)).toBe(true);
  const created = callsOf(spy, 'threads.create').at(-1)![1] as RpcParams<'threads.create'>;
  expect(created.projectId).not.toBe(first.projectId);
  expect(created.projectId).toBe(store.draftsProject?.id);
  expect(store.error).toBeNull();
});

test('a selection change before reactive cleanup cannot claim the former choice', async ({ ready }) => {
  visible();
  const { store, client } = await ready();
  const spy = vi.spyOn(client, 'call');
  draft(store);
  await vi.waitFor(() => expect(callsOf(spy, 'drafts.prepare')).toHaveLength(1));
  await Promise.resolve();
  const old = (callsOf(spy, 'drafts.prepare')[0]![1] as RpcParams<'drafts.prepare'>).preparationId;
  store.draftChoice = { ...store.draftChoice!, permissionMode: 'bypassPermissions' };
  expect(await store.submit('Changed selection', store.draftChoice)).toBe(true);
  const create = callsOf(spy, 'threads.create')[0]![1] as RpcParams<'threads.create'>;
  expect(create.preparationId).not.toBe(old);
  expect(create.permissionMode).toBe('bypassPermissions');
});

test('old cores use bytes and finish hydration before the first send', async ({ ready }) => {
  visible();
  const { store, client } = await ready();
  store.core = { ...store.core!, features: { ...store.core!.features, draftPreparation: false, attachmentUploads: false } };
  const call = client.call.bind(client);
  let resolve!: () => void;
  const gate = new Promise<void>(done => { resolve = done; });
  const spy = vi.spyOn(client, 'call').mockImplementation(async (method, params) => { if (method === 'threads.get') await gate; return call(method, params); });
  const choice = draft(store);
  store.composerStates[DRAFT_STASH_KEY]!.attachments = [image];
  const sending = store.submit('Old core', choice, [image]);
  await vi.waitFor(() => expect(callsOf(spy, 'threads.get')).toHaveLength(1));
  expect(callsOf(spy, 'turns.start')).toHaveLength(0);
  expect(callsOf(spy, 'drafts.prepare')).toHaveLength(0);
  expect(callsOf(spy, 'attachments.upload')).toHaveLength(0);
  resolve();
  expect(await sending).toBe(true);
  expect(callsOf(spy, 'turns.start')[0]![1]).toMatchObject({ attachments: [image] });
  expect(callsOf(spy, 'threads.create')[0]![1]).not.toHaveProperty('subscribe');
});

test('first send overlaps an older hydration snapshot and keeps live messages', async ({ ready }) => {
  visible();
  const { store, client } = await ready();
  const call = client.call.bind(client);
  let resolve!: () => void;
  const gate = new Promise<void>(done => { resolve = done; });
  const spy = vi.spyOn(client, 'call').mockImplementation(async (method, params) => {
    const result = await call(method, params);
    if (method === 'threads.get') await gate;
    return result;
  });
  const choice = draft(store);
  expect(await store.submit('Overlapping prompt', choice)).toBe(true);
  expect(store.loadingThreadId).not.toBeNull();
  expect(callsOf(spy, 'turns.start')).toHaveLength(1);
  expect(store.openThread!.messages.some(m => m.role === 'user')).toBe(true);
  await store.stop();
  const id = store.openThread!.id;
  client.sampleLoad(id, 3);
  const status = store.openThread!.status;
  const turnStatus = store.openThread!.turns.at(-1)!.status;
  resolve();
  await vi.waitFor(() => expect(store.loadingThreadId).toBeNull());
  expect(store.openThread!.messages.filter(m => m.role === 'user')).toHaveLength(1);
  expect(store.openThread!.status).toBe(status);
  expect(store.openThread!.turns.at(-1)!.status).toBe(turnStatus);
  expect(store.openThread!.load?.processes).toBe(3);
});

test('selected attachments upload before Send, expired ids retry original bytes under the same request id', async ({ ready }) => {
  visible();
  const { store, client } = await ready();
  const call = client.call.bind(client);
  let refused = false;
  const spy = vi.spyOn(client, 'call').mockImplementation((method, params) => {
    if (method === 'turns.start' && (params as RpcParams<'turns.start'>).attachmentIds && !refused) {
      refused = true;
      return Promise.reject(new RpcFailure({ code: RpcErrorCode.Refused, message: 'Upload expired', data: { reason: 'attachment-upload-expired' } }));
    }
    return call(method, params);
  });
  const choice = draft(store);
  store.composerStates[DRAFT_STASH_KEY]!.attachments = [image];
  flushSync();
  await vi.waitFor(() => expect(callsOf(spy, 'attachments.upload')).toHaveLength(1));
  await Promise.resolve();
  expect(await store.submit('With attachment', choice, [image])).toBe(true);
  const sends = callsOf(spy, 'turns.start').map(([, p]) => p as RpcParams<'turns.start'>);
  expect(sends).toHaveLength(2);
  expect(sends[0]!.attachments![0]!.data).toBe('');
  expect(sends[0]!.attachmentIds![0]).toBeTruthy();
  expect(sends[1]!.attachments).toEqual([image]);
  expect(sends[1]!.clientRequestId).toBe(sends[0]!.clientRequestId);
  expect(store.openThread!.messages.find(m => m.role === 'user')?.parts).toContainEqual(expect.objectContaining({ type: 'image', data: image.data }));
});

test('a rejected attachment upload is not retried while typing; reselect can retry and Send keeps inline bytes', async ({ ready }) => {
  visible();
  const { store, client } = await ready();
  const call = client.call.bind(client);
  const spy = vi.spyOn(client, 'call').mockImplementation((method, params) => {
    if (method === 'attachments.upload') return Promise.reject(new RpcFailure({ code: RpcErrorCode.Refused, message: 'Upload storage unavailable' }));
    return call(method, params as never);
  });
  const choice = draft(store);
  const state = store.composerStates[DRAFT_STASH_KEY]!;
  state.attachments = [image];
  flushSync();
  await vi.waitFor(() => expect(callsOf(spy, 'attachments.upload')).toHaveLength(1));
  for (const text of ['First prompt a', 'First prompt ab', 'First prompt abc']) {
    state.text = text;
    flushSync();
    await Promise.resolve();
  }
  expect(callsOf(spy, 'attachments.upload')).toHaveLength(1);
  expect(state.attachments).toEqual([image]);
  state.attachments = [];
  flushSync();
  await Promise.resolve();
  state.attachments = [image];
  flushSync();
  await vi.waitFor(() => expect(callsOf(spy, 'attachments.upload')).toHaveLength(2));
  state.text = 'Reselected attachment';
  flushSync();
  await Promise.resolve();
  expect(callsOf(spy, 'attachments.upload')).toHaveLength(2);
  expect(await store.submit(state.text, choice, [image])).toBe(true);
  const sent = callsOf(spy, 'turns.start')[0]![1] as RpcParams<'turns.start'>;
  expect(sent.attachments).toEqual([image]);
  expect(sent).not.toHaveProperty('attachmentIds');
  expect(store.openThread!.messages.find(message => message.role === 'user')?.parts)
    .toContainEqual(expect.objectContaining({ type: 'image', data: image.data }));
});

test('pending preparation and uploads never hold Send', async ({ ready }) => {
  visible();
  const { store, client } = await ready();
  const call = client.call.bind(client);
  let resolvePrepare!: (value: RpcResult<'drafts.prepare'>) => void;
  let resolveUpload!: (value: RpcResult<'attachments.upload'>) => void;
  const prepare = new Promise<RpcResult<'drafts.prepare'>>(done => { resolvePrepare = done; });
  const upload = new Promise<RpcResult<'attachments.upload'>>(done => { resolveUpload = done; });
  const spy = vi.spyOn(client, 'call').mockImplementation((method, params) => method === 'drafts.prepare' ? prepare : method === 'attachments.upload' ? upload : call(method, params as never));
  const choice = draft(store);
  store.composerStates[DRAFT_STASH_KEY]!.attachments = [image];
  flushSync();
  await vi.waitFor(() => { expect(callsOf(spy, 'drafts.prepare')).toHaveLength(1); expect(callsOf(spy, 'attachments.upload')).toHaveLength(1); });
  expect(await store.submit('Send now', choice, [image])).toBe(true);
  expect(callsOf(spy, 'threads.create')[0]![1]).not.toHaveProperty('preparationId');
  expect(callsOf(spy, 'turns.start')[0]![1]).toMatchObject({ attachments: [image] });
  const { preparationId } = callsOf(spy, 'drafts.prepare')[0]![1] as RpcParams<'drafts.prepare'>;
  resolvePrepare({ preparationId, threadId: 'unused' });
  resolveUpload({ id: 'unused-upload' });
  await vi.waitFor(() => expect(callsOf(spy, 'attachments.release')).toContainEqual(['attachments.release', { ids: ['unused-upload'] }]));
});

test('submitAndDraft preserves the new draft when creation hydration completes late', async ({ ready }) => {
  visible();
  const { store, client } = await ready();
  const call = client.call.bind(client);
  let resolve!: () => void;
  const gate = new Promise<void>(done => { resolve = done; });
  vi.spyOn(client, 'call').mockImplementation(async (method, params) => {
    const result = await call(method, params);
    if (method === 'threads.get') await gate;
    return result;
  });
  const choice = draft(store);
  expect(await store.submitAndDraft('New draft after send', choice)).toBe(true);
  const next = store.draft;
  expect(next).not.toBeNull();
  expect(store.openThread).toBeNull();
  resolve();
  await Promise.resolve(); await Promise.resolve();
  expect(store.draft).toBe(next);
  expect(store.openThread).toBeNull();
});

test('hiding the machine releases the reservation and reconnect cannot reuse upload ids', async ({ ready }) => {
  visible();
  const { store, client } = await ready();
  const spy = vi.spyOn(client, 'call');
  const choice = draft(store);
  store.composerStates[DRAFT_STASH_KEY]!.attachments = [image];
  flushSync();
  await vi.waitFor(() => { expect(callsOf(spy, 'drafts.prepare')).toHaveLength(1); expect(callsOf(spy, 'attachments.upload')).toHaveLength(1); });
  await Promise.resolve();
  const id = (callsOf(spy, 'drafts.prepare')[0]![1] as RpcParams<'drafts.prepare'>).preparationId;
  store.visible = false;
  flushSync();
  await vi.waitFor(() => expect(callsOf(spy, 'drafts.release')).toContainEqual(['drafts.release', { preparationId: id }]));
  client.drop(); await client.restore();
  expect(await store.submit('Reconnect with local bytes', choice, [image])).toBe(true);
  const create = callsOf(spy, 'threads.create')[0]![1] as RpcParams<'threads.create'>;
  expect(create.preparationId).not.toBe(id);
  expect(callsOf(spy, 'turns.start')[0]![1]).toMatchObject({ attachments: [image] });
});

test('draft validation joins the existing account model probe', async ({ ready }) => {
  visible();
  const { store, client } = await ready();
  const call = client.call.bind(client);
  let resolve!: () => void;
  const gate = new Promise<void>(done => { resolve = done; });
  const spy = vi.spyOn(client, 'call').mockImplementation(async (method, params) => {
    if (method === 'providers.probe') await gate;
    return call(method, params);
  });
  const choice = { providerId: 'claude', accountId: 'a-claude-main', model: 'claude-sonnet-4-6', effort: null, permissionMode: 'default' as const };
  const catalog = store.probeModels(choice.providerId, choice.accountId, true);
  const validate = store.prepareDraftChoice(choice);
  expect(callsOf(spy, 'providers.probe')).toHaveLength(1);
  resolve();
  await catalog; await validate;
  expect(callsOf(spy, 'providers.probe')).toHaveLength(1);
});

test('fake preparation coalesces duplicate ids and preserves a worktree across title changes', async ({ ready }) => {
  const { client } = await ready();
  const input: RpcParams<'drafts.prepare'> = { preparationId: 'stable-workspace-id', projectId: 'p-boite', providerId: 'echo', accountId: 'a-echo', worktree: {} };
  const [first, second] = await Promise.all([client.call('drafts.prepare', input), client.call('drafts.prepare', input)]);
  expect(second).toEqual(first);
  expect((await client.call('threads.list', {})).some(thread => thread.id === first.threadId)).toBe(false);
  const created = await client.call('threads.create', { ...input, title: 'Final prompt title', subscribe: true });
  expect(created.id).toBe(first.threadId);
  const replay = await client.call('threads.create', { ...input, title: 'Final prompt title', subscribe: true });
  expect(replay.id).toBe(first.threadId);
  expect((await client.call('threads.list', {})).filter(thread => thread.id === first.threadId)).toHaveLength(1);
  expect(created.title).toBe('Final prompt title');
  expect(created.branch).not.toBeNull();
  expect(created.cwd).toBe((await client.call('threads.get', { threadId: created.id })).cwd);
});

test('fake release before prepare cancels only that reservation id', async ({ ready }) => {
  const { client } = await ready();
  const input = { projectId: 'p-boite', providerId: 'echo', accountId: 'a-echo', preparationId: 'canceled-reservation' };
  await client.call('drafts.release', { preparationId: input.preparationId });
  await expect(client.call('drafts.prepare', input)).rejects.toMatchObject({ data: { reason: 'draft-preparation-expired' } });
  const next = await client.call('drafts.prepare', { ...input, preparationId: 'different-reservation' });
  expect(next.preparationId).toBe('different-reservation');
});


test('paired phone sessions prepare and upload with their existing creation authority', async ({ ready }) => {
  visible();
  const { store, client } = await ready({ delayMs: 0, principal: 'session' });
  expect(store.owner).toBe(false);
  const spy = vi.spyOn(client, 'call');
  const choice = draft(store);
  store.composerStates[DRAFT_STASH_KEY]!.attachments = [image];
  flushSync();
  await vi.waitFor(() => { expect(callsOf(spy, 'drafts.prepare')).toHaveLength(1); expect(callsOf(spy, 'attachments.upload')).toHaveLength(1); });
  await Promise.resolve();
  expect(await store.submit('Phone draft', choice, [image])).toBe(true);
  expect(callsOf(spy, 'threads.create')[0]![1]).toHaveProperty('preparationId');
  expect(callsOf(spy, 'turns.start')[0]![1]).toHaveProperty('attachmentIds');
});


for (const lifecycle of ['current', 'detach', 'reconnect'] as const) test(`incompatible prepared creation after release: ${lifecycle}`, async ({ ready }) => {
  visible();
  const { store, client } = await ready();
  const call = client.call.bind(client);
  let refused = false;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const spy = vi.spyOn(client, 'call').mockImplementation((method, params) => {
    const forward = () => call(method, params);
    if (method === 'threads.create' && (params as RpcParams<'threads.create'>).preparationId && !refused) {
      refused = true;
      return Promise.reject(new RpcFailure({ code: RpcErrorCode.Refused, message: 'Selection changed', data: { reason: 'draft-preparation-mismatch' } }));
    }
    if (method === 'drafts.release') return gate.then(forward);
    return forward();
  });
  const choice = draft(store);
  await vi.waitFor(() => expect(callsOf(spy, 'drafts.prepare')).toHaveLength(1));
  await Promise.resolve();
  const id = (callsOf(spy, 'drafts.prepare')[0]![1] as RpcParams<'drafts.prepare'>).preparationId;
  const sending = store.submit('Fallback cleanly', choice);
  await vi.waitFor(() => expect(callsOf(spy, 'drafts.release')).toContainEqual(['drafts.release', { preparationId: id }]));
  expect(callsOf(spy, 'threads.create')).toHaveLength(1);
  if (lifecycle === 'detach') store.detach();
  if (lifecycle === 'reconnect') { client.drop(); await client.restore(); }
  release();
  expect(await sending).toBe(lifecycle !== 'detach');
  expect(callsOf(spy, 'threads.create')).toHaveLength(lifecycle === 'detach' ? 1 : 2);
  expect(callsOf(spy, 'drafts.release')).toContainEqual(['drafts.release', { preparationId: id }]);
  if (lifecycle !== 'detach') expect(callsOf(spy, 'threads.create')[1]![1]).not.toHaveProperty('preparationId');
});

test('fake uploads reject malformed bytes, count overflow and invalid reference slots', async ({ ready }) => {
  const { client } = await ready();
  await expect(client.call('attachments.upload', { attachment: { ...image, data: 'invalid!' } })).rejects.toMatchObject({ code: RpcErrorCode.Refused });
  const { id } = await client.call('attachments.upload', { attachment: image });
  const params = { threadId: 't-trace', prompt: 'Attachment', attachments: [{ ...image, data: '' }], attachmentIds: [id] };
  await expect(client.call('turns.start', { ...params, attachmentIds: [12 as unknown as string] })).rejects.toMatchObject({ code: RpcErrorCode.Refused });
  await expect(client.call('turns.start', { ...params, attachmentIds: [] })).rejects.toMatchObject({ code: RpcErrorCode.Refused });
  await expect(client.call('turns.start', { ...params, attachments: [image] })).rejects.toMatchObject({ code: RpcErrorCode.Refused });
  await client.call('attachments.release', { ids: [id] });
  const empty: Attachment = { kind: 'file', name: null, mimeType: 'text/plain', data: '' };
  for (let i = 0; i < ATTACHMENTS_PER_TURN; i++) await client.call('attachments.upload', { attachment: empty });
  await expect(client.call('attachments.upload', { attachment: empty })).rejects.toMatchObject({ code: RpcErrorCode.Refused });
});

test('fake connections replace and clean the former reserved worktree', async ({ ready }) => {
  const { client } = await ready();
  const params = { projectId: 'p-boite', providerId: 'echo', accountId: 'a-echo', worktree: {} };
  const before = await client.call('worktrees.list', { projectId: 'p-boite' });
  const first = await client.call('drafts.prepare', { ...params, preparationId: 'first-reservation' });
  expect(await client.call('worktrees.list', { projectId: 'p-boite' })).toHaveLength(before.length + 1);
  const second = await client.call('drafts.prepare', { ...params, preparationId: 'second-reservation' });
  expect(await client.call('worktrees.list', { projectId: 'p-boite' })).toHaveLength(before.length + 1);
  expect(second.threadId).not.toBe(first.threadId);
  await client.call('drafts.release', { preparationId: 'second-reservation' });
  expect(await client.call('worktrees.list', { projectId: 'p-boite' })).toHaveLength(before.length);
});

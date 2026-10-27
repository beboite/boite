import { afterEach, expect, test } from 'bun:test';
import type { ComposerValue } from '@boite/contracts';
import { echoThread, holdAccountTurns, startTestCore, waitFor, type TestCore } from './harness.ts';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setDriver } from '../src/drivers/index.ts';
import type { TurnContext, TurnResult } from '../src/drivers/types.ts';
import { thrown } from './settle.ts';
import { connect } from '../src/client.ts';

let h: TestCore;
let restore: (() => void) | undefined;
let restartDir: string | undefined;
afterEach(async () => { await h?.stop(); restore?.(); restore = undefined; if (restartDir) rmSync(restartDir, { recursive: true, force: true }); restartDir = undefined; });
const value = (text = 'draft'): ComposerValue => ({ input: { text, attachments: [], queued: [], paused: false } });

test('composer records use CAS and broadcast metadata to another unsubscribed client', async () => {
  h = await startTestCore();
  const a = await h.connect(), b = await h.connect();
  const update = b.next('composer.updated');
  const put = { section: 'drafts' as const, id: 'draft-a', expectedRevision: 0, value: value() };
  const first = await a.call('composer.put', put);
  expect(first).toMatchObject({ accepted: true, record: { revision: 1 } });
  expect(await update).toEqual(first.record);
  expect(await b.call('composer.put', { ...put, value: value('stale') })).toEqual({ accepted: false, record: first.record });
  expect(await b.call('composer.list', {})).toEqual([first.record]);
});

test('attachment assets survive restart, deduplicate and stay out of record broadcasts', async () => {
  restartDir = mkdtempSync(join(tmpdir(), 'composer-restart-'));
  h = await startTestCore({ dataDir: restartDir });
  const a = await h.connect();
  const attachment = { kind: 'file' as const, mimeType: 'text/plain', name: 'notes.txt', data: 'aGVsbG8=' };
  const asset = await a.call('composer.asset.put', { attachment });
  expect(await a.call('composer.asset.put', { attachment })).toEqual(asset);
  expect(await thrown(a.call('composer.asset.get', asset))).toThrow('referenced');
  const record = await a.call('composer.put', { section: 'drafts', id: 'file-draft', expectedRevision: 0, value: { input: { ...value().input, attachments: [{ kind: attachment.kind, mimeType: attachment.mimeType, name: attachment.name, assetId: asset.assetId }] } } });
  expect(JSON.stringify(record)).not.toContain(attachment.data);
  const removedAsset = await a.call('composer.asset.put', { attachment: { ...attachment, data: 'cmVtb3ZlZA==' } });
  const removed = await a.call('composer.put', { section: 'drafts', id: 'removed-file-draft', expectedRevision: 0, value: { input: { ...value().input, attachments: [{ kind: attachment.kind, mimeType: attachment.mimeType, name: attachment.name, assetId: removedAsset.assetId }] } } });
  await a.call('composer.put', { section: 'drafts', id: 'removed-file-draft', expectedRevision: removed.record.revision, value: null });
  expect(h.core.journal.db.query('SELECT count(*) AS n FROM composer_assets').get()).toEqual({ n: 2 });
  await h.stop(); h = await startTestCore({ dataDir: restartDir });
  const b = await h.connect();
  expect(await b.call('composer.asset.get', asset)).toEqual(attachment);
  expect(await b.call('composer.asset.put', { attachment })).toEqual(asset);
  expect(h.core.journal.db.query('SELECT count(*) AS n FROM composer_assets').get()).toEqual({ n: 1 });
});

test('an offline first prompt creates one thread, transfers its queue and retains unsent draft text', async () => {
  h = await startTestCore();
  const a = await h.connect();
  const project = await a.call('projects.add', { path: h.dataDir });
  const account = (await a.call('accounts.list', {})).find(account => account.providerId === 'echo')!;
  const selected = { providerId: 'echo', accountId: account.id, model: null, effort: null, permissionMode: 'default' as const };
  await a.call('composer.put', { section: 'drafts', id: 'offline-draft', expectedRevision: 0, value: { ...value('still being typed'), choice: selected, draft: { projectId: project.id, worktree: false }, input: { ...value('still being typed').input, queued: [{ id: 'offline-first', text: 'start from the offline queue', attachments: [] }] } } });
  a.close();
  await waitFor(() => h.core.journal.listThreads().some(thread => h.core.journal.listTurns(thread.id).some(turn => turn.status === 'done')));
  expect(h.core.journal.listThreads()).toHaveLength(1);
  const records = h.core.composer.storage.list();
  expect(records.find(record => record.id === 'offline-draft')?.value?.input).toMatchObject({ text: 'still being typed', queued: [] });
  expect(records.find(record => record.section === 'inputs')?.value?.input).toMatchObject({ text: '', queued: [] });
  const retained = h.core.composer.storage.get('drafts', 'offline-draft');
  const reference = { id: 'unsent-reference', url: 'https://example.com', selector: 'h1', text: 'keep this reference', bounds: { x: 0, y: 0, width: 10, height: 10 } };
  retained.value!.input.text = '';
  retained.value!.input.previewReferences = [reference];
  retained.value!.input.queued = [{ id: 'offline-second', text: 'start another conversation', attachments: [] }];
  const b = await h.connect();
  await b.call('composer.put', { section: 'drafts', id: retained.id, expectedRevision: retained.revision, value: retained.value });
  await waitFor(() => h.core.journal.listThreads().length === 2 || h.core.composer.storage.get('drafts', retained.id).value?.input.paused === true);
  expect(h.core.journal.listThreads()).toHaveLength(2);
  await waitFor(() => h.core.journal.listThreads().every(thread => h.core.journal.listTurns(thread.id).some(turn => turn.status === 'done')));
  expect(h.core.composer.storage.get('drafts', retained.id).value?.input).toMatchObject({ text: '', queued: [], previewReferences: [reference] });
  for (const thread of h.core.journal.listThreads()) expect(JSON.stringify(h.core.journal.listMessages(thread.id))).not.toContain(reference.text);
});

test('a known failed draft creation cleans its workspace and permits retrying the same queued input', async () => {
  h = await startTestCore();
  const a = await h.connect();
  const project = h.core.projects.drafts();
  const account = (await a.call('accounts.list', {})).find(account => account.providerId === 'echo')!;
  const choice = { providerId: 'echo', accountId: account.id, model: 'echo', effort: null, permissionMode: 'default' as const };
  const creation = h.core.threads.creation, create = creation.create;
  let abandonedPath: string | undefined;
  creation.create = (...args) => {
    abandonedPath = create.call(creation, ...args).cwd;
    throw new Error('temporary pre-publication failure');
  };
  try {
    await a.call('composer.put', { section: 'drafts', id: 'retry-draft', expectedRevision: 0, value: { draft: { projectId: project.id, worktree: false }, choice, input: { ...value('').input, queued: [{ id: 'retry-same-input', text: 'start after retry', attachments: [] }] } } });
    await waitFor(() => h.core.composer.storage.get('drafts', 'retry-draft').value?.input.paused === true);
    const record = h.core.composer.storage.get('drafts', 'retry-draft');
    expect(record.value?.input.queued[0]?.request?.failed).toBe('temporary pre-publication failure');
    creation.create = create;
    record.value!.input.paused = false;
    delete record.value!.input.queued[0]!.request!.failed;
    await a.call('composer.put', { section: record.section, id: record.id, expectedRevision: record.revision, value: record.value });
    await waitFor(() => h.core.journal.listThreads().length === 1 || h.core.composer.storage.get('drafts', record.id).value?.input.paused === true);
    expect(h.core.journal.listThreads()).toHaveLength(1);
    expect(existsSync(abandonedPath!)).toBe(false);
    expect(h.core.journal.getSetting('draftReservationOwnership')).toBeUndefined();
    await waitFor(() => h.core.journal.listTurns(h.core.journal.listThreads()[0]!.id).some(turn => turn.status === 'done'));
  } finally { creation.create = create; }
});

function scripted(steer?: (text: string) => Promise<boolean>) {
  let context!: TurnContext, finish!: (result: TurnResult) => void;
  restore = setDriver('echo', { protocol: 'echo', startTurn(ctx) {
    context = ctx;
    return { done: new Promise(resolve => { finish = resolve; }), stop() { finish({ status: 'stopped', sessionId: null, usage: null }); }, ...(steer ? { steer } : {}) };
  } });
  return { context: () => context, finish: () => finish({ status: 'done', sessionId: null, usage: null }) };
}

test('steering waits for a tool boundary, locks only the captured item and preserves new typing', async () => {
  h = await startTestCore();
  const a = await h.connect();
  const { threadId } = await echoThread(h, a);
  const inputs: string[] = [];
  let accept!: (value: boolean) => void;
  const driver = scripted(text => { inputs.push(text); return new Promise(resolve => { accept = resolve; }); });
  await a.call('turns.start', { threadId, prompt: 'working' });
  await waitFor(() => h.core.threads.runner.handles.has(threadId));
  await a.call('composer.put', { section: 'inputs', id: threadId, expectedRevision: 0, value: { input: { ...value().input, queued: [{ id: 'boundary-follow-up', text: 'do this next', attachments: [] }] } } });
  await Bun.sleep(20); expect(inputs).toHaveLength(0);
  const message = driver.context().emit.startMessage('assistant');
  driver.context().emit.part(message, 0, { type: 'tool', toolId: 'read-1', name: 'Read', input: {}, output: 'ok', status: 'done' });
  await waitFor(() => inputs.length === 1);
  let current = h.core.composer.storage.get('inputs', threadId);
  const removed = await a.call('composer.put', { section: 'inputs', id: threadId, expectedRevision: current.revision, value: value('typing') });
  expect(removed.accepted).toBe(false);
  const typed = structuredClone(current.value!); typed.input.text = 'typing while provider accepts';
  expect((await a.call('composer.put', { section: 'inputs', id: threadId, expectedRevision: current.revision, value: typed })).accepted).toBe(true);
  accept(true);
  await waitFor(() => h.core.composer.storage.get('inputs', threadId).value?.input.queued.length === 0);
  current = h.core.composer.storage.get('inputs', threadId);
  expect(current.value?.input.text).toBe('typing while provider accepts');
  expect(h.core.journal.listTurns(threadId)).toHaveLength(1);
});

test('a queue for the newer picker waits instead of steering into a captured execution on another account', async () => {
  h = await startTestCore();
  const a = await h.connect();
  const { threadId, accountId } = await echoThread(h, a);
  const accountB = await a.call('accounts.add', { providerId: 'echo', label: 'New picker' });
  await a.call('threads.update', { threadId, accountId: accountB.id });
  const choice = (id: string) => ({ providerId: 'echo', accountId: id, model: 'echo', effort: null, permissionMode: 'default' as const });
  const steered: string[] = [];
  const driver = scripted(async text => { steered.push(text); return true; });
  await a.call('composer.put', { section: 'inputs', id: threadId, expectedRevision: 0, value: { input: { ...value().input, queued: [
    { id: 'captured-account-a', text: 'run on account A', attachments: [], choice: choice(accountId) },
    { id: 'picker-account-b', text: 'run on account B', attachments: [], choice: choice(accountB.id) },
  ] } } });
  await waitFor(() => h.core.threads.runner.handles.has(threadId));
  expect(driver.context().thread.accountId).toBe(accountId);
  const message = driver.context().emit.startMessage('assistant');
  driver.context().emit.part(message, 0, { type: 'tool', toolId: 'account-read', name: 'Read', input: {}, output: 'ok', status: 'done' });
  await Bun.sleep(30);
  expect(steered).toEqual([]);
  expect(h.core.composer.storage.get('inputs', threadId).value?.input.queued.map(item => item.id)).toEqual(['picker-account-b']);
  driver.finish();
  await waitFor(() => driver.context().thread.accountId === accountB.id);
  expect(h.core.journal.listTurns(threadId)).toHaveLength(2);
  driver.finish();
});

test('an uncertain native steering acknowledgement is held through a restart', async () => {
  restartDir = mkdtempSync(join(tmpdir(), 'composer-uncertain-'));
  h = await startTestCore({ dataDir: restartDir });
  const a = await h.connect();
  const { threadId } = await echoThread(h, a);
  let submissions = 0;
  scripted(async () => { submissions++; throw new Error('native acknowledgement lost'); });
  await a.call('turns.start', { threadId, prompt: 'working' });
  await waitFor(() => h.core.threads.runner.handles.has(threadId));
  await a.call('composer.put', { section: 'inputs', id: threadId, expectedRevision: 0, sendNow: true, value: { input: { ...value().input, queued: [{ id: 'ambiguous-input', text: 'uncertain follow up', attachments: [] }] } } });
  await waitFor(() => h.core.composer.storage.get('inputs', threadId).value?.input.paused === true);
  expect(submissions).toBe(1);
  expect(h.core.composer.storage.get('inputs', threadId).value?.input.queued[0]?.request?.failed).toContain('unconfirmed');
  await h.stop(); restore?.(); restore = undefined;
  h = await startTestCore({ dataDir: restartDir });
  await Bun.sleep(30);
  expect(h.core.composer.storage.get('inputs', threadId).value?.input.paused).toBe(true);
  expect(h.core.journal.listTurns(threadId)).toHaveLength(1);
});

test('a non-steering provider leaves waiting queues active after restart and delivers them in order once', async () => {
  restartDir = mkdtempSync(join(tmpdir(), 'composer-order-'));
  h = await startTestCore({ dataDir: restartDir });
  const a = await h.connect();
  const { threadId } = await echoThread(h, a);
  const driver = scripted();
  await a.call('turns.start', { threadId, prompt: 'active before restart' });
  await waitFor(() => h.core.threads.runner.handles.has(threadId));
  await a.call('composer.put', { section: 'inputs', id: threadId, expectedRevision: 0, value: { input: { ...value().input, queued: ['one', 'two'].map(text => ({ id: `ordered-${text}`, text, attachments: [], request: { id: `ordered-${text}`, choice: null, queuedAt: Date.now() } })) } } });
  const message = driver.context().emit.startMessage('assistant');
  driver.context().emit.part(message, 0, { type: 'tool', toolId: 'read-1', name: 'Read', input: {}, output: 'ok', status: 'done' });
  await Bun.sleep(30);
  expect(h.core.composer.storage.get('inputs', threadId).value?.input.queued).toHaveLength(2);
  await h.stop(); restore?.(); restore = undefined;
  h = await startTestCore({ dataDir: restartDir });
  await waitFor(() => h.core.journal.listTurns(threadId).filter(turn => turn.status === 'done').length === 2);
  const messages = h.core.journal.listMessages(threadId).filter(message => message.role === 'user');
  expect(messages.map(message => message.parts[0])).toEqual([{ type: 'text', text: 'active before restart' }, { type: 'text', text: 'one' }, { type: 'text', text: 'two' }]);
  await h.stop(); h = await startTestCore({ dataDir: restartDir }); await Bun.sleep(30);
  expect(h.core.journal.listTurns(threadId)).toHaveLength(3);
});

test('archived and deleted targets cannot execute queued input', async () => {
  h = await startTestCore();
  const a = await h.connect();
  const { threadId } = await echoThread(h, a);
  await a.call('threads.archive', { threadId });
  await a.call('composer.put', { section: 'inputs', id: threadId, expectedRevision: 0, value: { input: { ...value().input, queued: [{ id: 'archive-input', text: 'must wait', attachments: [] }] } } });
  await Bun.sleep(30);
  expect(h.core.journal.listTurns(threadId)).toHaveLength(0);
  await a.call('threads.remove', { threadId });
  await Bun.sleep(30);
  expect(h.core.journal.listTurns(threadId)).toHaveLength(0);
});

test('incognito composer records and attachments are memory-only', async () => {
  restartDir = mkdtempSync(join(tmpdir(), 'composer-private-'));
  h = await startTestCore({ dataDir: restartDir });
  const a = await h.connect();
  const attachment = { kind: 'file' as const, mimeType: 'text/plain', name: 'private.txt', data: 'c2VjcmV0' };
  const b = await h.connect();
  const { grant } = await a.call('pairing.grant', {});
  const phone = await connect(h.url, '', { grant, client: { name: 'phone', version: 'test' } });
  const leaked: unknown[] = [];
  b.on('composer.updated', record => leaked.push(record));
  phone.on('composer.updated', record => leaked.push(record));
  const asset = await a.call('composer.asset.put', { attachment, incognito: true });
  await a.call('composer.put', { section: 'drafts', id: 'private-draft', expectedRevision: 0, value: { ...value('private text'), draft: { projectId: null, worktree: false, incognito: true }, input: { ...value('private text').input, attachments: [{ kind: attachment.kind, name: attachment.name, mimeType: attachment.mimeType, assetId: asset.assetId }] } } });
  expect(h.core.journal.db.query('SELECT count(*) AS n FROM composer_records').get()).toEqual({ n: 0 });
  expect(h.core.journal.db.query('SELECT count(*) AS n FROM composer_assets').get()).toEqual({ n: 0 });
  expect(await a.call('composer.asset.get', asset)).toEqual(attachment);
  expect(await a.call('composer.list', {})).toHaveLength(1);
  for (const other of [b, phone]) {
    expect(await other.call('composer.list', {})).toEqual([]);
    expect(await thrown(other.call('composer.asset.get', asset))).toThrow('referenced');
    expect(await thrown(other.call('composer.put', { section: 'drafts', id: 'private-draft', expectedRevision: 0, value: value('overwrite') }))).toThrow('private composer');
  }
  expect(leaked).toEqual([]);
  phone.close();
  await h.stop(); h = await startTestCore({ dataDir: restartDir });
  expect(h.core.composer.storage.list()).toEqual([]);
});

test('the core delivers an accepted queue with no connected client and deduplicates a stale reintroduction', async () => {
  h = await startTestCore();
  const owner = await h.connect();
  const { threadId } = await echoThread(h, owner);
  const queued = [{ id: 'queue-one', text: 'first queued input', attachments: [] }];
  const first = await owner.call('composer.put', { section: 'inputs', id: threadId, expectedRevision: 0, value: { ...value('next typing'), input: { ...value().input, text: 'next typing', queued } } });
  owner.close();
  await waitFor(() => h.core.journal.listTurns(threadId).some(turn => turn.status === 'done'));
  const other = await h.connect();
  const record = (await other.call('composer.list', {})).find(record => record.id === threadId)!;
  expect(record.value?.input).toMatchObject({ text: 'next typing', queued: [] });
  await other.call('composer.put', { section: 'inputs', id: threadId, expectedRevision: record.revision, value: first.record.value });
  await Bun.sleep(30);
  expect(h.core.journal.listTurns(threadId)).toHaveLength(1);
});

test('adjacent ordinary inputs share a bounded submission and all their ids remain deduplicated', async () => {
  h = await startTestCore();
  const a = await h.connect();
  const { threadId } = await echoThread(h, a);
  const queued = ['first', 'second'].map(text => ({ id: `batch-${text}`, text, attachments: [] }));
  await a.call('composer.put', { section: 'inputs', id: threadId, expectedRevision: 0, value: { input: { ...value().input, queued } } });
  await waitFor(() => h.core.journal.listTurns(threadId).some(turn => turn.status === 'done'));
  expect(h.core.journal.listTurns(threadId)).toHaveLength(1);
  expect(h.core.journal.listMessages(threadId).find(message => message.role === 'user')?.parts[0]).toEqual({ type: 'text', text: 'first\n\nsecond' });
  const current = h.core.composer.storage.get('inputs', threadId);
  await a.call('composer.put', { section: 'inputs', id: threadId, expectedRevision: current.revision, value: { input: { ...value().input, queued } } });
  expect(h.core.composer.storage.get('inputs', threadId).value?.input.queued).toEqual([]);
});

test('a captured execution keeps its account, model and effort without changing the newer picker', async () => {
  h = await startTestCore();
  const a = await h.connect();
  const { threadId, accountId } = await echoThread(h, a);
  const provider = h.core.providers.require('echo');
  provider.models = [{ id: 'captured-model', name: 'Captured', effort: { levels: [{ id: 'high', label: 'High' }] } }, { id: 'picker-model', name: 'Picker' }];
  const nextAccount = await a.call('accounts.add', { providerId: 'echo', label: 'New picker' });
  const choice = { providerId: 'echo', accountId, model: 'captured-model', effort: 'high', permissionMode: 'default' as const };
  await a.call('composer.put', { section: 'inputs', id: threadId, expectedRevision: 0, value: { input: { ...value().input, paused: true, queued: [{ id: 'captured-input', text: 'use captured selection', attachments: [], choice }] } } });
  await a.call('threads.update', { threadId, accountId: nextAccount.id, model: 'picker-model', effort: null });
  h.core.journal.putThread({ ...h.core.threads.require(threadId), sessionId: 'picker-session', sessionResumeAt: 'picker-message' });
  const current = h.core.composer.storage.get('inputs', threadId);
  current.value!.input.paused = false;
  const driver = scripted();
  await a.call('composer.put', { section: 'inputs', id: threadId, expectedRevision: current.revision, value: current.value });
  await waitFor(() => h.core.threads.runner.handles.has(threadId));
  expect(driver.context().thread).toMatchObject({ accountId, model: 'captured-model', effort: 'high' });
  expect(driver.context().thread).toMatchObject({ sessionId: null, sessionResumeAt: null });
  expect(h.core.threads.require(threadId)).toMatchObject({ accountId: nextAccount.id, model: 'picker-model', effort: null });
  driver.finish();
  await waitFor(() => h.core.journal.listTurns(threadId).some(turn => turn.status === 'done'));
  expect(h.core.threads.require(threadId)).toMatchObject({ accountId: nextAccount.id, model: 'picker-model', effort: null });
});

test('server-admitted but never-started turns resume after restart while legacy turns stay held', async () => {
  restartDir = mkdtempSync(join(tmpdir(), 'composer-admitted-'));
  h = await startTestCore({ dataDir: restartDir });
  const a = await h.connect();
  const first = await echoThread(h, a), legacy = await echoThread(h, a);
  holdAccountTurns(h);
  await a.call('composer.put', { section: 'inputs', id: first.threadId, expectedRevision: 0, value: { input: { ...value().input, queued: [{ id: 'admitted-input', text: 'safe admitted input', attachments: [] }] } } });
  await waitFor(() => h.core.journal.listTurns(first.threadId).length === 1);
  const turn = await a.call('turns.start', { threadId: legacy.threadId, prompt: 'legacy held input' });
  const owned = h.core.journal.listTurns(first.threadId)[0]!;
  await h.stop();
  h = await startTestCore({ dataDir: restartDir });
  await waitFor(() => h.core.journal.getTurn(owned.id)?.status === 'done');
  expect(h.core.journal.listTurns(first.threadId)).toHaveLength(1);
  // Legacy queues restored from a crash are held; stopped ones stay stopped after graceful shutdown.
  expect(h.core.journal.getTurn(turn.id)?.status).toBe('stopped');
});

test('an archived project holds a queue even when its thread remains unarchived', async () => {
  h = await startTestCore();
  const a = await h.connect();
  const { threadId } = await echoThread(h, a);
  const projectId = h.core.threads.require(threadId).projectId!;
  await a.call('projects.archive', { projectId });
  await a.call('composer.put', { section: 'inputs', id: threadId, expectedRevision: 0, value: { input: { ...value().input, queued: [{ id: 'project-archived', text: 'wait for restore', attachments: [] }] } } });
  await Bun.sleep(30);
  expect(h.core.journal.listTurns(threadId)).toHaveLength(0);
  await a.call('projects.archive', { projectId, archived: false });
  await waitFor(() => h.core.journal.listTurns(threadId).some(turn => turn.status === 'done'));
});

import { afterEach, expect, test } from 'bun:test';
import { RpcErrorCode, type ComposerValue } from '@boite/contracts';
import { echoThread, holdAccountTurns, startTestCore, waitFor, type TestCore } from './harness.ts';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { forgetProbes, setDriver } from '../src/drivers/index.ts';
import { echoDriver } from '../src/drivers/echo.ts';
import { ModelProbes } from '../src/drivers/model-probes.ts';
import { makeAgent } from './agent-fixture.ts';
import type { TurnContext, TurnResult } from '../src/drivers/types.ts';
import { rejection, thrown } from './settle.ts';
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
  expect(h.core.journal.db.query('SELECT count(*) AS n FROM composer_assets').get()).toEqual({ n: 1 });
  await h.stop(); h = await startTestCore({ dataDir: restartDir });
  const b = await h.connect();
  expect(await b.call('composer.asset.get', asset)).toEqual(attachment);
  expect(await b.call('composer.asset.put', { attachment })).toEqual(asset);
  expect(h.core.journal.db.query('SELECT count(*) AS n FROM composer_assets').get()).toEqual({ n: 1 });
});

test('an offline first prompt creates one thread, transfers its queue and retains unsent draft text', async () => {
  restartDir = mkdtempSync(join(tmpdir(), 'composer-draft-delete-'));
  h = await startTestCore({ dataDir: restartDir });
  const a = await h.connect();
  const project = await a.call('projects.add', { path: h.dataDir });
  const account = (await a.call('accounts.list', {})).find(account => account.providerId === 'echo')!;
  const selected = { providerId: 'echo', accountId: account.id, model: null, effort: null, permissionMode: 'default' as const };
  const first = await a.call('composer.put', { section: 'drafts', id: 'offline-draft', expectedRevision: 0, value: { ...value('still being typed'), choice: selected, draft: { projectId: project.id, worktree: false }, input: { ...value('still being typed').input, queued: [{ id: 'offline-first', text: 'start from the offline queue', attachments: [] }, { id: 'offline-followup', text: 'follow up in that conversation', attachments: [] }] } } });
  const cached = structuredClone(first.record.value);
  a.close();
  await waitFor(() => h.core.journal.listThreads().some(thread => h.core.journal.listTurns(thread.id).some(turn => turn.status === 'done')));
  expect(h.core.journal.listThreads()).toHaveLength(1);
  const firstThreadId = h.core.journal.listThreads()[0]!.id;
  await waitFor(() => h.core.composer.storage.get('inputs', firstThreadId).value?.input.queued.length === 0);
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
  await b.call('threads.remove', { threadId: firstThreadId });
  h.core.journal.db.query('UPDATE thread_deletions SET deleted_at = 0 WHERE thread_id = ?').run(firstThreadId);
  h.core.threads.purgeDeleted();
  const current = h.core.composer.storage.get('drafts', retained.id);
  await b.call('composer.put', { section: 'drafts', id: retained.id, expectedRevision: current.revision, value: cached });
  await waitFor(() => h.core.journal.listThreads().length > 1 || h.core.composer.storage.get('drafts', retained.id).value?.input.paused === true);
  expect(h.core.journal.listThreads()).toHaveLength(1);
  expect(h.core.composer.storage.get('drafts', retained.id).value?.input.queued.map(item => item.id)).toEqual(['offline-first', 'offline-followup']);
  expect(h.core.journal.db.query("SELECT section, status, thread_id, fingerprint FROM composer_deliveries WHERE section = 'drafts' AND thread_id IS NULL").all()).toEqual([{ section: 'drafts', status: 'delivered', thread_id: null, fingerprint: '' }]);
  await h.stop(); h = await startTestCore({ dataDir: restartDir });
  const c = await h.connect(), restarted = h.core.composer.storage.get('drafts', retained.id);
  await c.call('composer.put', { section: 'drafts', id: retained.id, expectedRevision: restarted.revision, value: cached });
  await waitFor(() => h.core.composer.storage.get('drafts', retained.id).value?.input.paused === true);
  expect(h.core.journal.listThreads()).toHaveLength(1);
  await c.call('projects.remove', { projectId: project.id });
  expect(h.core.journal.db.query('SELECT section, status, thread_id, fingerprint FROM composer_deliveries').all()).toEqual([
    { section: 'drafts', status: 'delivered', thread_id: null, fingerprint: '' },
    { section: 'drafts', status: 'delivered', thread_id: null, fingerprint: '' },
  ]);
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

function scripted(steer?: (text: string) => Promise<boolean>, livePermissions?: () => Promise<boolean>) {
  let context!: TurnContext, finish!: (result: TurnResult) => void;
  restore = setDriver('echo', { protocol: 'echo', startTurn(ctx) {
    context = ctx;
    return { done: new Promise(resolve => { finish = resolve; }), stop() { finish({ status: 'stopped', sessionId: null, usage: null }); }, ...(steer ? { steer } : {}), ...(livePermissions ? { setPermissionMode: livePermissions } : {}) };
  } });
  return { context: () => context, finish: () => finish({ status: 'done', sessionId: null, usage: null }) };
}

test('steering waits for a tool boundary, locks only the captured item and preserves new typing', async () => {
  h = await startTestCore();
  const a = await connect(h.url, h.token, { client: { name: 'pwa', version: '0', device: 'phone' } });
  await a.call('client.preferences', { app: 'steering-origin', language: 'fr', experiments: [], labels: {} });
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
  expect(h.core.journal.listMessages(threadId).find(message => message.role === 'user' && message.parts[0]?.type === 'text' && message.parts[0].text === 'do this next')?.parts[0]).toMatchObject({ sentFrom: { client: 'pwa', device: 'phone', language: 'fr' } });
  const second = { ...current.value!, input: { ...current.value!.input, queued: [{ id: 'new-boundary-follow-up', text: 'wait for the next boundary', attachments: [] }] } };
  await a.call('composer.put', { section: 'inputs', id: threadId, expectedRevision: current.revision, value: second });
  await Bun.sleep(30);
  expect(inputs).toHaveLength(1);
  driver.context().emit.part(message, 1, { type: 'tool', toolId: 'read-2', name: 'Read', input: {}, output: 'ok', status: 'done' });
  await waitFor(() => inputs.length === 2); accept(true);
  await waitFor(() => h.core.composer.storage.get('inputs', threadId).value?.input.queued.length === 0);
  current = h.core.composer.storage.get('inputs', threadId);
  const forced = { ...current.value!, input: { ...current.value!.input, paused: true, queued: [{ id: 'forced-after-pause', text: 'send once unpaused', attachments: [] }] } };
  const paused = await a.call('composer.put', { section: 'inputs', id: threadId, expectedRevision: current.revision, sendNow: true, value: forced });
  await Bun.sleep(30); expect(inputs).toHaveLength(2);
  forced.input.paused = false;
  await a.call('composer.put', { section: 'inputs', id: threadId, expectedRevision: paused.record.revision, value: forced });
  await waitFor(() => inputs.length === 3); accept(true);
  await waitFor(() => h.core.composer.storage.get('inputs', threadId).value?.input.queued.length === 0);
  a.close();
});

test.each(['preparing', 'native'] as const)('Send now during %s startup reaches the running turn without a tool boundary', async phase => {
  h = await startTestCore();
  const owner = await h.connect();
  const { threadId } = await echoThread(h, owner);
  const inputs: string[] = [];
  let ready = false, attempts = 0;
  const driver = scripted(async text => { attempts++; if (!ready) return false; inputs.push(text); return true; });
  const execution = h.core.sharedAccess.execution, prepare = execution.prepare;
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let calls = 0;
  execution.prepare = function(id) {
    if (phase === 'preparing' && id === threadId && ++calls === 2) { entered.resolve(); return release.promise; }
    return prepare.call(this, id);
  };
  try {
    const turn = await owner.call('turns.start', { threadId, prompt: 'keep working' });
    if (phase === 'preparing') await entered.promise;
    else await waitFor(() => h.core.threads.runner.handles.has(threadId));
    expect(h.core.threads.progress.get(threadId)?.phase).toBe('starting');
    await owner.call('composer.put', { section: 'inputs', id: threadId, expectedRevision: 0, sendNow: true,
      value: { input: { ...value('').input, queued: [{ id: 'startup-followup', text: 'also check the bots', attachments: [] }] } } });
    if (phase === 'native') await waitFor(() => attempts > 0);
    expect(inputs).toEqual([]);
    ready = true;
    release.resolve();
    await waitFor(() => h.core.threads.runner.handles.has(threadId));
    // The native turn can accept input before it emits any model output.
    if (phase === 'native') driver.context().inputReady?.();
    await waitFor(() => inputs.length > 0);
    expect(inputs).toEqual(['also check the bots']);
    await waitFor(() => h.core.composer.storage.get('inputs', threadId).value?.input.queued.length === 0);
    expect(h.core.journal.listTurns(threadId)).toHaveLength(1);
    expect(h.core.journal.listMessages(threadId).filter(message => message.role === 'user')).toHaveLength(2);
    expect(h.core.journal.getTurn(turn.id)?.status).toBe('running');
    driver.context().emit.part(driver.context().emit.startMessage('assistant'), 0, { type: 'text', text: 'Checking both.' });
    await Bun.sleep(20);
    expect(inputs).toEqual(['also check the bots']);
    driver.finish();
  } finally { release.resolve(); execution.prepare = prepare; }
});

test('a queued prompt steers after the running turn accepts a live permission mode change', async () => {
  h = await startTestCore();
  const owner = await h.connect();
  const { threadId } = await echoThread(h, owner);
  const thread = h.core.threads.require(threadId);
  const choice = { providerId: thread.providerId, accountId: thread.accountId, model: thread.model, effort: thread.effort, speed: thread.speed ?? null, permissionMode: thread.permissionMode };
  const inputs: string[] = [];
  const applied = Promise.withResolvers<boolean>();
  let called = false;
  const driver = scripted(async text => { inputs.push(text); return true; }, () => { called = true; return applied.promise; });
  const turn = await owner.call('turns.start', { threadId, prompt: 'keep working' });
  await waitFor(() => h.core.threads.runner.handles.has(threadId));
  await owner.call('composer.put', { section: 'inputs', id: threadId, expectedRevision: 0, value: { input: { ...value('').input, queued: [{ id: 'live-mode-followup', text: 'follow up under live permissions', attachments: [], choice }] } } });
  await owner.call('threads.update', { threadId, permissionMode: 'yolo' });
  await waitFor(() => called);
  const message = driver.context().emit.startMessage('assistant');
  driver.context().emit.part(message, 0, { type: 'tool', toolId: 'mode-read', name: 'Read', input: {}, output: 'ok', status: 'done' });
  await Bun.sleep(30);
  expect(inputs).toEqual([]); // The native mode setter has not accepted yet.
  applied.resolve(true);
  await waitFor(() => h.core.journal.getTurn(turn.id)?.execution?.permissionMode === 'yolo');
  await Bun.sleep(30);
  expect(inputs).toEqual(['follow up under live permissions']);
  await waitFor(() => h.core.composer.storage.get('inputs', threadId).value?.input.queued.length === 0);
  expect(h.core.journal.listTurns(threadId)).toHaveLength(1);
  expect(h.core.journal.getTurn(turn.id)?.execution?.permissionMode).toBe('yolo');
  expect(h.core.journal.listMessages(threadId).find(message => message.parts.some(part => part.type === 'text' && part.text === 'follow up under live permissions'))?.turnId).toBe(turn.id);
  driver.finish();
});

test.each([
  ['preparing', false], ['queued', false], ['preparing', true], ['queued', true],
] as const)('a mode requested while %s reaches native startup and preserves an intervening account return=%s', async (phase, changedAccount) => {
  h = await startTestCore();
  const owner = await h.connect();
  const { threadId, accountId } = await echoThread(h, owner);
  const modes: string[] = [], inputs: string[] = [];
  let context!: TurnContext;
  const done = Promise.withResolvers<TurnResult>();
  restore = setDriver('echo', { protocol: 'echo', startTurn(ctx) {
    context = ctx; modes.push(ctx.thread.permissionMode);
    return { done: done.promise, stop() { done.resolve({ status: 'stopped', sessionId: null, usage: null }); },
      async steer(text) { inputs.push(text); return true; } };
  } });
  const execution = h.core.sharedAccess.execution, prepare = execution.prepare;
  const entered = Promise.withResolvers<void>(), ready = Promise.withResolvers<void>();
  let calls = 0, release = () => {};
  try {
    if (phase === 'queued') release = holdAccountTurns(h, accountId);
    else execution.prepare = function(id) {
      if (id === threadId && ++calls === 2) { entered.resolve(); return ready.promise; }
      return prepare.call(this, id);
    };
    const turn = await owner.call('turns.start', { threadId, prompt: 'keep working after admission and preparation' });
    if (phase === 'queued') expect(h.core.journal.getTurn(turn.id)?.status).toBe('queued');
    else await entered.promise;
    await owner.call('composer.put', { section: 'inputs', id: threadId, expectedRevision: 0, value: { input: { ...value('').input, queued: [{ id: 'startup-mode-followup', text: 'steer after the requested mode starts', attachments: [] }] } } });
    if (changedAccount) {
      const other = await owner.call('accounts.add', { providerId: 'echo', label: 'Intervening picker' });
      await owner.call('threads.update', { threadId, accountId: other.id });
      await owner.call('threads.update', { threadId, accountId, model: 'echo' });
    }
    await owner.call('threads.update', { threadId, permissionMode: 'plan' });
    release(); release = () => {}; ready.resolve();
    await waitFor(() => h.core.threads.runner.handles.has(threadId));
    expect(modes).toEqual(['plan']); // Captured at driver start, not read later from a mutable context.
    const message = context.emit.startMessage('assistant');
    context.emit.part(message, 0, { type: 'tool', toolId: 'startup-mode-read', name: 'Read', input: {}, output: 'ok', status: 'done' });
    await Bun.sleep(30);
    if (changedAccount) {
      expect(inputs).toEqual([]);
      expect(h.core.composer.storage.get('inputs', threadId).value?.input.queued.map(item => item.id)).toEqual(['startup-mode-followup']);
    } else {
      expect(inputs).toEqual(['steer after the requested mode starts']);
      expect(h.core.journal.getTurn(turn.id)?.execution?.selectionVersion).toBe(h.core.threads.require(threadId).selectionVersion);
      expect(h.core.journal.listTurns(threadId)).toHaveLength(1);
    }
  } finally { release(); ready.resolve(); execution.prepare = prepare; }
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

test('a permission-mode native restart keeps queued steering in the original turn', async () => {
  h = await startTestCore();
  const owner = await h.connect();
  const { threadId } = await echoThread(h, owner);
  const contexts: TurnContext[] = [], inputs: string[] = [];
  restore = setDriver('echo', { protocol: 'echo', startTurn(context) {
    contexts.push(context);
    const done = Promise.withResolvers<TurnResult>();
    return { done: done.promise, stop() { done.resolve({ status: 'stopped', sessionId: 'native-session', usage: null }); },
      async steer(text) { inputs.push(text); return true; } };
  } });
  const turn = await owner.call('turns.start', { threadId, prompt: 'keep working' });
  await waitFor(() => h.core.threads.runner.handles.has(threadId));
  await owner.call('composer.put', { section: 'inputs', id: threadId, expectedRevision: 0, value: { input: { ...value('').input, queued: [{ id: 'restarted-mode-followup', text: 'follow up after native restart', attachments: [] }] } } });
  await owner.call('threads.update', { threadId, permissionMode: 'yolo' });
  await waitFor(() => contexts.length === 2);
  expect(contexts[1]!.thread.permissionMode).toBe('yolo');
  const message = contexts[1]!.emit.startMessage('assistant');
  contexts[1]!.emit.part(message, 0, { type: 'tool', toolId: 'restart-mode-read', name: 'Read', input: {}, output: 'ok', status: 'done' });
  await waitFor(() => h.core.composer.storage.get('inputs', threadId).value?.input.queued.length === 0);
  expect(inputs).toEqual(['follow up after native restart']);
  expect(h.core.journal.listTurns(threadId)).toHaveLength(1);
  expect(h.core.journal.getTurn(turn.id)?.execution).toMatchObject({ permissionMode: 'yolo', selectionVersion: h.core.threads.require(threadId).selectionVersion });
  await owner.call('turns.stop', { threadId });
});

test.each(['before', 'during'] as const)('a live mode update never conceals an account change and return %s native confirmation', async timing => {
  h = await startTestCore();
  const owner = await h.connect();
  const { threadId, accountId } = await echoThread(h, owner);
  const accountB = await owner.call('accounts.add', { providerId: 'echo', label: 'Other selection' });
  const inputs: string[] = [];
  const applied = Promise.withResolvers<boolean>();
  let called = false;
  const driver = scripted(async text => { inputs.push(text); return true; }, () => { called = true; return applied.promise; });
  const turn = await owner.call('turns.start', { threadId, prompt: 'keep working' });
  await waitFor(() => h.core.threads.runner.handles.has(threadId));
  await owner.call('composer.put', { section: 'inputs', id: threadId, expectedRevision: 0, value: { input: { ...value('').input, queued: [{ id: 'selection-return-followup', text: 'must wait for the new selection', attachments: [] }] } } });
  const changeAndReturn = async () => {
    await owner.call('threads.update', { threadId, accountId: accountB.id });
    await owner.call('threads.update', { threadId, accountId, model: 'echo' });
  };
  if (timing === 'before') await changeAndReturn();
  await owner.call('threads.update', { threadId, permissionMode: 'yolo' });
  await waitFor(() => called);
  if (timing === 'during') await changeAndReturn();
  applied.resolve(true);
  await waitFor(() => h.core.journal.getTurn(turn.id)?.execution?.permissionMode === 'yolo');
  const message = driver.context().emit.startMessage('assistant');
  driver.context().emit.part(message, 0, { type: 'tool', toolId: 'selection-return', name: 'Read', input: {}, output: 'ok', status: 'done' });
  await Bun.sleep(30);
  expect(inputs).toEqual([]);
  expect(h.core.composer.storage.get('inputs', threadId).value?.input.queued.map(item => item.id)).toEqual(['selection-return-followup']);
  await owner.call('turns.stop', { threadId });
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

test.each([['took it', true], ['never got it', false]] as const)('a prompt an app sent before it died and queues again on restart reaches the thread once when the core %s', async (_case, took) => {
  h = await startTestCore();
  const a = await h.connect();
  const { threadId } = await echoThread(h, a);
  const image = { kind: 'image' as const, mimeType: 'image/png' as const, name: 'shot.png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' };
  const prompt = 'every problem at once, with its screenshot';
  const requestId = `resume-${took ? 'taken' : 'lost'}-request`;
  if (took) {
    await a.call('turns.start', { threadId, prompt, attachments: [image], clientRequestId: requestId });
    await waitFor(() => h.core.journal.listTurns(threadId).some(turn => turn.status === 'done'));
  }
  // The restarted app's journal: the prompt as it left, under the request id it went out with.
  const asset = await a.call('composer.asset.put', { attachment: image });
  await a.call('composer.put', { section: 'inputs', id: threadId, expectedRevision: 0, value: { input: { ...value().input, text: '', queued: [{ id: requestId, text: prompt, attachments: [{ kind: image.kind, mimeType: image.mimeType, name: image.name, assetId: asset.assetId }], request: { id: requestId, choice: null, queuedAt: Date.now(), sent: true } }] } } });
  await waitFor(() => h.core.composer.storage.get('inputs', threadId).value?.input.queued.length !== 1 || h.core.composer.storage.get('inputs', threadId).value?.input.paused === true);
  await waitFor(() => h.core.journal.listTurns(threadId).length > 0 && h.core.journal.listTurns(threadId).every(turn => turn.status === 'done') || h.core.composer.storage.get('inputs', threadId).value?.input.paused === true);
  expect(h.core.composer.storage.get('inputs', threadId).value?.input.paused ?? false).toBe(false);
  expect(h.core.composer.storage.get('inputs', threadId).value?.input.queued ?? []).toEqual([]);
  const sent = h.core.journal.listMessages(threadId).filter(message => message.role === 'user');
  expect(sent).toHaveLength(1);
  expect(sent[0]!.parts.filter(part => part.type === 'image')).toHaveLength(1);
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
  restartDir = mkdtempSync(join(tmpdir(), 'composer-delete-restart-'));
  h = await startTestCore({ dataDir: restartDir });
  const a = await h.connect();
  const { threadId } = await echoThread(h, a);
  const projectId = h.core.threads.require(threadId).projectId!;
  await a.call('composer.put', { section: 'inputs', id: threadId, expectedRevision: 0, value: { input: { ...value().input, queued: [{ id: 'before-archive', text: 'delivered before archive', attachments: [] }] } } });
  await waitFor(() => h.core.journal.listTurns(threadId).some(turn => turn.status === 'done'));
  await a.call('threads.archive', { threadId });
  const current = h.core.composer.storage.get('inputs', threadId);
  await a.call('composer.put', { section: 'inputs', id: threadId, expectedRevision: current.revision, value: { input: { ...value().input, queued: [{ id: 'archive-input', text: 'must wait', attachments: [] }] } } });
  await Bun.sleep(30);
  expect(h.core.journal.listTurns(threadId)).toHaveLength(1);
  await a.call('threads.remove', { threadId });
  await Bun.sleep(30);
  expect(h.core.journal.listTurns(threadId)).toHaveLength(1);
  // Soft deletion is undoable; hard deletion must erase unsent input and receipts.
  expect(h.core.composer.storage.get('inputs', threadId).value?.input.queued).toHaveLength(1);
  const offline = h.core.composer.storage.get('inputs', threadId);
  expect((await a.call('composer.put', { section: 'inputs', id: threadId, expectedRevision: offline.revision, value: offline.value })).accepted).toBe(true);
  await a.call('projects.remove', { projectId });
  expect((await a.call('composer.list', {})).some(record => record.section === 'inputs' && record.id === threadId)).toBe(false);
  expect(h.core.composer.storage.queued.has(JSON.stringify(['inputs', threadId]))).toBe(false);
  expect(h.core.journal.db.query('SELECT COUNT(*) AS n FROM composer_deliveries WHERE thread_id = ? OR record_id = ?').get(threadId, threadId)).toEqual({ n: 0 });
  const reconnected = await h.connect();
  for (const expectedRevision of [0, offline.revision]) {
    expect((await rejection(reconnected.call('composer.put', { section: 'inputs', id: threadId, expectedRevision, value: offline.value }))).reason).toMatchObject({ rpc: { code: RpcErrorCode.NotFound, data: { reason: 'thread-deleted', threadId, field: 'composer.id' } } });
  }
  expect((await a.call('composer.list', {})).some(record => record.id === threadId)).toBe(false);
  expect(h.core.composer.storage.queued.has(JSON.stringify(['inputs', threadId]))).toBe(false);
  await h.stop(); h = await startTestCore({ dataDir: restartDir });
  const afterRestart = await h.connect();
  for (const expectedRevision of [0, offline.revision]) {
    expect((await rejection(afterRestart.call('composer.put', { section: 'inputs', id: threadId, expectedRevision, value: offline.value }))).reason).toMatchObject({ rpc: { code: RpcErrorCode.NotFound, data: { reason: 'thread-deleted', threadId, field: 'composer.id' } } });
  }
  expect((await afterRestart.call('composer.list', {})).some(record => record.id === threadId)).toBe(false);
  expect(h.core.composer.storage.queued.has(JSON.stringify(['inputs', threadId]))).toBe(false);
});

test('the outbox and a direct start refuse an unusable queued selection with the same text', async () => {
  h = await startTestCore();
  const a = await h.connect();
  const { threadId, accountId } = await echoThread(h, a);
  const signedOut = await a.call('accounts.add', { providerId: 'echo', label: 'Signed out' });
  h.core.journal.putAccount({ ...h.core.accounts.require(signedOut.id), status: 'unauthenticated' });
  const other = h.core.providers.list().loaded.find(provider => provider.id !== 'echo')!;
  for (const [index, selection] of [{ providerId: 'echo', accountId: signedOut.id }, { providerId: other.id, accountId }].entries()) {
    const choice = { ...selection, model: null, effort: null, permissionMode: 'default' as const };
    let direct = '';
    try { h.core.threads.startTurn(threadId, 'direct', undefined, { choice }); } catch (error) { direct = (error as Error).message; }
    const current = h.core.composer.storage.get('inputs', threadId);
    await a.call('composer.put', { section: 'inputs', id: threadId, expectedRevision: current.revision, value: { input: { ...value().input, queued: [{ id: `refused-${index}`, text: 'queued', attachments: [], choice }] } } });
    await waitFor(() => h.core.composer.storage.get('inputs', threadId).value?.input.paused === true);
    expect(h.core.composer.storage.get('inputs', threadId).value?.input.queued[0]?.request?.failed).toBe(direct);
    expect(direct).toContain('account is unavailable');
  }
  expect(h.core.journal.listTurns(threadId)).toHaveLength(0);
});

test('queued input reaches a projectless persistent agent thread', async () => {
  h = await startTestCore();
  const a = await h.connect();
  const { threadId } = await makeAgent(h, a);
  expect(h.core.threads.require(threadId).projectId).toBeNull();
  const before = h.core.journal.listTurns(threadId).length;
  await a.call('composer.put', { section: 'inputs', id: threadId, expectedRevision: 0, value: { input: { ...value().input, queued: [{ id: 'projectless-input', text: 'user input for the bot', attachments: [] }] } } });
  await waitFor(() => h.core.journal.listTurns(threadId).length > before || h.core.composer.storage.get('inputs', threadId).value?.input.paused === true);
  expect(h.core.journal.listTurns(threadId)).toHaveLength(before + 1);
  await waitFor(() => h.core.journal.listTurns(threadId).at(-1)?.status === 'done');
  expect(h.core.composer.storage.get('inputs', threadId).value?.input.queued).toEqual([]);
});

test.each([['goal', 'supported'], ['loop', 'supported'], ['goal', 'unsupported'], ['loop', 'unsupported']] as const)('a captured %s discovers model-specific ACP effort after restart: %s', async (kind, support) => {
  const supported = support === 'supported';
  restartDir = mkdtempSync(join(tmpdir(), 'composer-activity-model-'));
  h = await startTestCore({ dataDir: restartDir });
  const a = await h.connect();
  const { threadId, accountId } = await echoThread(h, a);
  let detailed = false;
  const cache = new ModelProbes(async () => [{ id: 'discovered', name: 'Discovered', ...(detailed && supported ? { effort: { levels: [{ id: 'high', label: 'High' }] } } : {}) }]);
  const modelReads: string[] = [], executions: { model: string | null; effort: string | null }[] = [];
  restore = setDriver('acp', { ...echoDriver, protocol: 'acp', probe: ctx => {
    if (ctx.model) { modelReads.push(ctx.model); detailed = true; cache.forget({ providerId: ctx.provider.id, accountId: ctx.accountId }); }
    return cache.probe(ctx);
  }, probedModels: (providerId, account) => cache.models(providerId, account), forgetProbes: filter => cache.forget(filter), startTurn(ctx) {
    executions.push({ model: ctx.thread.model, effort: ctx.thread.effort });
    const message = ctx.emit.startMessage('assistant');
    ctx.emit.part(message, 0, { type: 'text', text: 'Done.\n[BOITE_GOAL_COMPLETE]' });
    ctx.emit.complete(message, 'complete');
    return { stop() {}, done: Promise.resolve({ status: 'done', sessionId: null, usage: null }) };
  } });
  h.core.providers.require('echo').protocol = 'acp';
  await a.call('providers.probe', { providerId: 'echo', accountId });
  const choice = { providerId: 'echo', accountId, model: 'discovered', effort: 'high', permissionMode: 'default' as const };
  h.core.activity.set({ threadId, ...(kind === 'goal' ? { goal: { objective: 'complete captured work' } } : { loop: { prompt: 'complete captured work', intervalMs: 1000, maxIterations: 1 } }) }, undefined, choice);
  h.core.activity.pauseAll(threadId);
  await h.stop();
  forgetProbes({ providerId: 'echo', accountId });
  h = await startTestCore({ dataDir: restartDir });
  h.core.providers.require('echo').protocol = 'acp';
  const b = await h.connect();
  await b.call('threads.activity.control', { threadId, kind, action: 'resume' });
  await waitFor(() => ['complete', 'paused'].includes(h.core.activity.get(threadId)[kind]?.status ?? ''), 2000);
  if (!supported) {
    expect(h.core.activity.get(threadId)[kind]).toMatchObject({ status: 'paused', error: expect.stringContaining('reasoning effort') });
    expect(executions).toEqual([]);
    expect(modelReads).toEqual(['discovered']);
    return;
  }
  expect(h.core.activity.get(threadId)[kind]).toMatchObject({ status: 'complete', error: null });
  expect(executions).toEqual([{ model: 'discovered', effort: 'high' }]);
  expect(modelReads).toEqual(['discovered']);
  expect(h.core.threads.require(threadId).model).toBe('echo');
  // The same cold model metadata is needed by ordinary input and draft launches.
  detailed = false;
  forgetProbes({ providerId: 'echo', accountId });
  const section = kind === 'goal' ? 'inputs' : 'drafts', id = section === 'inputs' ? threadId : 'model-specific-draft';
  await b.call('composer.put', { section, id, expectedRevision: 0, value: { choice, ...(section === 'drafts' ? { draft: { projectId: h.core.threads.require(threadId).projectId, worktree: false } } : {}), input: { ...value('').input, queued: [{ id: 'model-specific-input', text: 'use model-specific reasoning', attachments: [], choice }] } } });
  await waitFor(() => executions.length === 2 || h.core.composer.storage.get(section, id).value?.input.paused === true);
  expect(executions).toEqual([{ model: 'discovered', effort: 'high' }, { model: 'discovered', effort: 'high' }]);
  expect(modelReads).toEqual(['discovered', 'discovered']);
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
  restartDir = mkdtempSync(join(tmpdir(), 'composer-origin-'));
  h = await startTestCore({ dataDir: restartDir });
  const a = await connect(h.url, h.token, { client: { name: 'pwa', version: '0', device: 'browser' } });
  await a.call('client.preferences', { app: 'batch-origin', language: 'fr', experiments: [], labels: {} });
  const { threadId } = await echoThread(h, a);
  const queued = ['first', 'second'].map(text => ({ id: `batch-${text}`, text, attachments: [] }));
  h.core.composer.stop();
  const accepted = await a.call('composer.put', { section: 'inputs', id: threadId, expectedRevision: 0, value: { input: { ...value().input, queued } } });
  const b = await h.connect();
  await b.call('client.preferences', { app: 'batch-other', language: 'en', experiments: [], labels: {} });
  await b.call('composer.put', { section: 'inputs', id: threadId, expectedRevision: accepted.record.revision, value: accepted.record.value });
  a.close();
  await h.stop();
  h = await startTestCore({ dataDir: restartDir });
  await waitFor(() => h.core.journal.listTurns(threadId).some(turn => turn.status === 'done'));
  expect(h.core.journal.listTurns(threadId)).toHaveLength(1);
  expect(h.core.journal.listMessages(threadId).find(message => message.role === 'user')?.parts[0]).toEqual({ type: 'text', text: 'first\n\nsecond', sentFrom: { client: 'pwa', device: 'browser', language: 'fr' } });
  const current = h.core.composer.storage.get('inputs', threadId);
  const c = await h.connect();
  await c.call('composer.put', { section: 'inputs', id: threadId, expectedRevision: current.revision, value: { input: { ...value().input, queued } } });
  expect(h.core.composer.storage.get('inputs', threadId).value?.input.queued).toEqual([]);
});

test('prompts from different apps retain separate provenance when sharing a queue', async () => {
  h = await startTestCore();
  const a = await connect(h.url, h.token, { client: { name: 'pwa', version: '0', device: 'browser' } });
  const b = await connect(h.url, h.token, { client: { name: 'pwa', version: '0', device: 'phone' } });
  try {
    await a.call('client.preferences', { app: 'browser-origin', language: 'fr', experiments: [], labels: {} });
    await b.call('client.preferences', { app: 'phone-origin', language: 'en', experiments: [], labels: {} });
    const { threadId } = await echoThread(h, a);
    const first = await a.call('composer.put', { section: 'inputs', id: threadId, expectedRevision: 0, value: { input: { ...value('').input, paused: true, queued: [{ id: 'browser-prompt', text: 'from browser', attachments: [] }] } } });
    first.record.value!.input.queued.push({ id: 'phone-prompt', text: 'from phone', attachments: [] });
    first.record.value!.input.paused = false;
    await b.call('composer.put', { section: 'inputs', id: threadId, expectedRevision: first.record.revision, value: first.record.value });
    await waitFor(() => h.core.composer.storage.get('inputs', threadId).value?.input.queued.length === 0 && h.core.journal.listTurns(threadId).every(turn => turn.status === 'done'));
    expect(h.core.journal.listMessages(threadId).filter(message => message.role === 'user').map(message => message.parts[0])).toEqual([
      { type: 'text', text: 'from browser', sentFrom: { client: 'pwa', device: 'browser', language: 'fr' } },
      { type: 'text', text: 'from phone', sentFrom: { client: 'pwa', device: 'phone', language: 'en' } },
    ]);
  } finally { a.close(); b.close(); }
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
  await a.call('threads.update', { threadId, accountId: nextAccount.id, model: 'picker-model', effort: null, permissionMode: 'yolo' });
  h.core.journal.putThread({ ...h.core.threads.require(threadId), sessionId: 'picker-session', sessionResumeAt: 'picker-message' });
  const current = h.core.composer.storage.get('inputs', threadId);
  current.value!.input.paused = false;
  const driver = scripted();
  await a.call('composer.put', { section: 'inputs', id: threadId, expectedRevision: current.revision, value: current.value });
  await waitFor(() => h.core.threads.runner.handles.has(threadId));
  expect(driver.context().thread).toMatchObject({ accountId, model: 'captured-model', effort: 'high', permissionMode: 'yolo' });
  expect(driver.context().thread).toMatchObject({ sessionId: null, sessionResumeAt: null });
  expect(h.core.threads.require(threadId)).toMatchObject({ accountId: nextAccount.id, model: 'picker-model', effort: null, permissionMode: 'yolo' });
  driver.finish();
  await waitFor(() => h.core.journal.listTurns(threadId).some(turn => turn.status === 'done'));
  expect(h.core.threads.require(threadId)).toMatchObject({ accountId: nextAccount.id, model: 'picker-model', effort: null, permissionMode: 'yolo' });
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

test('a queued /goal2 stays a reviewed goal across a cold restart, its stale goal2 experiment id dropped', async () => {
  restartDir = mkdtempSync(join(tmpdir(), 'composer-goal2-'));
  h = await startTestCore({ dataDir: restartDir });
  const a = await h.connect();
  const { threadId } = await echoThread(h, a);
  h.core.composer.stop();
  // An older app still stamps the id of the experiment `/goal2` graduated from.
  await a.call('composer.put', { section: 'inputs', id: threadId, expectedRevision: 0, value: { input: { ...value('').input, queued: [{ id: 'reviewed', text: '/goal2 keep the review', attachments: [], experiments: ['goal2'] as never }] } } });
  a.close();
  await h.stop();
  h = await startTestCore({ dataDir: restartDir });
  await waitFor(() => h.core.activity.get(threadId).goal !== null || h.core.journal.listTurns(threadId).length > 0, 1000);
  expect(h.core.activity.get(threadId).goal).toMatchObject({ objective: 'keep the review', review: expect.any(Object) });
});

test('a missing project in a delivered receipt does not abort startup of another eligible queue', async () => {
  h = await startTestCore();
  const a = await h.connect();
  const { threadId } = await echoThread(h, a);
  const thread = h.core.threads.require(threadId);
  h.core.journal.putThread({ ...thread, id: 'orphan-thread', projectId: 'missing-project' });
  h.core.composer.storage.reserve({ id: 'orphan-receipt', section: 'inputs', record_id: 'orphan-thread', status: 'delivered', thread_id: 'orphan-thread', request_id: 'orphan-request', fingerprint: '' }, false);
  h.core.composer.storage.save('inputs', threadId, { input: { ...value('').input, queued: [{ id: 'eligible-startup-input', text: 'run despite the orphan', attachments: [], choice: { providerId: thread.providerId, accountId: thread.accountId, permissionMode: thread.permissionMode, model: thread.model, effort: thread.effort } }] } });
  expect(() => h.core.composer.start()).not.toThrow();
  await waitFor(() => h.core.journal.listTurns(threadId).some(turn => turn.status === 'done'));
  expect(h.core.composer.storage.get('inputs', threadId).value?.input.queued).toEqual([]);
});

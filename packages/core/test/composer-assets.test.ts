import { afterEach, expect, test } from 'bun:test';
import { echoThread, startTestCore, waitFor, type TestCore } from './harness.ts';
import { thrown } from './settle.ts';
import type { ComposerAttachment, ComposerValue } from '@boite/contracts';

let h: TestCore;
afterEach(async () => { await h?.stop(); });
const attachment = { kind: 'file' as const, mimeType: 'text/plain', name: 'notes.txt', data: 'aGVsbG8=' };
const value = (...attachments: ComposerAttachment[]): ComposerValue => ({ input: { text: '', attachments, queued: [], paused: false } });

test('asset collection preserves shared references and pending uploads through replacement, null saves and hard deletion', async () => {
  h = await startTestCore();
  const a = await h.connect(), b = await h.connect();
  const count = () => (h.core.journal.db.query('SELECT count(*) AS n FROM composer_assets').get() as { n: number }).n;
  const asset = await a.call('composer.asset.put', { attachment });
  await b.call('composer.asset.put', { attachment });
  const ref = { kind: attachment.kind, mimeType: attachment.mimeType, name: attachment.name, ...asset };
  const first = await a.call('composer.put', { section: 'drafts', id: 'first', expectedRevision: 0, value: value(ref) });
  await a.call('composer.put', { section: 'drafts', id: 'first', expectedRevision: first.record.revision, value: null });
  expect(count()).toBe(1); // b has uploaded the same bytes but has not saved its composer yet.
  const second = await b.call('composer.put', { section: 'drafts', id: 'second', expectedRevision: 0, value: { input: { ...value().input, paused: true, queued: [{ id: 'queued-file', text: 'keep its bytes', attachments: [ref] }] } } });
  const third = await b.call('composer.put', { section: 'drafts', id: 'third', expectedRevision: 0, value: value(ref) });
  await b.call('composer.put', { section: 'drafts', id: 'second', expectedRevision: second.record.revision, value: null });
  expect(count()).toBe(1);
  const next = await b.call('composer.asset.put', { attachment: { ...attachment, data: 'bmV4dA==' } });
  const replacement = { ...ref, ...next };
  const replaced = await b.call('composer.put', { section: 'drafts', id: 'third', expectedRevision: third.record.revision, value: value(replacement) });
  expect(count()).toBe(1); // The replaced asset has neither references nor pending owners.
  const one = await echoThread(h, b), two = await echoThread(h, b);
  await b.call('composer.put', { section: 'inputs', id: one.threadId, expectedRevision: 0, value: value(replacement) });
  await b.call('composer.put', { section: 'inputs', id: two.threadId, expectedRevision: 0, value: value(replacement) });
  await b.call('composer.put', { section: 'drafts', id: 'third', expectedRevision: replaced.record.revision, value: null });
  await b.call('threads.remove', { threadId: one.threadId });
  h.core.journal.db.query('UPDATE thread_deletions SET deleted_at = 0 WHERE thread_id = ?').run(one.threadId);
  h.core.threads.purgeDeleted();
  expect(count()).toBe(1); // The other conversation still references it.
  await a.call('composer.asset.put', { attachment: { ...attachment, data: 'bmV4dA==' } });
  await b.call('projects.remove', { projectId: h.core.threads.require(two.threadId).projectId! });
  expect(count()).toBe(1); // a's pending upload survives deletion of every saved reference.
  a.close();
  await waitFor(() => count() === 0, 1000);
  expect(count()).toBe(0);
  const last = await b.call('composer.asset.put', { attachment });
  const final = await b.call('composer.put', { section: 'drafts', id: 'final', expectedRevision: 0, value: value({ ...ref, ...last }) });
  await b.call('composer.put', { section: 'drafts', id: 'final', expectedRevision: final.record.revision, value: null });
  expect(count()).toBe(0);
});

test('private assets release removed references and disconnected ownership without touching another owner', async () => {
  h = await startTestCore();
  const a = await h.connect(), b = await h.connect();
  const upload = await a.call('composer.asset.put', { attachment, incognito: true });
  const pending = await a.call('composer.asset.put', { attachment: { ...attachment, data: 'cGVuZGluZw==' }, incognito: true });
  const other = await b.call('composer.asset.put', { attachment, incognito: true });
  const ref = { kind: attachment.kind, mimeType: attachment.mimeType, name: attachment.name, ...upload };
  const privateValue = (...refs: ComposerAttachment[]): ComposerValue => ({ ...value(...refs), draft: { projectId: null, worktree: false, incognito: true } });
  const first = await a.call('composer.put', { section: 'drafts', id: 'private-first', expectedRevision: 0, value: privateValue(ref) });
  const second = await a.call('composer.put', { section: 'drafts', id: 'private-second', expectedRevision: 0, value: privateValue(ref) });
  await a.call('composer.put', { section: 'drafts', id: 'private-first', expectedRevision: first.record.revision, value: privateValue() });
  expect(h.core.composer.storage.readAsset(upload.assetId)).toEqual(attachment);
  await a.call('composer.put', { section: 'drafts', id: 'private-second', expectedRevision: second.record.revision, value: null });
  expect(() => h.core.composer.storage.readAsset(upload.assetId)).toThrow('uploaded attachment');
  const used = await a.call('composer.asset.put', { attachment, incognito: true });
  const durable = await b.call('composer.asset.put', { attachment });
  const durableRef = { ...ref, ...durable };
  const saved = await b.call('composer.put', { section: 'drafts', id: 'durable-shared', expectedRevision: 0, value: value(durableRef) });
  const current = h.core.composer.storage.get('drafts', 'private-first');
  await a.call('composer.put', { section: 'drafts', id: current.id, expectedRevision: current.revision, value: privateValue({ ...ref, ...used }, durableRef) });
  await b.call('composer.put', { section: 'drafts', id: 'durable-shared', expectedRevision: saved.record.revision, value: null });
  expect(await a.call('composer.asset.get', durable)).toEqual(attachment);
  a.close();
  await waitFor(() => !h.core.composer.storage.list().some(record => record.id === current.id), 1000);
  expect(() => h.core.composer.storage.readAsset(used.assetId)).toThrow('uploaded attachment');
  expect(() => h.core.composer.storage.readAsset(pending.assetId)).toThrow('uploaded attachment');
  expect(() => h.core.composer.storage.readAsset(durable.assetId)).toThrow('uploaded attachment');
  expect(h.core.composer.storage.readAsset(other.assetId)).toEqual(attachment);
  expect(await thrown(b.call('composer.asset.get', other))).toThrow('referenced');
  b.close();
});

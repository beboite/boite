import { afterEach, expect, test, vi } from 'vitest';
import type { ComposerChoice, ComposerRecord, ComposerValue } from '@boite/contracts';
import { FakeClient } from './fake-client';

const clients: FakeClient[] = [];
afterEach(() => { for (const client of clients.splice(0)) client.close(); });
async function ready(delayMs = 0) {
  const client = new FakeClient({ delayMs });
  clients.push(client);
  await client.connect();
  return client;
}
const value = (text: string): ComposerValue => ({ input: { text, attachments: [], queued: [], paused: false } });

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

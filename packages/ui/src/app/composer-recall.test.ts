import { expect, vi } from 'vitest';
import type { Attachment } from '@boite/contracts';
import { store } from '../lib/store.svelte';
import { press, query, test, waitFor } from '../test/app';

for (const kind of ['file', 'image'] as const) test(`ArrowUp hydrates a light prompt before editing and sends its original ${kind} bytes`, async ({ app: _app }) => {
  await store.open('t-trace');
  const client = store.client!;
  const attachment: Attachment = { ...(kind === 'file' ? { kind, name: 'notes.txt', mimeType: 'text/plain' } : { kind, name: 'screen.png', mimeType: 'image/png' }), data: btoa('original notes'.repeat(800)) };
  await client.call('turns.start', { threadId: 't-trace', prompt: 'Recall with file', attachments: [attachment] });
  await waitFor(() => !store.busy);
  await store.open('t-trace');
  const message = store.openThread!.messages.findLast(row => row.role === 'user')!;
  const part = message.parts.find(part => part.type === kind)!;
  if (part.type !== 'file' && part.type !== 'image') throw new Error('missing attachment');
  part.data = ''; part.dataDeferred = true;
  const read = vi.spyOn(client, 'call');
  const input = query<HTMLTextAreaElement>('[data-testid=composer-input]');
  input.focus(); press('ArrowUp');
  await waitFor(() => store.composerStates['t-trace']?.editing === message.id);
  expect(store.composerStates['t-trace']!.attachments).toEqual([attachment]);
  expect(read.mock.calls.some(([method]) => method === 'messages.attachment')).toBe(true);
  query<HTMLButtonElement>('[data-testid=composer-send]').click();
  await waitFor(() => read.mock.calls.some(([method]) => method === 'threads.rewind'));
  await waitFor(() => !store.busy && !store.composerStates['t-trace']!.sending);
  const replacement = await client.call('threads.get', { threadId: 't-trace' });
  expect(replacement.messages.findLast(row => row.role === 'user')!.parts).toContainEqual({ type: kind, [kind === 'file' ? 'name' : 'alt']: attachment.name, mimeType: attachment.mimeType, data: attachment.data });
});

test('Send waits for the newest recall instead of rewinding the previous one', async ({ app: _app }) => {
  await store.open('t-trace');
  const client = store.client!;
  await client.call('turns.start', { threadId: 't-trace', prompt: 'Older with file', attachments: [{ kind: 'file', name: 'notes.txt', mimeType: 'text/plain', data: btoa('notes') }] });
  await waitFor(() => !store.busy);
  await client.call('turns.start', { threadId: 't-trace', prompt: 'Newest prompt' });
  await waitFor(() => !store.busy);
  await store.open('t-trace');
  const message = store.openThread!.messages.find(row => row.parts.some(part => part.type === 'text' && part.text === 'Older with file'))!;
  const part = message.parts.find(part => part.type === 'file')!;
  if (part.type !== 'file') throw new Error('missing file');
  part.data = ''; part.dataDeferred = true;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const call = client.call.bind(client);
  const read = vi.spyOn(client, 'call').mockImplementation(async (method, params) => {
    if (method === 'messages.attachment') await gate;
    return call(method, params);
  });
  const input = query<HTMLTextAreaElement>('[data-testid=composer-input]');
  input.focus(); press('ArrowUp');
  await waitFor(() => input.value === 'Newest prompt');
  press('ArrowUp');
  try {
    await waitFor(() => read.mock.calls.some(([method]) => method === 'messages.attachment'));
    expect(query<HTMLButtonElement>('[data-testid=composer-send]').disabled).toBe(true);
    expect(read.mock.calls.some(([method]) => method === 'threads.rewind')).toBe(false);
  } finally { release(); }
  await waitFor(() => input.value === 'Older with file');
  expect(query<HTMLButtonElement>('[data-testid=composer-send]').disabled).toBe(false);
});

for (const draft of [null, 'My replacement draft'] as const) test(`Escape cancels the first deferred recall: ${draft ? 'Send is free before the read finishes' : 'a late response cannot enter edit mode'}`, async ({ app: _app }) => {
  await store.open('t-trace');
  const client = store.client!;
  await client.call('turns.start', { threadId: 't-trace', prompt: 'Recall with a delayed file', attachments: [{ kind: 'file', name: 'notes.txt', mimeType: 'text/plain', data: btoa('notes') }] });
  await waitFor(() => !store.busy);
  await store.open('t-trace');
  const message = store.openThread!.messages.findLast(row => row.role === 'user')!;
  const part = message.parts.find(part => part.type === 'file')!;
  if (part.type !== 'file') throw new Error('missing file');
  part.data = ''; part.dataDeferred = true;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const call = client.call.bind(client);
  const read = vi.spyOn(client, 'call').mockImplementation(async (method, params) => {
    if (method === 'messages.attachment') await gate;
    return call(method, params);
  });
  const startEdit = vi.spyOn(store, 'startEdit');
  const input = query<HTMLTextAreaElement>('[data-testid=composer-input]');
  input.focus(); press('ArrowUp');
  try {
    await waitFor(() => read.mock.calls.some(([method]) => method === 'messages.attachment'));
    expect(store.composerStates['t-trace']?.editing).toBeFalsy();
    press('Escape');
    if (draft) {
      // A Store draft update does not send an input event that independently exits recall.
      store.restoreDraft('t-trace', draft, [], []);
      await waitFor(() => input.value === draft);
      expect(query<HTMLButtonElement>('[data-testid=composer-send]').disabled).toBe(false);
    }
  } finally { release(); }
  await waitFor(() => !part.dataDeferred);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(startEdit).not.toHaveBeenCalled();
  expect(store.composerStates['t-trace']?.editing).toBeFalsy();
  expect(input.value).toBe(draft ?? '');
  expect(read.mock.calls.some(([method]) => method === 'threads.rewind')).toBe(false);
});

test('sending an edit with a missing provider reports why and preserves the draft and history', async ({ app: _app }) => {
  await store.open('t-trace');
  const message = store.openThread!.messages.find(row => row.role === 'user')!;
  message.parts.push({ type: 'file', name: 'notes.txt', mimeType: 'text/plain', data: btoa('keep my attachment') });
  store.startEdit('t-trace', message);
  const state = store.composerStates['t-trace']!;
  const before = { text: state.text, attachments: [...state.attachments], editing: state.editing };
  const history = store.openThread!.messages.map(row => row.id);
  const read = vi.spyOn(store.client!, 'call');
  const stage = vi.spyOn(store, 'stageSend');
  store.providers = store.providers.filter(provider => provider.id !== store.openThread!.providerId);
  store.error = null;
  await waitFor(() => !query<HTMLButtonElement>('[data-testid=composer-send]').disabled);
  query<HTMLButtonElement>('[data-testid=composer-send]').click();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(store.error).toBe("This thread's provider is unavailable. Reconnect it before editing a sent message.");
  expect({ text: state.text, attachments: state.attachments, editing: state.editing }).toEqual(before);
  expect(store.openThread!.messages.map(row => row.id)).toEqual(history);
  expect(stage).not.toHaveBeenCalled();
  expect(read.mock.calls.some(([method]) => method === 'threads.rewind' || method === 'turns.start')).toBe(false);
});

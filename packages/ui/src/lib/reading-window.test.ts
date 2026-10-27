import { expect, vi } from 'vitest';
import { test } from '../test/fake-client';
import { editWhole } from './reading-window';
import { rewindComposerEdit } from './composer-edit';

for (const change of ['navigation', 'typing', 'overlapping edit'] as const) test(`an attachment hydration cannot overwrite ${change}`, async ({ ready }) => {
  const { store } = await ready();
  await store.open('t-trace');
  const message = store.openThread!.messages.find(row => row.role === 'user')!;
  let finish!: (loaded: boolean) => void;
  vi.spyOn(store, 'loadAttachments').mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  store.restoreDraft('t-trace', '', [], []);
  const loading = editWhole(store, 't-trace', message);
  if (change === 'navigation') await store.open('t-bench');
  else if (change === 'typing') store.editComposerText('t-trace', 'my new draft');
  else await editWhole(store, 't-trace', { ...message, id: 'newer-edit', parts: [{ type: 'text', text: 'newer prompt' }] });
  finish(true);
  expect(await loading).toBe(false);
  expect(store.composerStates['t-trace']!.text).toBe(change === 'navigation' ? '' : change === 'typing' ? 'my new draft' : 'newer prompt');
});

for (const invalid of ['attachment bytes', 'page mention'] as const) test(`invalid edited ${invalid} fail before staging or destructive rewind`, async ({ ready }) => {
  const { store } = await ready();
  await store.open('t-trace');
  const message = store.openThread!.messages.find(row => row.role === 'user')!;
  store.startEdit('t-trace', message);
  const state = store.composerStates['t-trace']!;
  if (invalid === 'attachment bytes') state.attachments = [{ kind: 'image', mimeType: 'image/png', name: 'broken.png', data: '' }];
  else state.previewReferences = [{ id: 'page', url: 'https://example.test', selector: 'h1', text: 'Heading', bounds: { x: 0, y: 0, width: 1, height: 1 }, mention: { start: 500, end: 510 } }];
  const rewind = vi.spyOn(store, 'rewind');
  const stage = vi.spyOn(store, 'stageSend');
  expect(await rewindComposerEdit(store, 't-trace', state, state.text, state.attachments, state.previewReferences ?? [])).toBe(false);
  expect(rewind).not.toHaveBeenCalled();
  expect(stage).not.toHaveBeenCalled();
  expect(state.editing).toBe(message.id);
});

test('a hydrated edit preserves deliberately removed attachments through rewind', async ({ ready }) => {
  const { store, client } = await ready();
  await client.call('turns.start', { threadId: 't-trace', prompt: 'with image', attachments: [{ kind: 'image', mimeType: 'image/png', name: 'shot.png', data: 'AAAA' }] });
  await client.settled(); await store.open('t-trace');
  const message = store.openThread!.messages.findLast(row => row.role === 'user')!;
  expect(await editWhole(store, 't-trace', message)).toBe(true);
  const state = store.composerStates['t-trace']!;
  state.attachments = [];
  const outgoing = state.attachments;
  expect(await rewindComposerEdit(store, 't-trace', state, 'edited without image', outgoing, [])).not.toBe(false);
  expect(await store.send('edited without image', 't-trace', outgoing, [])).toBe(true);
  await client.settled();
  const replacement = await client.call('threads.get', { threadId: 't-trace' });
  expect(replacement.messages.findLast(row => row.role === 'user')!.parts).toEqual([{ type: 'text', text: 'edited without image' }]);
});

test('a failed deferred attachment load keeps history and the draft intact', async ({ ready }) => {
  const { store, client } = await ready();
  await store.open('t-trace');
  store.restoreDraft('t-trace', 'keep my draft', [], []);
  const message = store.openThread!.messages.find(row => row.role === 'user')!;
  message.parts.push({ type: 'file', mimeType: 'text/plain', name: 'lost.txt', data: '', dataDeferred: true, bytes: 12 });
  const call = client.call.bind(client);
  vi.spyOn(client, 'call').mockImplementation((method, params) => method === 'messages.attachment'
    ? Promise.reject(new Error('Attachment read failed')) : call(method, params));
  const rewind = vi.spyOn(store, 'rewind');
  const before = store.openThread!.messages.map(row => row.id);
  expect(await editWhole(store, 't-trace', message)).toBe(false);
  expect(store.composerStates['t-trace']!.text).toBe('keep my draft');
  expect(store.openThread!.messages.map(row => row.id)).toEqual(before);
  expect(rewind).not.toHaveBeenCalled();
  expect(store.error).toBe('Attachment read failed');
});


test('an edit cancelled by navigation stays silent and preserves its draft', async ({ ready }) => {
  const { store } = await ready();
  await store.open('t-trace');
  const message = store.openThread!.messages.find(row => row.role === 'user')!;
  store.startEdit('t-trace', message);
  const state = store.composerStates['t-trace']!;
  const before = { text: state.text, attachments: [...state.attachments], editing: state.editing };
  await store.open('t-bench');
  store.error = null;
  const rewind = vi.spyOn(store, 'rewind');
  const stage = vi.spyOn(store, 'stageSend');
  expect(await rewindComposerEdit(store, 't-trace', state, state.text, state.attachments, [])).toBe(false);
  expect(store.error).toBeNull();
  expect({ text: state.text, attachments: state.attachments, editing: state.editing }).toEqual(before);
  expect(rewind).not.toHaveBeenCalled();
  expect(stage).not.toHaveBeenCalled();
});

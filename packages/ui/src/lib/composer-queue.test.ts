import { expect, test, vi } from 'vitest';
import { ATTACHMENTS_PER_TURN } from '@boite/contracts';
import type { Store } from './store.svelte';
import { drainQueue, type ComposerState } from './composer-queue';

const attachment = { kind: 'file' as const, name: 'note.txt', mimeType: 'text/plain', data: 'YQ==' };
const reference = { id: 'save', url: 'https://example.test', selector: '#save', text: 'Save', bounds: { x: 0, y: 0, width: 80, height: 30 }, mention: { start: 0, end: 5 } };
const state = (): ComposerState => ({ text: '', attachments: [], sending: false, paused: false, queued: [
  { text: '@Save first', attachments: [attachment], previewReferences: [reference] },
  { text: '@Save second', attachments: [], previewReferences: [reference] },
  { text: 'third', attachments: [] }
] });

test('one batch carries every attachment and mention, while new arrivals wait for the next turn', async () => {
  const draft = state();
  let finish!: (accepted: boolean) => void;
  const send = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; }));
  const store = { send } as unknown as Store;
  const sending = drainQueue(store, 'thread', draft);
  draft.queued.push({ text: 'arrived during send', attachments: [] });
  await drainQueue(store, 'thread', draft);
  expect(send).toHaveBeenCalledTimes(1);
  const args = send.mock.calls[0] as unknown as [string, string, unknown[], typeof reference[]];
  expect(args.slice(0, 3)).toEqual(['@Save first\n\n@Save second\n\nthird', 'thread', [attachment]]);
  expect(args[3].map(ref => ref.mention)).toEqual([{ start: 0, end: 5 }, { start: 13, end: 18 }]);
  expect(new Set(args[3].map(ref => ref.id)).size).toBe(2);
  finish(true); await sending;
  expect(draft.queued.map(entry => entry.text)).toEqual(['arrived during send']);
  expect(draft.sending).toBe(false);
});

test('a refused batch restores separate prompts and their files before later arrivals', async () => {
  const draft = state();
  const original = [...draft.queued];
  const send = vi.fn(async () => { draft.queued.push({ text: 'later', attachments: [] }); return false; });
  await drainQueue({ send } as unknown as Store, 'thread', draft);
  expect(draft.queued.slice(0, 3)).toEqual(original);
  expect(draft.queued[3]?.text).toBe('later');
  expect(draft.paused).toBe(true);
  expect(draft.sending).toBe(false);
});

test('goals and loops keep their own queue entries and cannot consume neighboring prompts', async () => {
  const draft = state();
  draft.queued.splice(1, 0, { text: '/goal Fix the parser', attachments: [] }, { text: '/loop 2 Check the output', attachments: [] });
  const send = vi.fn<Store['send']>(async () => true);
  const store = { send } as unknown as Store;
  await drainQueue(store, 'thread', draft);
  expect(send.mock.calls[0]?.[0]).toBe('@Save first');
  expect(draft.queued.map(entry => entry.text)).toEqual(['/goal Fix the parser', '/loop 2 Check the output', '@Save second', 'third']);
  await drainQueue(store, 'thread', draft);
  expect(send.mock.calls[1]?.[0]).toBe('/goal Fix the parser');
  await drainQueue(store, 'thread', draft);
  expect(send.mock.calls[2]?.[0]).toBe('/loop 2 Check the output');
  await drainQueue(store, 'thread', draft);
  expect(send.mock.calls[3]?.[0]).toBe('@Save second\n\nthird');
  expect(draft.queued).toEqual([]);
});

test('individually valid files stay split across turns when their combined count exceeds the turn limit', async () => {
  const draft = state();
  draft.queued = Array.from({ length: ATTACHMENTS_PER_TURN + 1 }, (_, index) => ({ text: `file ${index}`, attachments: [attachment] }));
  const send = vi.fn<Store['send']>(async () => true);
  await drainQueue({ send } as unknown as Store, 'thread', draft);
  expect(send.mock.calls[0]?.[2]).toHaveLength(ATTACHMENTS_PER_TURN);
  expect(draft.queued.map(entry => entry.text)).toEqual([`file ${ATTACHMENTS_PER_TURN}`]);
  await drainQueue({ send } as unknown as Store, 'thread', draft);
  expect(send.mock.calls[1]?.[2]).toHaveLength(1);
  expect(draft.queued).toEqual([]);
});

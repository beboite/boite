import { expect, test, vi } from 'vitest';
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

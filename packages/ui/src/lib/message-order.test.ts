import { expect, test } from 'vitest';
import type { Message } from '@boite/contracts';
import { filesLast, keepaliveRun, publishedFile, quietKeepalives } from './message-order';
import { placeViews } from './inline-view';

function message(id: string, turnId: string, kind: 'text' | 'file' | 'artifact' | 'view' = 'text', role: Message['role'] = 'assistant'): Message {
  const part: Message['parts'][number] = kind === 'file' ? { type: 'file', name: `${id}.png`, mimeType: 'image/png', data: '' }
    : kind === 'artifact' ? { type: 'artifact', id, name: `${id}.mp4`, mimeType: 'video/mp4', bytes: 9 }
    : kind === 'view' ? { type: 'artifact', id, name: `${id}.html`, mimeType: 'text/html', bytes: 9, view: { title: id, source: `${id}.html`, height: 100 } }
    : { type: 'text', text: id };
  return { id, threadId: 't', turnId, role, state: 'complete', createdAt: 0, parts: [part] };
}
const ids = (messages: readonly Message[]) => messages.map((entry) => entry.id);

test('a finished turn shows its published files after its answer, in publish order, and its pages after them', () => {
  const timeline = [
    message('ask', 'a', 'text', 'user'), message('shot', 'a', 'file'), message('page', 'a', 'view'), message('answer', 'a'),
    message('video', 'a', 'artifact'), message('more', 'a'),
    message('ask-2', 'b', 'text', 'user'), message('only', 'b', 'file')
  ];
  const turns = [{ id: 'a', status: 'done' as const }, { id: 'b', status: 'done' as const }];
  const files = filesLast(timeline, turns);
  expect(ids(files)).toEqual(['ask', 'page', 'answer', 'more', 'shot', 'video', 'ask-2', 'only']);
  expect(filesLast(files, turns)).toBe(files);
  expect(ids(placeViews(files, turns))).toEqual(['ask', 'answer', 'more', 'shot', 'video', 'page', 'ask-2', 'only']);
});

test('a running turn shows each file where it came, and a user upload or a page is no published file', () => {
  const timeline = [message('ask', 'a', 'text', 'user'), message('shot', 'a', 'file'), message('answer', 'a')];
  expect(filesLast(timeline, [{ id: 'a', status: 'running' }])).toBe(timeline);
  expect(publishedFile(message('upload', 'a', 'file', 'user'))).toBe(false);
  expect(publishedFile(message('page', 'a', 'view'))).toBe(false);
});

test('each cache ping is its opening line, and pings in a row leave one line that counts them', () => {
  const turn = (id: string, queuedAt: number, ping = false) => ({ id, queuedAt, ...(ping ? { execution: { operation: 'keepalive' as const } } : {}) }) as Parameters<typeof keepaliveRun>[0][number];
  // Out of order, as a store merge may leave them: queue time decides.
  const turns = [turn('p3', 5, true), turn('b', 4), turn('p2', 3, true), turn('a', 1), turn('p1', 2, true)];
  const timeline = [
    message('u1', 'a', 'text', 'user'), message('a1', 'a'),
    message('s1', 'p1', 'text', 'system'), message('o1', 'p1'),
    message('s2', 'p2', 'text', 'system'), message('o2', 'p2'),
    message('u2', 'b', 'text', 'user'),
    message('s3', 'p3', 'text', 'system'), message('o3', 'p3'),
  ];
  expect(quietKeepalives(timeline, turns).map(row => row.id)).toEqual(['u1', 'a1', 's2', 'u2', 's3']);
  expect([keepaliveRun(turns, 'p2'), keepaliveRun(turns, 'p3'), keepaliveRun(turns, 'a')]).toEqual([2, 1, 1]);
  // No ping: the same array.
  expect(quietKeepalives(timeline, [turn('a', 1)])).toBe(timeline);
});
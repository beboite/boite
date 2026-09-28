import { expect, test } from 'vitest';
import type { Message } from '@boite/contracts';
import { findHits, findRanges } from './find';

const message = (id: string, role: Message['role'], parts: Message['parts']) =>
  ({ id, threadId: 't-1', turnId: 'u-1', role, parts, createdAt: 0 }) as Message;

test('every occurrence counts, without case, oldest message first, and tool cards are not searched', () => {
  const messages = [
    message('m-1', 'user', [{ type: 'text', text: 'Fix the Parser' }]),
    message('m-2', 'assistant', [
      { type: 'text', text: 'The parser now reads parser files.' },
      { type: 'tool', toolId: 'k-1', name: 'Read', input: { path: 'parser.ts' }, status: 'done' } as never
    ])
  ];
  expect(findHits(messages, 'parser')).toEqual([
    { messageId: 'm-1', nth: 0 },
    { messageId: 'm-2', nth: 0 },
    { messageId: 'm-2', nth: 1 }
  ]);
  expect(findHits(messages, '  ')).toEqual([]);
  expect(findHits(messages, 'lexer')).toEqual([]);
});

test('a hidden goal marker is not a match', () => {
  const messages = [message('m-1', 'assistant', [{ type: 'text', text: 'Done.\n[BOITE_GOAL_COMPLETE]\n' }])];
  expect(findHits(messages, 'goal')).toEqual([]);
});

test('the drawn ranges follow reading order across elements, one per occurrence', () => {
  const root = document.createElement('div');
  root.innerHTML = '<p>aa <b>AA</b></p><p>xaax</p>';
  const ranges = findRanges(root, 'aa');
  expect(ranges.map((range) => range.toString())).toEqual(['aa', 'AA', 'aa']);
  expect(ranges[1]!.startContainer.parentElement?.tagName).toBe('B');
  expect(findRanges(root, '')).toEqual([]);
});

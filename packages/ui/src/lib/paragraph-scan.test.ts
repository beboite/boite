import { expect, test } from 'vitest';
import { ParagraphScan, paragraphBlocks, visibleAnswer } from './message-display';

const PIECES = ['word ', 'two words ', '\n', '\n\n', '\r\n', '\r\n\r\n', '```', '```ts\n', '~~~', '````\n', '  ', '\t', '[BOITE_GOAL_COMPLETE]', '[BOITE_GOAL_', 'x'];

function randomText(seed: number, length: number): string {
  let state = seed;
  const next = (limit: number) => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state % limit;
  };
  let text = '';
  while (text.length < length) text += PIECES[next(PIECES.length)];
  return text;
}

test('a streamed text splits into the same blocks as a scan of the whole text', () => {
  for (let seed = 1; seed <= 200; seed += 1) {
    const text = randomText(seed, 400);
    const scan = new ParagraphScan();
    for (let end = 0; end <= text.length; end += 1 + (seed % 7)) {
      const shown = visibleAnswer(text.slice(0, end));
      expect(scan.blocks(shown, true)).toEqual(paragraphBlocks(shown, true));
    }
    const final = visibleAnswer(text);
    expect(scan.blocks(final, false)).toEqual(paragraphBlocks(final, false));
  }
});

test('an edited or shortened text starts the scan over', () => {
  const scan = new ParagraphScan();
  expect(scan.blocks('one\n\ntwo\n\nthree', true)).toEqual(['one', 'two']);
  expect(scan.blocks('uno\n\ntwo\n\n', true)).toEqual(['uno', 'two']);
  expect(scan.blocks('uno\n', true)).toEqual([]);
  expect(scan.blocks('```\na\n\nb', true)).toEqual([]);
  expect(scan.blocks('```\na\n\nb\n```\n\nc', false)).toEqual(['```\na\n\nb\n```', 'c']);
});

test('a delta inside a paragraph returns the same blocks, so nothing downstream re-renders', () => {
  const scan = new ParagraphScan();
  let text = 'First paragraph.\n\n';
  const first = scan.blocks(text, true);
  for (const word of 'the second one grows word by word'.split(' ')) {
    text += `${word} `;
    expect(scan.blocks(text, true)).toBe(first);
  }
  text += '\n\n';
  expect(scan.blocks(text, true)).toEqual(['First paragraph.', 'the second one grows word by word']);
});

test('a marker check looks at the last line only and keeps the fenced case', () => {
  const long = 'a'.repeat(10_000);
  expect(visibleAnswer(`${long}\n[BOITE_GOAL_COMPLETE]\n\t\r\n`)).toBe(`${long}\n`);
  expect(visibleAnswer(`\`\`\`\n${long}\n[BOITE_GOAL_COMPLETE]`)).toBe(`\`\`\`\n${long}\n[BOITE_GOAL_COMPLETE]`);
  expect(visibleAnswer(`${long}\n[BOITE_GOAL_COMPLETE] and more`)).toBe(`${long}\n[BOITE_GOAL_COMPLETE] and more`);
  expect(visibleAnswer(`${long}\n  [BOITE_GOAL_BLOCKED]\f`)).toBe(`${long}\n`);
});

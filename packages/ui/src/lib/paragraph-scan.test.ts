import { expect, test } from 'vitest';
import { renderMarkdown } from './markdown';
import { ParagraphScan, paragraphBlocks, pendingDrawing, visibleAnswer } from './message-display';

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

test('a paragraph being written stops where a diagram, a formula or a view opens, outside another fence', () => {
  expect(pendingDrawing('Here it is:\n```view\n<svg viewBox="0 0 10')).toEqual({ text: 'Here it is:', drawing: true });
  expect(pendingDrawing('```mermaid\nflowchart LR\n  A --> B\n```')).toEqual({ text: '', drawing: true });
  expect(pendingDrawing('So\n$$\n\\int_0^1')).toEqual({ text: 'So', drawing: true });
  expect(pendingDrawing('So \\[x')).toEqual({ text: 'So \\[x', drawing: false });
  // A fence shown as code is written as it comes; the renderer ends it on the next fence line, which opens nothing.
  expect(pendingDrawing('```html\n<p>Hi</p>')).toEqual({ text: '```html\n<p>Hi</p>', drawing: false });
  expect(pendingDrawing('```md\nquoted\n```view\n<p>')).toEqual({ text: '```md\nquoted\n```view\n<p>', drawing: false });
  expect(pendingDrawing('```md\nquoted\n```\n```view\n<p>')).toEqual({ text: '```md\nquoted\n```', drawing: true });
  // Held back only where the renderer draws: an indented opener stays text, a capitalized kind is drawn.
  expect(pendingDrawing('Steps:\n   ```view\n<p>')).toEqual({ text: 'Steps:\n   ```view\n<p>', drawing: false });
  expect(renderMarkdown('   ```view\n<p>Hi</p>\n   ```')).not.toContain('md-view');
  expect(pendingDrawing('```Mermaid\nflowchart LR')).toEqual({ text: '', drawing: true });
  expect(renderMarkdown('```Mermaid\nflowchart LR\n```')).toContain('md-mermaid');
  // A quote is drawn as a document of its own, so a view opened in it is held back from its first line.
  expect(pendingDrawing('Look:\n> Here:\n> ```view\n> <svg')).toEqual({ text: 'Look:\n> Here:', drawing: true });
  expect(renderMarkdown('> ```view\n> <p>Hi</p>\n> ```')).toContain('md-view');
});
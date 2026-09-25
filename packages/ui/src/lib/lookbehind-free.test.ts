import { expect, test } from 'vitest';
import { richInline } from './chat-links';
import { renderMarkdown } from './markdown';
import { linesKeepingBreaks, paragraphBlocks } from './message-display';

// These replaced regex lookbehinds, which Safari before 16.4 cannot parse
// (docs/phone.md). Each case is one the lookbehind decided.

test('lines keep their breaks and a trailing break adds no empty line', () => {
  expect(linesKeepingBreaks('')).toEqual(['']);
  expect(linesKeepingBreaks('a')).toEqual(['a']);
  expect(linesKeepingBreaks('a\n')).toEqual(['a\n']);
  expect(linesKeepingBreaks('a\nb')).toEqual(['a\n', 'b']);
  expect(linesKeepingBreaks('\n\n')).toEqual(['\n', '\n']);
  expect(linesKeepingBreaks('a\r\n\r\nb')).toEqual(['a\r\n', '\r\n', 'b']);
  expect(paragraphBlocks('one\n\ntwo\n\nthr', true)).toEqual(['one', 'two']);
});

test('an inline code span needs a run of backticks nothing else touches', () => {
  expect(renderMarkdown('`a` `b`')).toBe('<p><code>a</code> <code>b</code></p>');
  expect(renderMarkdown('x``a`b``y')).toBe('<p>x<code>a`b</code>y</p>');
  // What the lookbehind form gave for runs that touch, kept as it was.
  expect(renderMarkdown('`a``b`')).toBe('<p><code>a`</code>b`</p>');
  expect(renderMarkdown('```a`')).toBe('<p><code>`</code>a`</p>');
});

test('a table cell keeps an escaped pipe', () => {
  const html = renderMarkdown('| a \\| b | c |\n|---|---|\n| 1 | 2 |');
  expect(html).toContain('<th>a | b</th>');
  expect(html).toContain('<th>c</th>');
  expect(html).toContain('<td>2</td>');
});

test('a relative path is a link only when no word character or colon comes before it', () => {
  const id = (text: string) => text;
  expect(richInline('see src/lib/a.ts now', id)).toContain('data-file-path="src/lib/a.ts"');
  expect(richInline('xsrc/a.ts', id)).not.toContain('data-file-path="src/a.ts"');
  // Refused after a colon, the absolute path at the next slash is still found.
  expect(richInline('foo:bar/baz.ts', id)).toBe('foo:bar<a href="#file" data-file-path="/baz.ts">/baz.ts</a>');
  // Refused at the first dot, the absolute path starting there wins, as before.
  expect(richInline(':../x.ts', id)).toBe(':<a href="#file" data-file-path="../x.ts">../x.ts</a>');
  // Right after another link it still counts: the check reads the text, not what is left of it.
  expect(richInline('<https://a.b>src/c.ts', id)).toContain('data-file-path="src/c.ts"');
});

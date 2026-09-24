import { expect, test } from 'vitest';
import { chatLink, fileLike } from './chat-links';
import { renderMarkdown } from './markdown';

test('rich markdown supports local paths, spaces, line numbers, file URIs and balanced URL parentheses', () => {
  expect(chatLink('C:\\project\\file.ts:12:3')).toEqual({ kind: 'file', target: 'C:/project/file.ts', line: 12 });
  expect(chatLink('file:///C:/project/report%20one.pdf')).toEqual({ kind: 'file', target: 'C:/project/report one.pdf' });
  expect(chatLink('src/file.ts#L5')).toEqual({ kind: 'file', target: 'src/file.ts', line: 5 });
  const html = renderMarkdown('[PDF](<docs/report one.pdf>) [source](/project/main.ts:3) [web](https://example.test/a_(b)) https://example.test/page. `src/main.ts:8`', true);
  expect(html).toContain('data-file-path="docs/report one.pdf"');
  expect(html).toContain('data-file-line="3"');
  expect(html).toContain('href="https://example.test/a_(b)"');
  expect(html).toContain('href="https://example.test/page"');
  expect(html).toContain('<code><a href="#file" data-file-path="src/main.ts" data-file-line="8">');
  expect(renderMarkdown('[file](src/main.ts)')).not.toContain('data-file-path');
  expect(renderMarkdown('Read src/main.ts:4 next.', true)).toContain('data-file-path="src/main.ts" data-file-line="4"');
  expect(renderMarkdown('# Project files\n\n[Jump](#project-files)', true)).toContain('id="project-files"');
});

test('markup, executable schemes and remote file shares cannot turn into active content', () => {
  for (const value of ['javascript:alert(1)', 'data:text/html,hello', 'vbscript:foo', 'file://server/share', '//server/share']) expect(chatLink(value)).toBeNull();
  const html = renderMarkdown('[x](javascript:alert(1)) [x](data:text/html,bad) [<img onerror=x>](<docs/a"b.pdf>) ![image](https://example.test/pixel.png)', true);
  expect(html).not.toContain('href="javascript:'); expect(html).not.toContain('href="data:');
  expect(html).not.toContain('<img'); expect(html).toContain('a&quot;b.pdf');
  expect(renderMarkdown('```\n[local](file.txt)\n```', true)).not.toContain('<a');
});

test('path detection handles long slash sequences without repeated backtracking', () => {
  expect(fileLike(`-/${'!/'.repeat(10000)} `)).toBe(false);
  expect(fileLike('src/nested/file.ts:12')).toBe(true);
});

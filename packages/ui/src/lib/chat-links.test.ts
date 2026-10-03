import { expect, test } from 'vitest';
import { chatLink, fileLike } from './chat-links';
import { renderMarkdown } from './markdown';

test('rich markdown supports local paths, spaces, line numbers, file URIs and balanced URL parentheses', () => {
  expect(chatLink('C:\\project\\file.ts:12:3')).toEqual({ kind: 'file', target: 'C:/project/file.ts', line: 12 });
  expect(chatLink('file:///C:/project/report%20one.pdf')).toEqual({ kind: 'file', target: 'C:/project/report one.pdf' });
  expect(chatLink('/D:/project/session.ts:12')).toEqual({ kind: 'file', target: 'D:/project/session.ts', line: 12 });
  expect(chatLink('/D%3A/project/report%20one.pdf#L5')).toEqual({ kind: 'file', target: 'D:/project/report one.pdf', line: 5 });
  expect(chatLink('src/file.ts#L5')).toEqual({ kind: 'file', target: 'src/file.ts', line: 5 });
  const html = renderMarkdown('[PDF](<docs/report one.pdf>) [source](/project/main.ts:3) [web](https://example.test/a_(b)) https://example.test/page. `src/main.ts:8`', true);
  expect(html).toContain('data-file-path="docs/report one.pdf"');
  expect(renderMarkdown('[source](/D:/project/session.ts:12)', true)).toContain('data-file-path="D:/project/session.ts" data-file-line="12"');
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

test('numeric ratios and dates remain text instead of automatic file links', () => {
  const source = '- 56/102 binaries processed.\n- 139 015/173 043 archive entries extracted.\n- 20 174 resources examined.';
  expect(renderMarkdown(source, true)).toBe('<ul><li>56/102 binaries processed.</li><li>139 015/173 043 archive entries extracted.</li><li>20 174 resources examined.</li></ul>');
  expect(renderMarkdown('**56/102** and ~~1/2~~', true)).toBe('<p><strong>56/102</strong> and <del>1/2</del></p>');
  for (const value of ['1/2', '2026/10/03', '1.5/2.0', '/102']) {
    expect(renderMarkdown(`${value}, then continue.`, true)).toBe(`<p>${value}, then continue.</p>`);
    expect(renderMarkdown(`(${value}), then continue.`, true)).toBe(`<p>(${value}), then continue.</p>`);
    expect(fileLike(value)).toBe(false);
    expect(renderMarkdown('`' + value + '`', true)).toBe(`<p><code>${value}</code></p>`);
  }
});

test('numeric directories and explicit links to numeric files remain clickable', () => {
  const html = renderMarkdown('2026/10/report.json /123/report.json `123/report.json` [numeric file](/123)', true);
  for (const path of ['2026/10/report.json', '/123/report.json', '123/report.json', '/123']) {
    expect(html).toContain(`data-file-path="${path}"`);
  }
});

import { expect, test } from 'vitest';
import { codeLanguage, highlightCode, HIGHLIGHT_LIMIT } from './code-highlight';

test('file extensions and conventional names select a grammar, unknown files stay plain', () => {
  expect(codeLanguage('C:\\src\\App.SVELTE')).toBe('xml');
  expect(codeLanguage('index.tsx')).toBe('typescript');
  expect(codeLanguage('Dockerfile.dev')).toBe('dockerfile');
  expect(codeLanguage('Makefile')).toBe('makefile');
  expect(codeLanguage('config.toml')).toBe('ini');
  expect(codeLanguage('notes.txt', 'python')).toBe('python');
  expect(codeLanguage('notes.txt')).toBeNull();
  expect(codeLanguage('file.unknown', 'toString')).toBeNull();
});

test('multiline comments stay colored when a diff renders individual lines', async () => {
  const text = '/* first\nsecond */\nconst html = "<img onerror=alert(1)>";\n';
  const lines = await highlightCode(text, 'typescript');
  expect(lines).toHaveLength(4);
  expect(lines?.[1]).toContain('hljs-comment');
  const code = document.createElement('div');
  for (const html of lines!) {
    const line = document.createElement('div');
    line.innerHTML = html;
    expect(line.querySelectorAll('img')).toHaveLength(0);
    code.append(line);
  }
  expect(Array.from(code.children, line => line.textContent).join('\n')).toBe(text);
  expect(await highlightCode('x'.repeat(HIGHLIGHT_LIMIT + 1), 'typescript')).toBeNull();
  expect(await highlightCode(text, null)).toBeNull();
  expect((await highlightCode('int main(void) { return 0; }', 'c'))?.join('')).toContain('hljs-type');
});

test('CRLF files keep one displayed line per editor line and diff row', async () => {
  const lines = await highlightCode('/* first\r\nsecond */\r\nconst n = 1;', 'typescript');
  expect(lines).toHaveLength(3);
  for (const html of lines!) {
    const row = document.createElement('span');
    row.innerHTML = html;
    expect(row.textContent).not.toMatch(/[\r\n]/);
  }
});

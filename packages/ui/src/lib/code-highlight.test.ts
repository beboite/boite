import { afterEach, expect, test, vi } from 'vitest';
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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

/** A worker that runs the grammar as the real one does, on this thread, and counts what it was sent. */
async function fakeWorker(fails = false) {
  const { highlightText } = await import('./code-grammar');
  const sent: { id: number; text: string; language: string }[] = [];
  class FakeWorker {
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    constructor(readonly url: URL, readonly options: WorkerOptions) {}
    postMessage(job: { id: number; text: string; language: 'typescript' }) {
      sent.push(job);
      if (fails) { queueMicrotask(() => this.onerror?.(new Event('error', { cancelable: true }))); return; }
      void highlightText(job.text, job.language).then(lines => this.onmessage?.({ data: { id: job.id, lines } } as MessageEvent));
    }
    terminate() {}
  }
  vi.stubGlobal('Worker', FakeWorker);
  return { sent, module: await import('./code-highlight') };
}

test('a long text goes through its grammar in a module worker, a short one here, both into the same cache', async () => {
  const { sent, module } = await fakeWorker();
  const long = 'const value = 1; // a line of code\n'.repeat(Math.ceil(module.WORKER_FROM / 35));
  const lines = await module.highlightCode(long, 'typescript');
  expect(sent).toHaveLength(1);
  expect(lines?.[0]).toContain('hljs-keyword');
  expect(await module.highlightCode(long, 'typescript')).toBe(lines);
  expect(sent).toHaveLength(1);
  await module.highlightCode('const small = 1;', 'typescript');
  expect(sent).toHaveLength(1);
});

test('a worker that cannot start leaves every text to the page', async () => {
  const { sent, module } = await fakeWorker(true);
  const long = 'let n = 2;\n'.repeat(module.WORKER_FROM / 10);
  expect((await module.highlightCode(long, 'typescript'))?.[0]).toContain('hljs-keyword');
  expect(sent).toHaveLength(1);
  expect((await module.highlightCode(`${long}// another`, 'typescript'))?.at(-1)).toContain('hljs-comment');
  expect(sent).toHaveLength(1);
});

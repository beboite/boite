/*
 * The grammars and the run of one text through them, shared by the page and
 * the highlight worker (`code-highlight.worker.ts`): each loads a grammar the
 * first time a text needs it.
 */
const LOADERS = {
  typescript: () => import('highlight.js/lib/languages/typescript'),
  javascript: () => import('highlight.js/lib/languages/javascript'),
  xml: () => import('highlight.js/lib/languages/xml'),
  css: () => import('highlight.js/lib/languages/css'),
  scss: () => import('highlight.js/lib/languages/scss'),
  json: () => import('highlight.js/lib/languages/json'),
  markdown: () => import('highlight.js/lib/languages/markdown'),
  yaml: () => import('highlight.js/lib/languages/yaml'),
  ini: () => import('highlight.js/lib/languages/ini'),
  bash: () => import('highlight.js/lib/languages/bash'),
  powershell: () => import('highlight.js/lib/languages/powershell'),
  python: () => import('highlight.js/lib/languages/python'),
  rust: () => import('highlight.js/lib/languages/rust'),
  go: () => import('highlight.js/lib/languages/go'),
  csharp: () => import('highlight.js/lib/languages/csharp'),
  java: () => import('highlight.js/lib/languages/java'),
  // C uses the shared C/C++ grammar to avoid bundling a second copy of its tokens.
  c: () => import('highlight.js/lib/languages/cpp'),
  cpp: () => import('highlight.js/lib/languages/cpp'),
  sql: () => import('highlight.js/lib/languages/sql'),
  ruby: () => import('highlight.js/lib/languages/ruby'),
  php: () => import('highlight.js/lib/languages/php'),
  dockerfile: () => import('highlight.js/lib/languages/dockerfile'),
  makefile: () => import('highlight.js/lib/languages/makefile')
};
export type Language = keyof typeof LOADERS;

/** True for a grammar this module can load. */
export function knownLanguage(language: string): language is Language {
  return Object.hasOwn(LOADERS, language);
}

const loaded = new Map<Language, Promise<void>>();
async function load(language: Language): Promise<void> {
  let pending = loaded.get(language);
  if (!pending) {
    pending = Promise.all([import('highlight.js/lib/core'), LOADERS[language]()]).then(([{ default: highlighter }, { default: grammar }]) => {
      highlighter.registerLanguage(language, grammar);
    });
    loaded.set(language, pending);
    pending.catch(() => loaded.delete(language));
  }
  await pending;
}

/** Each line closes and reopens a multiline token so folded diff context keeps its grammar. */
function linesOf(html: string): string[] {
  const lines: string[] = [];
  const spans: string[] = [];
  let line = '';
  for (const token of html.split(/(<span\b[^>]*>|<\/span>|\n)/)) {
    if (token === '\n') {
      lines.push(line + '</span>'.repeat(spans.length));
      line = spans.join('');
    } else {
      if (token.startsWith('<span')) spans.push(token);
      else if (token === '</span>') spans.pop();
      line += token;
    }
  }
  lines.push(line);
  return lines;
}

/** `text` through its grammar, as lines of HTML. Here or in the worker, wherever it is called. */
export async function highlightText(text: string, language: Language): Promise<string[]> {
  await load(language);
  // HTML-like templates can contain both script and style blocks.
  if (language === 'xml') await Promise.all([load('javascript'), load('typescript'), load('css')]);
  const { default: highlighter } = await import('highlight.js/lib/core');
  // Textareas normalize CRLF. A stray CR inside a token span would add a second visual line.
  return linesOf(highlighter.highlight(text.replace(/\r\n?/g, '\n'), { language, ignoreIllegals: true }).value);
}

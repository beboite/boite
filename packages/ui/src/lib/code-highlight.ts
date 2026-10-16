/** File names select a grammar; unknown files remain plain text. No guessing on every keystroke. */
const EXTENSIONS: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  svelte: 'xml', vue: 'xml', html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml',
  css: 'css', scss: 'scss', json: 'json', jsonc: 'json',
  md: 'markdown', mdx: 'markdown', yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini',
  sh: 'bash', bash: 'bash', zsh: 'bash', ps1: 'powershell', psm1: 'powershell',
  py: 'python', rs: 'rust', go: 'go', cs: 'csharp', java: 'java',
  c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cc: 'cpp', sql: 'sql', rb: 'ruby', php: 'php'
};
const ALIASES: Record<string, string> = { html: 'xml', svelte: 'xml', vue: 'xml', ts: 'typescript', js: 'javascript', shell: 'bash', sh: 'bash', toml: 'ini', 'c#': 'csharp' };
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
type Language = keyof typeof LOADERS;

export function codeLanguage(path: string, hint?: string | null): Language | null {
  const name = path.replaceAll('\\', '/').split('/').at(-1)?.toLowerCase() ?? '';
  const inferred = name === 'dockerfile' || name.startsWith('dockerfile.') ? 'dockerfile'
    : name === 'makefile' || name === 'gnumakefile' ? 'makefile'
    : EXTENSIONS[name.split('.').at(-1) ?? ''];
  const requested = hint?.toLowerCase();
  const language = inferred ?? (requested ? ALIASES[requested] ?? requested : null);
  return language && Object.hasOwn(LOADERS, language) ? language as Language : null;
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

/** Large files stay editable without sending megabytes through a grammar on each edit. */
export const HIGHLIGHT_LIMIT = 200_000;
export async function highlightCode(text: string, language: Language | null): Promise<string[] | null> {
  if (!language || text.length > HIGHLIGHT_LIMIT) return null;
  await load(language);
  // HTML-like templates can contain both script and style blocks.
  if (language === 'xml') await Promise.all([load('javascript'), load('typescript'), load('css')]);
  const { default: highlighter } = await import('highlight.js/lib/core');
  // Textareas normalize CRLF. A stray CR inside a token span would add a second visual line.
  return linesOf(highlighter.highlight(text.replace(/\r\n?/g, '\n'), { language, ignoreIllegals: true }).value);
}

import { readdirSync, readFileSync } from 'node:fs';

// Every directory `bun test` runs files from. packages/ui runs under Vitest, whose `expect` awaits for real.
export const BUN_TEST_ROOTS = ['packages/core', 'packages/contracts', 'tests', 'scripts', 'bench', 'apps/shell/scripts', 'telemetry'];
// The extensions Bun loads as test files or as modules they import.
const SOURCE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const SKIPPED = new Set(['node_modules', 'target', 'dist']);

type Token = { kind: 'name' | 'string' | 'punct' | 'value'; text: string; line: number };

// After these words a `/` starts a regular expression; after any other name it divides.
const BEFORE_EXPRESSION = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);

/** Names, strings and punctuation of JavaScript or TypeScript source; comments, template text and regular expressions are dropped. */
function tokens(source: string): Token[] {
  const out: Token[] = [];
  const templates: number[] = []; // brace depth at which each open `${` returns to its template
  let depth = 0;
  let line = 1;
  let i = 0;
  const regexAllowed = () => {
    const last = out.at(-1);
    if (!last) return true;
    if (last.kind === 'name') return BEFORE_EXPRESSION.has(last.text);
    if (last.kind === 'punct') return !')]}'.includes(last.text);
    return false;
  };
  const skipTo = (end: number) => {
    for (; i < end; i++) if (source[i] === '\n') line++;
  };
  const template = () => {
    // From just inside a backtick or after a `}` closing `${`, to the closing backtick or the next `${`.
    for (let j = i; j < source.length; j++) {
      if (source[j] === '\\') j++;
      else if (source[j] === '`') { skipTo(j + 1); out.push({ kind: 'value', text: '`', line }); return; }
      else if (source[j] === '$' && source[j + 1] === '{') { skipTo(j + 2); templates.push(depth++); out.push({ kind: 'punct', text: '(', line }); return; }
    }
    skipTo(source.length);
  };
  while (i < source.length) {
    const c = source[i]!;
    if (c === '\n') { line++; i++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (c === '/' && source[i + 1] === '/') { while (i < source.length && source[i] !== '\n') i++; continue; }
    if (c === '/' && source[i + 1] === '*') { const end = source.indexOf('*/', i + 2); skipTo(end < 0 ? source.length : end + 2); continue; }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < source.length && source[j] !== c && source[j] !== '\n') j += source[j] === '\\' ? 2 : 1;
      out.push({ kind: 'string', text: source.slice(i + 1, j), line });
      skipTo(j + 1);
      continue;
    }
    if (c === '`') { i++; template(); continue; }
    if (c === '/' && regexAllowed()) {
      let j = i + 1;
      let inClass = false;
      for (; j < source.length && source[j] !== '\n'; j++) {
        if (source[j] === '\\') j++;
        else if (source[j] === '[') inClass = true;
        else if (source[j] === ']') inClass = false;
        else if (source[j] === '/' && !inClass) break;
      }
      while (/[a-z]/i.test(source[j + 1] ?? '')) j++;
      out.push({ kind: 'value', text: '/regex/', line });
      skipTo(j + 1);
      continue;
    }
    const word = /^[\p{L}_$][\p{L}\p{N}_$]*|^\d[\w.]*/u.exec(source.slice(i, i + 256));
    if (word) {
      out.push({ kind: /^\d/.test(word[0]) ? 'value' : 'name', text: word[0], line });
      i += word[0].length;
      continue;
    }
    if (c === '{') depth++;
    if (c === '}') {
      if (templates.at(-1) === depth - 1) { templates.pop(); depth--; i++; out.push({ kind: 'punct', text: ')', line }); template(); continue; }
      depth--;
    }
    out.push({ kind: 'punct', text: c, line });
    i++;
  }
  return out;
}

const OPEN: Record<string, string> = { '(': ')', '[': ']', '{': '}' };

/** Index just past the bracket group opening at `start`. */
function closing(list: Token[], start: number): number {
  let level = 0;
  for (let i = start; i < list.length; i++) {
    const token = list[i]!;
    if (token.kind !== 'punct') continue;
    if (OPEN[token.text]) level++;
    else if (')]}'.includes(token.text) && --level === 0) return i + 1;
  }
  return list.length;
}

/** The member `.name`, `?.name` or `['name']` at `i`: its name, line and the index after it. */
function member(list: Token[], i: number): { name: string; line: number; next: number } | undefined {
  if (list[i]?.text === '?' && list[i + 1]?.text === '.') i++;
  const [a, b, c] = [list[i], list[i + 1], list[i + 2]];
  if (a?.kind === 'punct' && a.text === '.' && b?.kind === 'name') return { name: b.text, line: b.line, next: i + 2 };
  if (a?.kind === 'punct' && a.text === '[' && b?.kind === 'string' && c?.text === ']') return { name: b.text, line: b.line, next: i + 3 };
  return undefined;
}

/** `file:line` of each `expect(...).rejects` or `.resolves`, which runs a nested event loop tick under `bun test`. */
export function nestedTickSites(sources: Map<string, string>): string[] {
  const sites: string[] = [];
  for (const [file, source] of sources) {
    const list = tokens(source);
    list.forEach((token, index) => {
      if (token.kind !== 'name' || token.text !== 'expect' || list[index - 1]?.text === '.') return;
      let i = index + 1;
      if (list[i]?.text === '<') while (i < list.length && list[i]!.text !== '(') i++; // expect<T>(...)
      if (list[i]?.text !== '(') return;
      let access = member(list, closing(list, i));
      if (access?.name === 'not') access = member(list, access.next);
      if (access?.name === 'rejects' || access?.name === 'resolves') sites.push(`${file}:${access.line}`);
    });
  }
  return sites;
}

export function nestedTickViolations(sources: Map<string, string>): string[] {
  return nestedTickSites(sources).map(site =>
    `${site}: a rejects or resolves matcher runs a nested event loop tick under bun test, which drops socket events on macOS; ` +
    'await the promise, then match with thrown() or rejection() from packages/core/test/settle.ts ' +
    '(docs/development.md#promise-matchers-under-bun-test)');
}

export function readBunTestSources(roots = BUN_TEST_ROOTS): Map<string, string> {
  const sources = new Map<string, string>();
  const read = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (SKIPPED.has(entry.name)) continue;
      const file = `${directory}/${entry.name}`;
      if (entry.isDirectory()) read(file);
      else if (SOURCE.test(entry.name) && !entry.name.endsWith('.d.ts')) sources.set(file, readFileSync(file, 'utf8'));
    }
  };
  for (const root of roots) read(root);
  return sources;
}

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * The Markdown left once its fenced blocks are taken out. A fence opens a line, so a
 * ```` ```view ```` span in a sentence is none, and a run of the same marker at least as long closes it.
 * It is indented by three spaces at most, as in a numbered step: four make indented code. A fence
 * nested deeper in a list stays in, so a link in it is checked rather than skipped. A block leaves
 * its lines empty, so what follows keeps its line number.
 */
export function withoutFences(source: string): string {
  return source.replace(/^ {0,3}(([`~])\2{2,})[^`\n]*\n[\s\S]*?^ {0,3}\1\2*[ \t]*$/gm, (block) => block.replace(/[^\n]/g, ''));
}

/**
 * The line of a fence never closed, or null. Markdown runs one to the end of its list item or of
 * the file, which hides what follows from a reader and from this check, so it is refused.
 */
export function unclosedFence(source: string): number | null {
  const left = withoutFences(source);
  const at = left.search(/^ {0,3}(?:`{3,}|~{3,})[^`\n]*$/m);
  return at < 0 ? null : left.slice(0, at).split('\n').length;
}

if (import.meta.main) {
  const files = ['README.md', 'AGENTS.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CODE_OF_CONDUCT.md'];
  const walk = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (file.endsWith('.md')) files.push(file);
    }
  };
  walk('docs');
  const broken: string[] = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const unclosed = unclosedFence(text);
    if (unclosed !== null) broken.push(`${file}:${unclosed}: a fence that never closes`);
    const source = withoutFences(text);
    const links = [...source.matchAll(/\]\(([^)]+)\)|(?:href|src)="([^"]+)"/g)];
    for (const link of links) {
      const value = (link[1] ?? link[2]!).split(/\s+"/)[0]!.replace(/^<|>$/g, '');
      if (/^(?:[a-z]+:|#|\/\/)/i.test(value)) continue;
      const path = decodeURIComponent(value.split('#')[0]!.split('?')[0]!);
      if (path && !existsSync(resolve(dirname(file), path))) broken.push(`${file}: ${value}`);
    }
  }
  if (broken.length) throw new Error(`Broken documentation links:\n${broken.join('\n')}`);
  console.log(`Documentation links passed: ${files.length} files`);
}

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * The Markdown left once its fenced blocks are taken out. A fence opens a line, so a
 * ```` ```view ```` span in a sentence is none, and a run of the same marker at least as long closes it.
 */
export function withoutFences(source: string): string {
  return source.replace(/^[ \t]*(([`~])\2{2,})[^`\n]*\n[\s\S]*?^[ \t]*\1\2*[ \t]*$/gm, '');
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
    const source = withoutFences(readFileSync(file, 'utf8'));
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

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const files = ['README.md', 'AGENTS.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CODE_OF_CONDUCT.md'];
function walk(path: string): void {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const file = join(path, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (file.endsWith('.md')) files.push(file);
  }
}
walk('docs');
const broken: string[] = [];
for (const file of files) {
  const source = readFileSync(file, 'utf8').replace(/```[\s\S]*?```/g, '');
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

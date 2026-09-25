import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';

const SRC = resolve('src');

function svelteFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return svelteFiles(path);
    return entry.name.endsWith('.svelte') ? [path] : [];
  });
}

test('every endless animation stops when the system asks for reduced motion', () => {
  const unguarded = svelteFiles(SRC).filter((path) => {
    const style = /<style[^>]*>([\s\S]*?)<\/style>/.exec(readFileSync(path, 'utf8'))?.[1] ?? '';
    return /\binfinite\b/.test(style) && !/prefers-reduced-motion:\s*reduce/.test(style);
  });
  expect(unguarded.map((path) => path.slice(SRC.length + 1))).toEqual([]);
});

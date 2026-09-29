import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

test('browser store startup does not load the task loop or native daemon', () => {
  const scanner = new Bun.Transpiler({ loader: 'ts' });
  const loaded = new Set<string>();
  function visit(file: string): void {
    if (loaded.has(file)) return;
    loaded.add(file);
    for (const dependency of scanner.scan(readFileSync(file, 'utf8')).imports) {
      if (dependency.kind !== 'dynamic-import' && dependency.path.startsWith('.')) {
        visit(resolve(dirname(file), dependency.path));
      }
    }
  }
  visit(resolve(import.meta.dir, '../src/browser.ts'));
  expect(loaded.has(resolve(import.meta.dir, '../src/browser/loop.ts'))).toBe(false);
  expect(loaded.has(resolve(import.meta.dir, '../src/browser/daemon.ts'))).toBe(false);
});

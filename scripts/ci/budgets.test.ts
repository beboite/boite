import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { entryChunk, measure, overBudget, type Budgets } from './budgets.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test('finds the entry chunk vite writes, relative or absolute', () => {
  expect(entryChunk('<script type="module" crossorigin src="./assets/index-A1.js"></script>')).toBe('assets/index-A1.js');
  expect(entryChunk('<script type="module" crossorigin src="/assets/index-A1.js"></script>')).toBe('assets/index-A1.js');
  expect(() => entryChunk('<script>inline()</script>')).toThrow('no module script');
});

test('measures the entry chunk, the UI without precompressed copies and the core bundle', () => {
  const root = mkdtempSync(join(tmpdir(), 'boite-budgets-'));
  dirs.push(root);
  const ui = join(root, 'packages', 'ui', 'dist');
  mkdirSync(join(ui, 'assets'), { recursive: true });
  mkdirSync(join(root, 'packages', 'core', 'dist'), { recursive: true });
  const html = '<script type="module" crossorigin src="./assets/index-A1.js"></script>';
  writeFileSync(join(ui, 'index.html'), html);
  writeFileSync(join(ui, 'assets', 'index-A1.js'), 'x'.repeat(100));
  writeFileSync(join(ui, 'assets', 'index-A1.js.br'), 'x'.repeat(40));
  writeFileSync(join(ui, 'assets', 'index-A1.js.gz'), 'x'.repeat(50));
  writeFileSync(join(ui, 'assets', 'lazy.js'), 'x'.repeat(30));
  writeFileSync(join(root, 'packages', 'core', 'dist', 'main.js'), 'x'.repeat(70));
  expect(measure(root)).toEqual({ uiEntryChunk: 100, uiDist: html.length + 130, coreBundle: 70 });
});

test('names each measure above its limit', () => {
  const limits: Budgets = { uiEntryChunk: 100, uiDist: 1000, coreBundle: 50 };
  expect(overBudget({ uiEntryChunk: 100, uiDist: 1001, coreBundle: 10 }, limits)).toEqual([
    'uiDist: 1001 bytes, above its 1000-byte budget in scripts/ci/budgets.json',
  ]);
  expect(overBudget({ uiEntryChunk: 1, uiDist: 1, coreBundle: 1 }, limits)).toEqual([]);
});

test('the checked-in budgets name every measure', () => {
  const limits = JSON.parse(readFileSync(join(import.meta.dir, 'budgets.json'), 'utf8')) as Budgets;
  expect(Object.keys(limits).sort()).toEqual(['coreBundle', 'uiDist', 'uiEntryChunk']);
  for (const value of Object.values(limits)) expect(value).toBeGreaterThan(0);
});

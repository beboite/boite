import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { workerEntry } from '../src/worker-entry.ts';

test('worker lookup preserves sibling sources and bundled files before an explicit embedded relative entry', () => {
  const dir = mkdtempSync(join(tmpdir(), 'boite-worker-entry-'));
  const base = pathToFileURL(join(dir, 'main.ts')).href;
  const name = 'isolated-worker-lookup';
  try {
    mkdirSync(join(dir, 'platform'));
    const nested = join(dir, 'platform', `${name}.ts`);
    writeFileSync(nested, '');
    expect(workerEntry(base, name, `./platform/${name}.ts`)).toBe(pathToFileURL(nested).href);
    const bundled = join(dir, `${name}.js`); writeFileSync(bundled, '');
    expect(workerEntry(base, name, `./platform/${name}.ts`)).toBe(pathToFileURL(bundled).href);
    const source = join(dir, `${name}.ts`); writeFileSync(source, '');
    expect(workerEntry(base, name)).toBe(pathToFileURL(source).href);
    expect(() => workerEntry(base, 'missing-worker')).toThrow('no missing-worker beside');
    expect(workerEntry('file:///$bunfs/root/compiled-core', name, './src/platform/entry.ts'))
      .toBe('file:///$bunfs/root/src/platform/entry.ts');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

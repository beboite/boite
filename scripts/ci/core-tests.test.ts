import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { coreTestFiles, runCoreFiles } from './core-tests.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function directory(): string {
  const dir = mkdtempSync(join(tmpdir(), 'boite-isolated-tests-'));
  dirs.push(dir);
  return dir;
}

test('discovers Bun test filename forms without dependency tests', () => {
  const cwd = directory();
  mkdirSync(join(cwd, 'node_modules'), { recursive: true });
  for (const name of ['a.test.ts', 'b_spec.mjs', 'c.spec.cts', 'helper.ts', 'node_modules/dependency.test.ts']) writeFileSync(join(cwd, name), '');
  expect(coreTestFiles(cwd)).toEqual(['a.test.ts', 'b_spec.mjs', 'c.spec.cts'].map(file => join(cwd, file)));
});

test('runs every file in a fresh process and propagates assertion failures', async () => {
  const cwd = directory();
  const first = join(cwd, 'a.test.ts');
  const second = join(cwd, 'b.test.ts');
  writeFileSync(first, `import { test, expect } from 'bun:test'; test('first', () => { globalThis.shared = true; expect(process.env.BOITE_DATA_DIR).toBeTruthy(); });`);
  writeFileSync(second, `import { test, expect } from 'bun:test'; test('second', () => { expect(globalThis.shared).toBeUndefined(); });`);
  await runCoreFiles([first, second], { cwd, quiet: true });
  writeFileSync(first, `import { test, expect } from 'bun:test'; test('failure', () => { expect(true).toBe(false); });`);
  await expect(runCoreFiles([first], { cwd, quiet: true })).rejects.toThrow('a.test.ts: exited with code 1');
});

test('a stuck file fails its deadline instead of succeeding after termination', async () => {
  const cwd = directory();
  const file = join(cwd, 'stuck.test.ts');
  writeFileSync(file, `setInterval(() => {}, 1000); await new Promise(() => {});`);
  await expect(runCoreFiles([file], { cwd, quiet: true, timeoutMs: 1000 })).rejects.toThrow('stuck.test.ts: exceeded 1000 ms');
});

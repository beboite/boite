import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { failedTests, namePattern, QUARANTINE, quarantined } from './flaky.ts';

const ROOT = resolve(import.meta.dir, '../..');
const entry = (file: string, name: string) => ({ file, test: name, reason: 'seen' });

test('failed tests are named only when every counted failure has a name', () => {
  const two = '(pass) fine [1.00ms]\n(fail) group > a, b [12.31ms]\n(fail) top (x) [5ms]\n\n 1 pass\n 2 fail\n';
  expect(failedTests(two)).toEqual(['group > a, b', 'top (x)']);
  expect(failedTests('\x1b[31m(fail)\x1b[0m one [3.00ms]\r\n 1 fail\r\n')).toEqual(['one']);
  // An error between tests is counted without a test name of its own.
  expect(failedTests('(fail) one [3.00ms]\n 2 fail\n')).toBeUndefined();
  // A crash or a killed process prints no failure at all.
  expect(failedTests('Segmentation fault\n')).toBeUndefined();
  // The core runner's summary repeats no count bun did not print.
  expect(failedTests('(fail) a\n 1 fail\n(fail) b\n 1 fail\n')).toEqual(['a', 'b']);
});

test('a retry needs every failure quarantined in a file that ran', () => {
  const list = [entry('tests/e2e/a.test.ts', 'one'), entry('tests/e2e/b.test.ts', 'two')];
  const absolute = join(ROOT, 'tests', 'e2e', 'a.test.ts');
  expect(quarantined(['one'], [absolute], list)).toEqual([list[0]!]);
  expect(quarantined(['one', 'two'], ['tests/e2e/a.test.ts', './tests/e2e/b.test.ts'], list)).toEqual(list);
  expect(quarantined(['one', 'other'], [absolute], list)).toBeUndefined();
  expect(quarantined(['two'], [absolute], list)).toBeUndefined();
  expect(quarantined(['(unnamed)'], [absolute], list)).toBeUndefined();
  expect(quarantined(undefined, [absolute], list)).toBeUndefined();
  expect(quarantined([], [absolute], list)).toBeUndefined();
});

test('the retry pattern selects exactly the quarantined tests in bun', () => {
  const dir = mkdtempSync(join(tmpdir(), 'boite-flaky-'));
  try {
    const file = join(dir, 'fixture.test.ts');
    writeFileSync(file, [
      "import { describe, test } from 'bun:test';",
      "describe('group (one)', () => { test('a, b: c [d]?', () => {}); test('a, b: c [d]? too', () => {}); });",
      "test('top level', () => {});",
      "test('other', () => { throw new Error('must not run'); });",
    ].join('\n'));
    const pattern = namePattern([entry('x', 'group (one) > a, b: c [d]?'), entry('x', 'top level')]);
    const run = Bun.spawnSync([process.execPath, 'test', file, '-t', pattern], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
    const output = run.stdout.toString() + run.stderr.toString();
    expect(run.exitCode).toBe(0);
    expect(output).toMatch(/^\s*2 pass$/m);
    expect(output).toMatch(/^\s*2 filtered out$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('every quarantined test still exists and says why it is there', () => {
  for (const { file, test: name, reason } of QUARANTINE) {
    expect(reason.length).toBeGreaterThan(10);
    const source = readFileSync(join(ROOT, file), 'utf8');
    for (const part of name.split(' > ')) expect(source, `${file}: ${part}`).toContain(part);
  }
  expect(new Set(QUARANTINE.map(item => `${item.file}\0${item.test}`)).size).toBe(QUARANTINE.length);
});

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { deadlineFor, inspectedTestCommand, inspectorAddress, REPORT_RESERVE_MS, TestProgress } from './hang-watch.ts';

const ROOT = resolve(import.meta.dir, '../..');
const REGISTRY = JSON.stringify(join(ROOT, 'tests/e2e/lib/hang-report.ts'));
let dir = '';

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'boite-hang-watch-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

test('the inspector address is read from the banner bun test prints first', () => {
  // `--inspect-wait` flushes the banner's second half only once the run goes on.
  expect(inspectorAddress('--------------------- Bun Inspector ---------------------\nListening:\n  ws://127.0.0.1:49314/3f2a\n')).toBe('ws://127.0.0.1:49314/3f2a');
  expect(inspectorAddress('--------------------- Bun Inspector ---------------------\r\nListening:\r\n  ws://127.0.0.1:49314/3f2a\r\nInspect')).toBe('ws://127.0.0.1:49314/3f2a');
  expect(inspectorAddress('--------------------- Bun Inspector ---------------------\nListening:\n  ws://127.0.0.1:49')).toBeUndefined();
});

test('progress names a test inside its describe, and says what still runs', () => {
  const progress = new TestProgress();
  progress.handle({ method: 'TestReporter.found', params: { id: 1, url: 'a.test.ts', line: 2, name: 'group', type: 'describe' } });
  progress.handle({ method: 'TestReporter.found', params: { id: 2, url: 'a.test.ts', line: 3, name: 'first', type: 'test', parentId: 1 } });
  progress.handle({ method: 'TestReporter.found', params: { id: 3, url: 'a.test.ts', line: 4, name: 'second', type: 'test', parentId: 1 } });
  progress.handle({ method: 'TestReporter.start', params: { id: 2 } }, 1_000);
  progress.handle({ method: 'TestReporter.end', params: { id: 2, status: 'pass' } }, 2_000);
  progress.handle({ method: 'TestReporter.start', params: { id: 3 } }, 2_000);
  expect(progress.running(62_000)).toEqual([{ name: 'group > second', file: 'a.test.ts', line: 4, forMs: 60_000 }]);
  expect(progress.lastEnded).toEqual({ name: 'group > first', file: 'a.test.ts', status: 'pass', at: 2_000 });
  expect(progress.file).toBe('a.test.ts');
});

test('the deadline keeps the reserve inside the job limit, and the inspector waits for the watch', () => {
  expect(deadlineFor(1_000, 35)).toBe(1_000 + 35 * 60_000 - REPORT_RESERVE_MS);
  expect(inspectedTestCommand(['bun', 'test', 'a.test.ts', '-t', 'x'])).toEqual(['bun', 'test', '--inspect-wait=127.0.0.1:0', 'a.test.ts', '-t', 'x']);
});

/** Runs flaky.ts on `source` with a deadline `afterMs` from now, its report in a fresh folder. */
async function runUntilDeadline(name: string, source: string, afterMs: number) {
  const file = join(dir, `${name}.test.ts`);
  writeFileSync(file, source);
  const report = join(dir, `${name}-report`);
  const jobStarted = Date.now() + afterMs + REPORT_RESERVE_MS - 35 * 60_000;
  const began = Date.now();
  const child = Bun.spawn([process.execPath, join(ROOT, 'scripts/ci/flaky.ts'), '--job-started', String(jobStarted), '--job-minutes', '35', file], {
    cwd: dir,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, BOITE_HANG_REPORT: report },
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  const read = (part: string) => existsSync(join(report, part)) ? readFileSync(join(report, part), 'utf8') : `(no ${part})`;
  return { code, stdout, stderr, tookMs: Date.now() - began, read };
}

test('a test that awaits forever is stopped at the deadline with its name, its pages and its process tree', async () => {
  const run = await runUntilDeadline('idle', [
    "import { describe, test } from 'bun:test';",
    `import { reportOnHang } from ${REGISTRY};`,
    "reportOnHang('browser pages', () => 'page http://127.0.0.1:1/ waits on /never');",
    "describe('group', () => {",
    "  test('passes', () => {});",
    "  test('waits forever', () => new Promise(() => {}), 600_000);",
    '});',
  ].join('\n'), 3_000);
  expect(run.code).toBe(1);
  expect(run.stdout).toContain('::error title=Test run stopped at its deadline::');
  expect(run.stdout).toContain('"group > waits forever"');
  const summary = run.read('summary.txt');
  expect(summary).toMatch(/^Running: "group > waits forever" \(.*idle\.test\.ts:6\) for \d/m);
  expect(summary).toMatch(/^Last ended: "group > passes" .*, pass,/m);
  expect(summary).toMatch(/answered in \d+ ms; its 1 page and shell source\(s\) are in test-process\.txt/);
  expect(run.read('test-process.txt')).toContain('page http://127.0.0.1:1/ waits on /never');
  expect(run.read('test-process.txt')).toContain('idle.test.ts');
  expect(run.read('process-tree.txt')).toContain('idle.test.ts');
  expect(run.read('machine.txt')).toMatch(/^Memory: \d+ MB free of \d+ MB$/m);
  expect(run.read('tests.txt')).toMatch(/\tpass\t\d+ ms\tgroup > passes\t.*idle\.test\.ts$/m);
  expect(run.read('output-tail.txt')).toContain('bun test v');
  // The report took seconds, well inside the reserve.
  expect(run.tookMs).toBeLessThan(3_000 + 60_000);
}, 120_000);

test('a test that blocks its thread is reported as blocked, from outside', async () => {
  const run = await runUntilDeadline('busy', [
    "import { test } from 'bun:test';",
    "test('spins', () => { for (;;) {} }, 600_000);",
  ].join('\n'), 3_000);
  expect(run.code).toBe(1);
  const summary = run.read('summary.txt');
  expect(summary).toMatch(/^Running: "spins" /m);
  expect(summary).toContain('its JavaScript thread is blocked in synchronous code');
  expect(run.read('process-tree.txt')).toContain('busy.test.ts');
}, 120_000);

test('a run that ends before its deadline is not touched', async () => {
  const run = await runUntilDeadline('quick', "import { test } from 'bun:test';\ntest('passes', () => {});\n", 60_000);
  expect(run.code).toBe(0);
  expect(run.stdout).not.toContain('stopped at its deadline');
  expect(run.stderr).toMatch(/^\s*1 pass$/m);
  expect(run.tookMs).toBeLessThan(30_000);
}, 60_000);

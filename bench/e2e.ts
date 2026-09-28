/**
 * Compare the complete E2E suite sequentially and with the CI partition.
 * Build and stage the shell first, then warm the fake UI (docs/ci.md).
 * Run: bun bench/e2e.ts serial|sharded [output-directory]
 * Then: bun bench/e2e.ts compare <serial-result.json> <sharded-result.json>
 */
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const mode = process.argv[2];
if (mode === 'compare') {
  type Report = { seconds: number; tests: number; assertions: number; groups: { cases: string[]; exitCode: number; skipped: number }[] };
  const paths = process.argv.slice(3);
  if (paths.length !== 2) throw new Error('compare requires serial and sharded result.json paths');
  const reports = paths.map((path) => JSON.parse(readFileSync(path, 'utf8')) as Report);
  const [before, after] = reports;
  if (!before || !after) throw new Error('both comparison reports are required');
  for (const report of reports) {
    if (!(report.seconds > 0) || report.tests === 0 || report.groups.some((group) => group.exitCode !== 0 || group.skipped !== 0)) {
      throw new Error('comparison requires two successful runs with no skipped tests');
    }
  }
  const cases = (report: Report) => report.groups.flatMap((group) => group.cases).sort();
  if (JSON.stringify(cases(before)) !== JSON.stringify(cases(after))) throw new Error('the two runs did not execute the same test cases');
  console.table([
    { mode: 'serial', seconds: before.seconds, tests: before.tests, assertions: before.assertions },
    { mode: 'sharded', seconds: after.seconds, tests: after.tests, assertions: after.assertions },
  ]);
  console.log(`Same test cases; elapsed time reduced by ${((1 - after.seconds / before.seconds) * 100).toFixed(1)}%`);
  process.exit(0);
}
if (mode !== 'serial' && mode !== 'sharded') throw new Error('expected mode serial or sharded');
if (process.env.BOITE_E2E_SKIP_SHELL === '1') throw new Error('the comparison requires the native shell tests');
const root = resolve(import.meta.dir, '..');
const output = resolve(process.argv[3] ?? join(root, 'tests/e2e/.artifacts/timings', mode));
mkdirSync(output, { recursive: true });
const shell = join(root, 'tests/e2e/shell.test.ts');
const files = readdirSync(join(root, 'tests/e2e'), { recursive: true, encoding: 'utf8' })
  .filter((name) => name.endsWith('.test.ts')).map((name) => join(root, 'tests/e2e', name)).sort();
const browserFiles = files.filter((file) => file !== shell);
const groups = mode === 'serial' ? [{ name: 'all', args: files }] : [
  ...[1, 2, 3].map((shard) => ({ name: `browser-${shard}`, args: [...browserFiles, `--shard=${shard}/3`] })),
  { name: 'shell', args: [shell] },
];

const started = performance.now();
const results = await Promise.all(groups.map(async (group) => {
  const log = join(output, `${group.name}.log`);
  const fd = openSync(log, 'w');
  const start = performance.now();
  let exitCode: number;
  try {
    exitCode = await Bun.spawn({
      cmd: [process.execPath, 'test', ...group.args], cwd: root,
      env: { ...process.env, BOITE_E2E_PREBUILT_UI: '1', BOITE_E2E_FAKE_UI: join(root, 'tests/e2e/.artifacts/fake-ui') },
      stdout: fd, stderr: fd, windowsHide: true,
    }).exited;
  } finally { closeSync(fd); }
  const seconds = (performance.now() - start) / 1000;
  const text = readFileSync(log, 'utf8');
  let file = '';
  const cases: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('tests') && line.endsWith('.test.ts:')) file = line.slice(0, -1).replaceAll('\\', '/');
    const pass = /^\(pass\) (.*?) \[[\d.]+ms\]$/.exec(line);
    if (pass) cases.push(`${file}: ${pass[1]}`);
  }
  const result = {
    name: group.name, seconds, exitCode, log, cases,
    assertions: Number(/\s(\d+) expect\(\) calls/.exec(text)?.[1] ?? 0),
    skipped: Number(/\s(\d+) skip/.exec(text)?.[1] ?? 0),
  };
  console.log(`${group.name}: ${seconds.toFixed(2)} s, ${cases.length} passed, exit ${exitCode}`);
  return result;
}));
const result = {
  mode, seconds: (performance.now() - started) / 1000,
  tests: results.reduce((sum, group) => sum + group.cases.length, 0),
  assertions: results.reduce((sum, group) => sum + group.assertions, 0),
  groups: results,
};
writeFileSync(join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n');
console.log(`${mode}: ${result.seconds.toFixed(2)} s, ${result.tests} passed, ${result.assertions} assertions; ${join(output, 'result.json')}`);
process.exit(results.some((group) => group.exitCode !== 0 || group.cases.length === 0) ? 1 : 0);

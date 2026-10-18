import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

// Runs test files again and again on one runner and counts, per test, how many
// runs passed and failed, to measure a flaky test before and after its fix.
// Each run starts every file in a fresh `bun test` process, `--parallel` at a
// time, as `packages/core/bin/test.ts` does. A failed file's whole output is
// kept in `--out`; the error block of each failed test is printed as it ends.
//
// Usage: bun scripts/ci/flake-loop.ts --runs 20 [--parallel 4] [--cwd packages/core]
//          [--pattern <bun test -t>] [--out <dir>] [--together] <test files...>
const ROOT = resolve(import.meta.dir, '../..');
/** A file that stops answering is ended, as the core runner's file deadline does. */
const FILE_DEADLINE_MS = 300_000;

export interface Tally { pass: number; fail: number; ms: number[] }

const unescape = (text: string) => text.replace(/&(quot|apos|lt|gt|amp);/g, (_, entity: string) => ({ quot: '"', apos: "'", lt: '<', gt: '>', amp: '&' })[entity]!);

/**
 * The tests a `bun test --reporter=junit` file names, skipped ones left out.
 * The console prints `(pass)` lines only in some environments; the report lists every test.
 */
export function results(junit: string): { file: string; name: string; passed: boolean; ms: number }[] {
  return [...junit.matchAll(/<testcase name="([^"]*)" classname="([^"]*)" time="([\d.]+)" file="([^"]*)"[^>]*?(?:\/>|>([\s\S]*?)<\/testcase>)/g)]
    .filter(match => !match[5]?.includes('<skipped'))
    .map(match => ({
      file: basename(unescape(match[4]!).replaceAll('\\', '/')),
      name: match[2] ? `${unescape(match[2])} > ${unescape(match[1]!)}` : unescape(match[1]!),
      passed: !match[5]?.includes('<failure') && !match[5]?.includes('<error'),
      ms: Number(match[3]) * 1000,
    }));
}

/** The lines bun printed for one failed test: from the end of the test before it to its `(fail)` line. */
export function failureBlock(output: string, name: string): string {
  const lines = output.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/);
  const end = lines.findIndex(line => line.startsWith(`(fail) ${name}`));
  if (end < 0) return '';
  let start = end - 1;
  while (start >= 0 && !/^\((pass|fail|skip|todo)\) /.test(lines[start]!)) start--;
  return lines.slice(start + 1, end + 1).join('\n');
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
}

export function summary(tallies: Map<string, Tally>, runs: number): string {
  const rows = [...tallies.entries()].sort(([, a], [, b]) => b.fail - a.fail);
  return [
    `| test | failed | passed | median ms | p95 ms | max ms |`,
    `|---|---|---|---|---|---|`,
    ...rows.map(([name, t]) => `| ${name.replaceAll('|', '\\|')} | ${t.fail} | ${t.pass} | ${Math.round(percentile(t.ms, 0.5))} | ${Math.round(percentile(t.ms, 0.95))} | ${Math.round(Math.max(0, ...t.ms))} |`),
    '',
    `${runs} runs, ${rows.reduce((sum, [, t]) => sum + t.fail, 0)} failures`,
  ].join('\n');
}

async function main(args: string[]): Promise<number> {
  const option = (name: string, fallback?: string) => {
    const at = args.indexOf(name);
    if (at < 0) return fallback;
    const [, value] = args.splice(at, 2);
    if (value === undefined) throw new Error(`${name}: expected a value`);
    return value;
  };
  const runs = Number(option('--runs', '10'));
  const parallel = Number(option('--parallel', '1'));
  const cwd = resolve(ROOT, option('--cwd', '.')!);
  const pattern = option('--pattern');
  const out = resolve(ROOT, option('--out', 'flake-loop')!);
  const together = args.includes('--together');
  if (together) args.splice(args.indexOf('--together'), 1);
  if (!Number.isInteger(runs) || runs < 1) throw new Error(`--runs: expected a positive integer, received ${runs}`);
  if (!Number.isInteger(parallel) || parallel < 1 || parallel > 8) throw new Error(`--parallel: expected 1 to 8, received ${parallel}`);
  const files = args;
  if (!files.length) throw new Error('expected at least one test file');
  mkdirSync(out, { recursive: true });

  // `--together` runs every file in one process, as an E2E shard does.
  const groups = together ? [files] : files.map(file => [file]);
  const tallies = new Map<string, Tally>();
  const count = (key: string, passed: boolean, ms: number) => {
    const tally = tallies.get(key) ?? { pass: 0, fail: 0, ms: [] };
    tallies.set(key, tally);
    if (passed) tally.pass++; else tally.fail++;
    tally.ms.push(ms);
  };
  const started = performance.now();
  for (let run = 1; run <= runs; run++) {
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(parallel, groups.length) }, async () => {
      for (let index = next++; index < groups.length; index = next++) {
        const group = groups[index]!, label = `run-${run}-${index}-${basename(group[0]!)}`;
        const report = resolve(out, `${label}.xml`);
        const child = Bun.spawn([process.execPath, 'test', ...group, '--timeout', '60000', '--reporter=junit', `--reporter-outfile=${report}`, ...(pattern ? ['-t', pattern] : [])], {
          cwd, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', windowsHide: true,
          env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
        });
        const deadline = setTimeout(() => child.kill(), FILE_DEADLINE_MS * group.length);
        const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        clearTimeout(deadline);
        const output = `${stdout}\n${stderr}`;
        let junit = '';
        try { junit = readFileSync(report, 'utf8'); rmSync(report); } catch { /* killed before it wrote one */ }
        const found = results(junit);
        for (const { file, name, passed, ms } of found) {
          const key = `${file}: ${name}`;
          count(key, passed, ms);
          if (!passed) console.log(`::group::run ${run} ${key}\n${failureBlock(output, name)}\n::endgroup::`);
        }
        if (code !== 0) {
          writeFileSync(resolve(out, `${label}.log`), output);
          if (!found.some(result => !result.passed)) {
            const key = `${basename(group[0]!)}${group.length > 1 ? ` and ${group.length - 1} more` : ''}: (exit ${code ?? 'killed'} with no named failure)`;
            count(key, false, 0);
            console.log(`::group::run ${run} ${key}\n${output.slice(-4000)}\n::endgroup::`);
          }
        }
      }
    }));
    const failed = [...tallies.values()].reduce((sum, t) => sum + t.fail, 0);
    console.log(`run ${run}/${runs}: ${failed} failures so far, ${Math.round((performance.now() - started) / 1000)} s`);
  }
  const table = summary(tallies, runs);
  console.log(`\n${table}`);
  writeFileSync(resolve(out, 'summary.md'), table);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n### ${process.env.FLAKE_LOOP_TITLE ?? files.join(' ')}\n\n${table}\n`);
  return [...tallies.values()].some(t => t.fail > 0) ? 1 : 0;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));

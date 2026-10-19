import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import type { Subprocess } from 'bun';
import { killProcessTree } from '../../tests/e2e/lib/cleanup.ts';
import { deadlineFor, inspectedTestCommand, inspectorAddress, sampleEveryMinute, TestInspector, TestProgress, writeHangReport } from './hang-watch.ts';

// A quarantined test that fails is run once more, alone, in a fresh process; the
// job passes only if that run passes. A failure outside the list, a failure bun
// cannot name, or a count that disagrees with the named failures fails at once.
//
// With --job-started (epoch ms) and --job-minutes (the job's timeout-minutes),
// a run still going near the job's limit is stopped with a report in
// tests/e2e/.artifacts/hang/ and fails (hang-watch.ts).
const USAGE = 'usage: bun scripts/ci/flaky.ts [--job-started <epoch ms> --job-minutes <n>] <test files...>';
export type Quarantined = { file: string; test: string; reason: string };

const ROOT = resolve(import.meta.dir, '../..');
/** Where a run stopped at its deadline leaves its report; the shard's failure captures upload it. Tests point it at a temporary folder. */
const HANG_REPORT = resolve(ROOT, process.env.BOITE_HANG_REPORT ?? 'tests/e2e/.artifacts/hang');

export const QUARANTINE: Quarantined[] = JSON.parse(readFileSync(resolve(import.meta.dir, 'quarantine.json'), 'utf8')).tests;

/** Names of the failed tests in bun test output, or undefined unless every counted failure has one. */
export function failedTests(output: string): string[] | undefined {
  // Over several files, bun lists every failure again under "N tests failed:" before the counts.
  const clean = output.replace(/\x1b\[[0-9;]*m/g, '').replace(/^\d+ tests? failed:\r?\n(?:\(fail\) .*\r?\n)*/gm, '');
  const names = [...clean.matchAll(/^\(fail\) (.+?)(?: \[[\d.]+m?s\])?\r?$/gm)].map(match => match[1]!);
  const count = [...clean.matchAll(/^\s*(\d+) fail\r?$/gm)].reduce((sum, match) => sum + Number(match[1]), 0);
  return names.length > 0 && names.length === count ? names : undefined;
}

/** The entries that cover every failed test of these files (absolute or repo-relative), or undefined when one is not quarantined. */
export function quarantined(names: string[] | undefined, files: string[], list = QUARANTINE): Quarantined[] | undefined {
  if (!names?.length) return undefined;
  const ran = new Set(files.map(file => relative(ROOT, resolve(ROOT, file)).replaceAll('\\', '/')));
  const entries = names.map(name => list.find(entry => entry.test === name && ran.has(entry.file)));
  return entries.every(Boolean) ? [...new Set(entries as Quarantined[])] : undefined;
}

/** A `bun test -t` pattern selecting exactly these tests: bun prints `a > b` and matches `a b`. */
export function namePattern(entries: Quarantined[]): string {
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return `^(?:${entries.map(entry => entry.test.split(' > ').map(escape).join(' ')).join('|')})$`;
}

export function announce(entries: Quarantined[]): void {
  for (const entry of entries) console.log(`::warning file=${entry.file},title=Quarantined test retried::${entry.test} (${entry.reason})`);
}

interface Tests {
  child: Subprocess;
  output: () => string;
  stderr: () => string;
  exited: Promise<number>;
}

/** `bun test` with its output shown as it comes and kept, stdout and stderr apart. */
function spawnTests(command: string[]): Tests {
  const child = Bun.spawn(command, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', windowsHide: true });
  const text = { stdout: '', stderr: '' };
  const forward = async (stream: ReadableStream<Uint8Array>, sink: NodeJS.WriteStream, into: keyof typeof text) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      sink.write(chunk);
      text[into] += decoder.decode(chunk, { stream: true });
    }
    text[into] += decoder.decode();
  };
  const streams = Promise.all([forward(child.stdout, process.stdout, 'stdout'), forward(child.stderr, process.stderr, 'stderr')]);
  return {
    child,
    output: () => `${text.stdout}\n${text.stderr}`,
    stderr: () => text.stderr,
    exited: Promise.all([streams, child.exited]).then(([, code]) => code),
  };
}

/**
 * Runs `command`; with a deadline, under the watch, and stopped with a report
 * in HANG_REPORT when it passes. `stopped` is the report's summary.
 */
async function run(command: string[], deadline?: number): Promise<{ code: number; output: string; stopped?: string }> {
  if (deadline === undefined) {
    const tests = spawnTests(command);
    return { code: await tests.exited, output: tests.output() };
  }
  const progress = new TestProgress();
  const sampling = sampleEveryMinute(progress);
  let tests = spawnTests(inspectedTestCommand(command));
  let inspector: TestInspector | undefined;
  let missing: string | undefined;
  let stopped: Promise<string> | undefined;
  // The deadline covers the inspector's start too, and whichever bun runs then.
  const stop = () => {
    const pid = tests.child.pid;
    stopped ??= writeHangReport({ dir: HANG_REPORT, pid, deadline, progress, inspector, missing, output: tests.output(), samples: sampling.samples })
      .finally(() => killProcessTree(pid));
  };
  const timer = setTimeout(stop, Math.max(0, deadline - Date.now()));
  try {
    inspector = await connect(tests, progress);
  } catch (error) {
    missing = error instanceof Error ? error.message : String(error);
    // `--inspect-wait` has run no test yet: they run once, without the inspector.
    if (stopped === undefined && tests.child.exitCode === null) {
      console.log(`::warning title=Test run without the inspector::${missing}; the tests run without it, and a hang report then names no test`);
      killProcessTree(tests.child.pid);
      await tests.exited;
      tests = spawnTests(command);
    }
  }
  const code = await tests.exited;
  clearTimeout(timer);
  sampling.stop();
  const summary = await stopped;
  inspector?.close();
  return { code, output: tests.output(), ...(summary === undefined ? {} : { stopped: summary }) };
}

/** The watch on the inspector of `tests`, once bun printed its address and accepted the socket. */
async function connect(tests: Tests, progress: TestProgress): Promise<TestInspector> {
  const until = Date.now() + 60_000;
  let url: string | undefined;
  while ((url = inspectorAddress(tests.stderr())) === undefined && tests.child.exitCode === null && Date.now() < until) await Bun.sleep(50);
  if (url !== undefined) return TestInspector.connect(url, progress);
  throw new Error(tests.child.exitCode === null ? 'bun test never printed its inspector address within 60 s' : `bun test exited ${tests.child.exitCode} before its inspector listened`);
}

/** Value of `--name <value>` in `args`, removed from them. */
function option(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  if (at < 0) return undefined;
  const value = args[at + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value`);
  args.splice(at, 2);
  return value;
}

if (import.meta.main) {
  const files = process.argv.slice(2);
  const started = option(files, '--job-started');
  const minutes = option(files, '--job-minutes');
  if ((started === undefined) !== (minutes === undefined)) throw new Error('--job-started and --job-minutes go together');
  const deadline = started === undefined ? undefined : deadlineFor(Number(started), Number(minutes));
  if (deadline !== undefined && !Number.isFinite(deadline)) throw new Error(`--job-started ${started} --job-minutes ${minutes} is not a time`);
  if (!files.length) throw new Error(USAGE);
  const first = await run([process.execPath, 'test', ...files], deadline);
  const retry = first.code === 0 || first.stopped !== undefined ? undefined : quarantined(failedTests(first.output), files);
  if (first.stopped !== undefined) {
    fail(first.stopped);
    process.exitCode = 1;
  } else if (retry) {
    announce(retry);
    const again = [...new Set(retry.map(entry => entry.file))];
    console.log(`\nRetrying ${retry.length} quarantined test(s) once in ${again.join(', ')}`);
    const second = await run([process.execPath, 'test', ...again.map(file => resolve(ROOT, file)), '-t', namePattern(retry)], deadline);
    if (second.stopped !== undefined) fail(second.stopped);
    else console.log(second.code === 0 ? 'Quarantined tests passed on retry' : 'Quarantined tests failed again');
    process.exitCode = second.stopped === undefined ? second.code : 1;
  } else process.exitCode = first.code;
}

function fail(summary: string): void {
  console.log(`\n${summary}\nReport: ${relative(ROOT, HANG_REPORT)}`);
  // One annotation per line of the summary would drown the run page: the first two name the stop and the test.
  console.log(`::error title=Test run stopped at its deadline::${summary.split('\n').slice(0, 2).join(' ').replace(/[\r\n%]/g, ' ')}`);
}

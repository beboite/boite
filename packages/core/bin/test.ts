import { resolve } from 'node:path';

// Fresh processes avoid reusing native runtime state between test files.
const core = resolve(import.meta.dir, '..');
const args = process.argv.slice(2);
const workerOption = args.indexOf('--workers');
const workerValue = workerOption < 0
  ? process.env.BOITE_TEST_WORKERS ?? '4'
  : args.splice(workerOption, 2)[1];
const workers = Number(workerValue);
if (!Number.isInteger(workers) || workers < 1 || workers > 8) {
  throw new Error(`BOITE_TEST_WORKERS/--workers: expected an integer from 1 to 8, received ${workerValue}`);
}
if (!args.some(arg => arg === '--timeout' || arg.startsWith('--timeout='))) {
  args.push('--timeout', '60000');
}

// A file whose process stops answering, its event loop blocked where no test timeout can fire, is
// ended here with what it printed, rather than holding the whole run until the job is cancelled.
const fileDeadlineMs = Number(process.env.BOITE_TEST_FILE_DEADLINE_MS ?? 300_000);
if (!Number.isInteger(fileDeadlineMs) || fileDeadlineMs < 1000) {
  throw new Error(`BOITE_TEST_FILE_DEADLINE_MS: expected at least 1000, received ${process.env.BOITE_TEST_FILE_DEADLINE_MS}`);
}

const files = [...new Bun.Glob('**/*.test.ts').scanSync({ cwd: resolve(core, 'test') })].sort();
if (!files.length) throw new Error(`${resolve(core, 'test')}: expected at least one .test.ts file`);
const running = new Set<Bun.Subprocess>();
const failures: string[] = [];
const totals = { pass: 0, skip: 0, fail: 0 };
const started = performance.now();
let next = 0;
let completed = 0;
let halted = false;
let interrupted = false;

function stop() {
  interrupted = true;
  halted = true;
  for (const child of running) child.kill();
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

async function runFile(file: string) {
  const child = Bun.spawn([process.execPath, 'test', resolve(core, 'test', file), ...args], {
    cwd: core, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', windowsHide: true,
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
  });
  running.add(child);
  let overdue = false;
  const deadline = setTimeout(() => {
    overdue = true;
    child.kill();
  }, fileDeadlineMs);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    console.log(`\n=== ${file} (exit ${code}${overdue ? `, ended after ${fileDeadlineMs} ms without finishing` : ''}) ===`);
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
    const output = (stdout + '\n' + stderr).replace(/\x1b\[[0-9;]*m/g, '');
    for (const field of ['pass', 'skip', 'fail'] as const) {
      totals[field] += Number(output.match(new RegExp(`(?:^|\\n)\\s*(\\d+) ${field}\\s*(?:\\n|$)`))?.[1] ?? 0);
    }
    if (code !== 0) failures.push(file);
    completed++;
  } finally {
    clearTimeout(deadline);
    // Also reap a captured process if reading its output failed.
    if (child.exitCode === null) child.kill();
    await child.exited;
    running.delete(child);
  }
}

try {
  const results = await Promise.allSettled(Array.from({ length: Math.min(workers, files.length) }, async () => {
    while (!halted) {
      const file = files[next++];
      if (!file) return;
      await runFile(file);
    }
  }));
  const errors = results.filter(result => result.status === 'rejected');
  if (errors.length) throw new AggregateError(errors.map(result => result.reason), 'Core test runner failed');
} finally {
  halted = true;
  for (const child of running) child.kill();
  await Promise.all([...running].map(child => child.exited));
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
}

console.log(`\nCore: ${totals.pass} pass, ${totals.skip} skip, ${totals.fail} fail; ${completed}/${files.length} files; ${((performance.now() - started) / 1000).toFixed(2)} s`);
if (failures.length) console.error(`Failed files:\n${failures.join('\n')}`);
process.exitCode = interrupted ? 130 : failures.length ? 1 : 0;

import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const repo = join(import.meta.dir, '../..');

/** The steps of one job of a workflow, by name, as raw YAML text. */
function steps(job: string, file = 'ci.yml'): Map<string, string> {
  const workflow = readFileSync(join(repo, '.github/workflows', file), 'utf8');
  const start = workflow.indexOf(`\n  ${job}:\n`);
  if (start < 0) throw new Error(`${file}: no job ${job}`);
  const end = workflow.slice(start + 1).search(/\n {2}[a-z][\w-]*:\n/);
  const body = end < 0 ? workflow.slice(start) : workflow.slice(start, start + 1 + end);
  const named = new Map<string, string>();
  for (const step of body.split(/\n {6}- /).slice(1)) {
    const name = /^name: (.+)$/m.exec(step)?.[1]?.trim();
    if (name) named.set(name, step);
  }
  return named;
}

test('the Windows E2E steps keep Chrome profiles and data directories on the runner temp drive', () => {
  // On C:, Chrome held page loads for 15 to 60 s after the server had answered
  // (PR #513): the shards failed on a different test in about one run in four.
  // The first shard holds the steps; the others alias them (`*e2e-steps`).
  const e2e = steps('e2e-1');
  for (const name of ['Prepare end-to-end tests', 'Browser and core end-to-end tests']) {
    const step = e2e.get(name);
    if (step === undefined) throw new Error(`ci.yml: the e2e-1 job has no step named ${name}`);
    expect(step).toMatch(/^ {8}env:\n(?: {10}\S.*\n)*? {10}TEMP: \$\{\{ runner\.temp \}\}$/m);
    expect(step).toMatch(/^ {8}env:\n(?: {10}\S.*\n)*? {10}TMP: \$\{\{ runner\.temp \}\}$/m);
  }
});

test('the native shell E2E step keeps test shells and their WebView2 profiles on the runner temp drive', () => {
  // On C:, the first document request waited for the fresh profile's cookie
  // database: 1.1 s on average and 10.4 s at worst, against 0.5 s at worst on
  // D:. The page stayed about:blank past the 15 s wait in five runs.
  const step = steps('windows', 'desktop.yml').get('Native shell end-to-end tests');
  if (step === undefined) throw new Error('desktop.yml: the windows job has no step named Native shell end-to-end tests');
  expect(step).toMatch(/^ {8}env:\n(?: {10}\S.*\n)*? {10}TEMP: \$\{\{ runner\.temp \}\}$/m);
  expect(step).toMatch(/^ {8}env:\n(?: {10}\S.*\n)*? {10}TMP: \$\{\{ runner\.temp \}\}$/m);
});

test('every E2E shard stops a hung run before its job limit and uploads the report', () => {
  // A shard cut by its 35 min limit kept no log and no artifact (run
  // 39321123064): the run must end itself, from a deadline counted from the
  // job's first step, while the upload step can still run.
  const workflow = readFileSync(join(repo, '.github/workflows/ci.yml'), 'utf8');
  const e2e = steps('e2e-1');
  expect([...e2e.keys()][0]).toBe('Note when the job started');
  expect(e2e.get('Note when the job started')).toContain('BOITE_JOB_STARTED_MS=');
  const run = e2e.get('Browser and core end-to-end tests') ?? '';
  const minutes = /bun scripts\/ci\/flaky\.ts --job-started \$env:BOITE_JOB_STARTED_MS --job-minutes (\d+) @files/.exec(run)?.[1];
  expect(minutes).toBeDefined();
  for (const job of ['e2e-1', 'e2e-2', 'e2e-3']) {
    const start = workflow.indexOf(`\n  ${job}:\n`);
    expect(/timeout-minutes: (\d+)/.exec(workflow.slice(start))?.[1], job).toBe(minutes);
  }
  const upload = workflow.slice(workflow.indexOf('name: e2e-${{ env.E2E_SHARD }}-failure-captures') - 300);
  expect(upload).toMatch(/if: failure\(\) \|\| cancelled\(\)\n\s+with:\n\s+name: e2e-\$\{\{ env\.E2E_SHARD \}\}-failure-captures\n\s+path: tests\/e2e\/\.artifacts\//);
});

test('every E2E teardown names a deadline of at least 30 s', () => {
  // Bun gives a hook 5 s by default. Closing a browser on the Windows runner
  // took 7 s, and the file failed after all its tests had passed.
  const short: string[] = [];
  const dir = join(repo, 'tests/e2e');
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.test.ts'))) {
    const text = readFileSync(join(dir, file), 'utf8');
    for (const match of text.matchAll(/\bafterAll\(/g)) {
      let depth = 1;
      let index = (match.index ?? 0) + match[0].length;
      while (depth > 0 && index < text.length) {
        const char = text[index];
        if (char === '(') depth += 1;
        else if (char === ')') depth -= 1;
        index += 1;
      }
      const call = text.slice(match.index, index);
      const deadline = /,\s*([\d_]+)\s*\)$/.exec(call)?.[1];
      if (deadline === undefined || Number(deadline.replaceAll('_', '')) < 30_000) {
        short.push(`${file}:${text.slice(0, match.index).split('\n').length}`);
      }
    }
  }
  expect(short).toEqual([]);
});

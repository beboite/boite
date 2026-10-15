import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const repo = join(import.meta.dir, '../..');

/** The steps of one job of ci.yml, by name, as raw YAML text. */
function steps(job: string): Map<string, string> {
  const workflow = readFileSync(join(repo, '.github/workflows/ci.yml'), 'utf8');
  const start = workflow.indexOf(`\n  ${job}:\n`);
  if (start < 0) throw new Error(`ci.yml: no job ${job}`);
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
  const e2e = steps('e2e');
  for (const name of ['Prepare end-to-end tests', 'Browser and core end-to-end tests']) {
    const step = e2e.get(name);
    if (step === undefined) throw new Error(`ci.yml: the e2e job has no step named ${name}`);
    expect(step).toMatch(/^ {8}env:\n(?: {10}\S.*\n)*? {10}TEMP: \$\{\{ runner\.temp \}\}$/m);
    expect(step).toMatch(/^ {8}env:\n(?: {10}\S.*\n)*? {10}TMP: \$\{\{ runner\.temp \}\}$/m);
  }
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

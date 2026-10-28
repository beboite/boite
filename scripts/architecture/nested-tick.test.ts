import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ROOTS } from './inventory.ts';
import { BUN_TEST_ROOTS, nestedTickSites, readBunTestSources } from './nested-tick.ts';

// Built from parts so that this file does not trip the check it tests.
const REJECTS = 'rej' + 'ects';
const RESOLVES = 'res' + 'olves';
const sites = (source: string) => nestedTickSites(new Map([['a.test.ts', source]]));

test('every way of reaching the matchers from expect is found, on the line of the matcher', () => {
  expect(sites([
    `await expect(call()).${REJECTS}.toThrow('refused');`,
    `await expect(call())['${REJECTS}'].toThrow();`,
    'await expect(read()).',
    `  ${RESOLVES}.toEqual(1);`,
    'await expect(read({ a: [1, (2)] }))',
    `  .not.${RESOLVES}.toBeNull();`,
    `await expect<number>(read())?.${RESOLVES}.toBe(1);`,
    `const label = \`\${await expect(read()).${RESOLVES}.toBe(1)}\`;`,
  ].join('\n'))).toEqual(['a.test.ts:1', 'a.test.ts:2', 'a.test.ts:4', 'a.test.ts:6', 'a.test.ts:7', 'a.test.ts:8']);
});

test('strings, comments, regular expressions and other objects stay quiet', () => {
  expect(sites([
    "expect(await thrown(call())).toThrow('refused');",
    'expect(await read()).not.toBeNull();',
    `const s = "expect(p).${REJECTS}.toThrow()";`,
    `const t = \`expect(p).${REJECTS}.toThrow() \${'a'}\`;`,
    `const safe = 1; // expect(p).${REJECTS}.toThrow()`,
    '/*',
    `  expect(p).${REJECTS}.toThrow()`,
    '*/',
    `const pattern = /expect\\(p\\)\\.${REJECTS}/;`,
    `queue.${REJECTS}.push(error);`,
    `await assert.${REJECTS}(import('./missing.ts'));`,
    `const ratio = total / 2; expect(ratio).toBe(1); const half = /x\\/y/.test('expect(p).${REJECTS}');`,
  ].join('\n'))).toEqual([]);
});

test('files of every extension bun test loads are read, declarations are not', () => {
  const root = mkdtempSync(join(tmpdir(), 'nested-tick-'));
  try {
    for (const name of ['a.test.ts', 'b.test.tsx', 'c.test.js', 'd.test.jsx', 'e.test.mjs', 'f.test.cts', 'helper.mts', 'types.d.ts', 'notes.md']) {
      writeFileSync(join(root, name), `await expect(p).${REJECTS}.toThrow();\n`);
    }
    mkdirSync(join(root, 'node_modules'));
    writeFileSync(join(root, 'node_modules/dep.test.ts'), `await expect(p).${REJECTS}.toThrow();\n`);
    expect([...readBunTestSources([root]).keys()].map(file => file.slice(root.length + 1)).sort())
      .toEqual(['a.test.ts', 'b.test.tsx', 'c.test.js', 'd.test.jsx', 'e.test.mjs', 'f.test.cts', 'helper.mts']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('check:architecture fails on a promise matcher, naming the nested tick and the docs', () => {
  const root = mkdtempSync(join(tmpdir(), 'nested-tick-check-'));
  try {
    for (const dir of [...ROOTS, 'scripts/architecture', ...BUN_TEST_ROOTS]) {
      mkdirSync(join(root, dir), { recursive: true });
    }
    writeFileSync(join(root, 'scripts/architecture/size-budget.json'), '{ "ceiling": 900, "allow": {}, "exempt": {} }\n');
    const check = () => Bun.spawnSync([process.execPath, resolve(import.meta.dir, 'check.ts')], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
    expect(check().exitCode).toBe(0);
    writeFileSync(join(root, 'tests/sample.test.ts'), `await expect(call()).${REJECTS}.toThrow('refused');\n`);
    const failed = check();
    expect(failed.exitCode).not.toBe(0);
    expect(failed.stderr.toString()).toContain('tests/sample.test.ts:1: a rejects or resolves matcher runs a nested event loop tick under bun test');
    expect(failed.stderr.toString()).toContain('docs/development.md#promise-matchers-under-bun-test');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

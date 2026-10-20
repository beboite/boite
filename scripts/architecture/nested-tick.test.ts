import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nestedTickSites, nestedTickViolations, readBunTestSources } from './nested-tick.ts';

// Built from parts so that this file does not trip the check it tests.
const REJECTS = '.' + 'rejects';
const RESOLVES = '.' + 'resolves';

test('a promise matcher in a file bun test runs fails the check, naming the nested tick and the docs', () => {
  const root = mkdtempSync(join(tmpdir(), 'nested-tick-'));
  try {
    mkdirSync(join(root, 'test'));
    writeFileSync(join(root, 'test/sample.test.ts'), [
      "import { expect, test } from 'bun:test';",
      "test('refused', async () => {",
      `  await expect(call())${REJECTS}.toThrow('refused');`,
      '  await expect(read())',
      `    ${RESOLVES}.not.toBeNull();`,
      '});',
    ].join('\n'));
    const [first, second, ...rest] = nestedTickViolations(readBunTestSources([root]));
    expect(rest).toEqual([]);
    expect(first).toStartWith(`${root}/test/sample.test.ts:3: a rejects or resolves matcher runs a nested event loop tick under bun test`);
    expect(first).toContain('docs/development.md#promise-matchers-under-bun-test');
    expect(second).toStartWith(`${root}/test/sample.test.ts:5:`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('awaited matchers, comments and node:assert pass', () => {
  expect(nestedTickSites(new Map([['a.test.ts', [
    "expect(await thrown(call())).toThrow('refused');",
    'expect(await read()).not.toBeNull();',
    `// with expect(p)${REJECTS}.toThrow() the outer tick lost its events`,
    `await assert${REJECTS}(import('./missing.ts'));`,
  ].join('\n')]]))).toEqual([]);
});

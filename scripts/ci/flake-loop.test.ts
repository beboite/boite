import { expect, test } from 'bun:test';
import { failureBlock, results, summary } from './flake-loop.ts';

const output = [
  '(pass) first [12.50ms]',
  'error: the client is closed: the socket closed (1002)',
  '      at call (client.ts:203:29)',
  '(fail) group > second [1.20s]',
  '(pass) third',
].join('\n');

const junit = `<testsuites>
  <testsuite name="a.test.ts">
    <testcase name="first" classname="" time="0.0125" file="a.test.ts" line="1" assertions="1" />
    <testsuite name="group">
      <testcase name="second &quot;quoted&quot;" classname="group" time="1.2" file="a.test.ts" line="5" assertions="0">
        <failure type="AssertionError" />
      </testcase>
    </testsuite>
    <testcase name="filtered" classname="" time="0" file="a.test.ts" line="9" assertions="0">
      <skipped />
    </testcase>
  </testsuite>
</testsuites>`;

test('results reads each test the report names, its outcome and its duration, skipped ones left out', () => {
  expect(results(junit)).toEqual([
    { file: 'a.test.ts', name: 'first', passed: true, ms: 12.5 },
    { file: 'a.test.ts', name: 'group > second "quoted"', passed: false, ms: 1200 },
  ]);
});

test('a failure block runs from the end of the test before to its fail line', () => {
  expect(failureBlock(output, 'group > second')).toBe('error: the client is closed: the socket closed (1002)\n      at call (client.ts:203:29)\n(fail) group > second [1.20s]');
  expect(failureBlock(output, 'missing')).toBe('');
});

test('the summary puts the most failed test first and counts every failure', () => {
  const table = summary(new Map([
    ['a.test.ts: steady', { pass: 3, fail: 0, ms: [10, 20, 30] }],
    ['a.test.ts: flaky | piped', { pass: 1, fail: 2, ms: [5, 50, 500] }],
  ]), 3);
  expect(table.split('\n')[2]).toBe('| a.test.ts: flaky \\| piped | 2 | 1 | 50 | 500 | 500 |');
  expect(table).toEndWith('3 runs, 2 failures');
});

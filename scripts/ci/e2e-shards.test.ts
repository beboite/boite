import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { assignShards, e2eFiles, fileDurations, mergeDurations, readDurations } from './e2e-shards.ts';

test('files go longest first to the lightest shard, each exactly once', () => {
  const seconds = { 'a.test.ts': 10, 'b.test.ts': 9, 'c.test.ts': 6, 'd.test.ts': 5, 'e.test.ts': 4, 'f.test.ts': 2 };
  const shards = assignShards(Object.keys(seconds), seconds, 3);
  expect(shards).toEqual([
    { files: ['a.test.ts', 'f.test.ts'], seconds: 12 },
    { files: ['b.test.ts', 'e.test.ts'], seconds: 13 },
    { files: ['c.test.ts', 'd.test.ts'], seconds: 11 },
  ]);
  // Input order changes nothing: every runner computes the same split.
  expect(assignShards(Object.keys(seconds).reverse(), seconds, 3)).toEqual(shards);
});

test('a file with no recorded time counts as the median one', () => {
  const seconds = { 'a.test.ts': 30, 'b.test.ts': 4, 'c.test.ts': 2 };
  const shards = assignShards(['a.test.ts', 'b.test.ts', 'c.test.ts', 'new.test.ts'], seconds, 2);
  expect(shards).toEqual([{ files: ['a.test.ts'], seconds: 30 }, { files: ['b.test.ts', 'c.test.ts', 'new.test.ts'], seconds: 10 }]);
  expect(() => assignShards(['a.test.ts'], seconds, 0)).toThrow('shard count');
});

test('a job log gives each file the time until the next file or the summary', () => {
  const log = [
    '2026-10-17T19:52:17.3617105Z --shard=3/3: running 2/116 test files',
    '2026-10-17T19:52:17.3619719Z ##[group]tests\\e2e\\agents.test.ts:',
    '2026-10-17T19:52:30.5877580Z (pass) a test [13169.60ms]',
    '2026-10-17T19:52:30.5878198Z ##[endgroup]',
    '2026-10-17T19:52:30.5878449Z \x1b[0m##[group]tests\\e2e\\sub\\ui.test.ts:',
    '2026-10-17T19:52:37.2014420Z  2 pass',
    '2026-10-17T19:52:37.6738134Z Ran 2 tests across 2 files. [20.32s]',
  ].join('\r\n');
  expect(fileDurations(log)).toEqual({ 'tests/e2e/agents.test.ts': 13.2, 'tests/e2e/sub/ui.test.ts': 7.1 });
  expect(mergeDurations([{ 'x.test.ts': 4 }, { 'x.test.ts': 6, 'y.test.ts': 1 }])).toEqual({ 'x.test.ts': 5, 'y.test.ts': 1 });
});

test('the recorded times split the current E2E files into three shards within 15 %', () => {
  const files = e2eFiles();
  expect(files).not.toContain('tests/e2e/shell.test.ts');
  expect(files.every((file) => existsSync(join(import.meta.dir, '../..', file)))).toBe(true);
  const shards = assignShards(files, readDurations().seconds, 3);
  expect(shards.flatMap((shard) => shard.files).sort()).toEqual(files);
  const times = shards.map((shard) => shard.seconds);
  expect(Math.max(...times) / Math.min(...times)).toBeLessThan(1.15);
});

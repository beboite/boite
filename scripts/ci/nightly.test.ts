import { expect, test } from 'bun:test';
import { needsNightly, nightlyVersion } from './nightly.ts';

test('nightly versions count daily builds and reuse a reserved version after failure', () => {
  const sha = 'a'.repeat(40);
  expect(nightlyVersion('2.0.0-beta.1', '20260915', sha, [])).toBe('2.0.0-nightly.20260915.1');
  const tags = [{ name: 'v2.0.0-nightly.20260915.1', commit: { sha } }];
  expect(nightlyVersion('2.0.0-beta.1', '20260915', 'b'.repeat(40), tags)).toBe('2.0.0-nightly.20260915.2');
  expect(nightlyVersion('2.0.0-beta.1', '20260916', sha, tags)).toBe('2.0.0-nightly.20260915.1');
  expect(nightlyVersion('2.0.0-beta.1', '20260916', 'b'.repeat(40), tags)).toBe('2.0.0-nightly.20260916.1');
});

test('nightly retries unpublished commits and skips already published commits', () => {
  const head = 'a'.repeat(40);
  expect(needsNightly(head, [])).toBe(true);
  expect(needsNightly(head, ['b'.repeat(40)])).toBe(true);
  expect(needsNightly(head, [head])).toBe(false);
});

test('nightly refuses branch names instead of silently skipping a revision', () => {
  expect(() => needsNightly('main', [])).toThrow('full commit SHA');
});

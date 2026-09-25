import { expect, test } from 'bun:test';
import { bunMismatch, pinnedBun } from './bun-version.ts';

test('the pinned Bun is read from packageManager, and anything else is refused by name', () => {
  expect(pinnedBun(JSON.stringify({ packageManager: 'bun@1.4.2' }))).toBe('1.4.2');
  expect(() => pinnedBun(JSON.stringify({ packageManager: 'npm@10.0.0' }))).toThrow('"npm@10.0.0"');
  expect(() => pinnedBun('{}')).toThrow('packageManager must be bun@<x.y.z>');
});

test('another Bun is refused with both versions, unless the build asks for it', () => {
  expect(bunMismatch('the sidecar', '1.4.2', '1.4.2', false)).toBeNull();
  const reason = bunMismatch('the sidecar', '1.3.9', '1.4.2', false);
  expect(reason).toContain('Bun 1.3.9');
  expect(reason).toContain('bun@1.4.2');
  expect(reason).toContain('BOITE_ALLOW_BUN_MISMATCH=1');
  expect(bunMismatch('the sidecar', '1.3.9', '1.4.2', true)).toBeNull();
});

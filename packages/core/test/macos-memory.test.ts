import { expect, test } from 'bun:test';
import { MacMemory, residentMemory } from '../src/platform/macos-memory.ts';

test('macOS decodes the physical footprint, not the resident size that counts shared libraries', () => {
  const bytes = new Uint8Array(96);
  const view = new DataView(bytes.buffer);
  view.setBigUint64(64, 900n * 1024n * 1024n, true);
  view.setBigUint64(72, 256n * 1024n * 1024n, true);
  view.setBigUint64(80, 123n, true);
  expect(residentMemory(bytes)).toBe(256 * 1024 ** 2);
});

test('macOS samples only registered live processes and forgets exited ones', () => {
  const sizes = new Map([[10, 100], [20, 200]]);
  const load = new MacMemory(pid => sizes.get(pid) ?? null);
  load.add('one', 10);
  load.add('one', 11);
  load.add('two', 20);
  expect(load.sample('one')).toEqual({ processes: 1, cpuPercent: 0, memoryBytes: 100, workingSets: [{ pid: 10, bytes: 100 }] });
  expect(load.sample('two')?.memoryBytes).toBe(200);
  sizes.set(10, 300);
  expect(load.sample('one')?.memoryBytes).toBe(300);
  load.remove('one', 10);
  expect(load.sample('one')).toBeNull();
  load.remove('one', 11);
  expect(load.sample('one')).toBeNull();
});

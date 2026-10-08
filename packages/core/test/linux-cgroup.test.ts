import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cgroupPath, readCgroupMemory } from '../src/platform/linux-cgroup.ts';
import { createPosixPlatform } from '../src/platform/posix.ts';

const SCOPE = '/user.slice/agents.slice/run-r1.scope';
const GB = 1024 ** 3;

let root: string;
let roots: { proc: string; cgroup: string };

/** A temporary `/proc` and `/sys/fs/cgroup` the test rewrites between readings. */
function group(pid: number, line: string, files: Record<string, string>, path = SCOPE): void {
  mkdirSync(join(roots.proc, String(pid)), { recursive: true });
  writeFileSync(join(roots.proc, String(pid), 'cgroup'), line);
  mkdirSync(join(roots.cgroup, path), { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(roots.cgroup, path, name), text);
}

const events = (high: number) => `low 0\nhigh ${high}\nmax 0\noom 0\noom_kill 0\n`;
/** The two lines the kernel writes, `some` first; the notice reads the `some` total. */
const pressure = (micros: number) => `some avg10=12.50 avg60=3.10 avg300=0.70 total=${micros}\nfull avg10=11.00 avg60=2.90 avg300=0.60 total=${micros - 1}\n`;
const scope = (high: number, patch: Record<string, string> = {}) => ({
  'memory.events': events(high), 'memory.pressure': pressure(high * 500_000), 'memory.high': `${5 * GB}\n`, 'memory.max': `${6 * GB}\n`, 'memory.current': `${5 * GB - 4096}\n`, ...patch,
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'boite-cgroup-'));
  roots = { proc: join(root, 'proc'), cgroup: join(root, 'cgroup') };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('cgroup memory reader', () => {
  test('follows a rising high count with both limits and the current charge', () => {
    group(41, `0::${SCOPE}\n`, scope(3));
    expect(readCgroupMemory(41, roots)).toEqual({ path: SCOPE, highEvents: 3, stallMicros: 1_500_000, highBytes: 5 * GB, maxBytes: 6 * GB, currentBytes: 5 * GB - 4096 });
    writeFileSync(join(roots.cgroup, SCOPE, 'memory.events'), events(19));
    writeFileSync(join(roots.cgroup, SCOPE, 'memory.pressure'), pressure(9_750_000));
    expect(readCgroupMemory(41, roots)).toMatchObject({ highEvents: 19, stallMicros: 9_750_000 });
  });

  test('a missing process, group or file gives null', () => {
    expect(readCgroupMemory(7, roots)).toBeNull();
    mkdirSync(join(roots.proc, '8'), { recursive: true });
    writeFileSync(join(roots.proc, '8', 'cgroup'), `0::${SCOPE}\n`);
    expect(readCgroupMemory(8, roots)).toBeNull();
    for (const missing of ['memory.events', 'memory.pressure', 'memory.high', 'memory.max', 'memory.current']) {
      group(9, `0::${SCOPE}\n`, scope(1));
      rmSync(join(roots.cgroup, SCOPE, missing));
      expect(readCgroupMemory(9, roots)).toBeNull();
    }
  });

  test('a group with no throttling boundary gives null, one with no hard limit still reads', () => {
    group(10, `0::${SCOPE}\n`, scope(1, { 'memory.high': 'max\n' }));
    expect(readCgroupMemory(10, roots)).toBeNull();
    group(10, `0::${SCOPE}\n`, scope(1, { 'memory.max': 'max\n' }));
    expect(readCgroupMemory(10, roots)).toMatchObject({ highBytes: 5 * GB, maxBytes: null });
  });

  test('cgroup v1 lines, a path outside the namespace and malformed counts give null', () => {
    group(11, `12:memory:${SCOPE}\n11:cpu,cpuacct:${SCOPE}\n1:name=systemd:${SCOPE}\n`, scope(1));
    expect(readCgroupMemory(11, roots)).toBeNull();
    group(12, `0::/../other.scope\n`, scope(1));
    expect(readCgroupMemory(12, roots)).toBeNull();
    group(13, `0::${SCOPE}\n`, scope(1, { 'memory.events': 'low 0\nmax 0\n' }));
    expect(readCgroupMemory(13, roots)).toBeNull();
    group(13, `0::${SCOPE}\n`, scope(1, { 'memory.current': 'many\n' }));
    expect(readCgroupMemory(13, roots)).toBeNull();
    // A pressure file with no `some` line is no stall reading, whatever the count says.
    group(13, `0::${SCOPE}\n`, scope(900, { 'memory.pressure': 'full avg10=0.00 avg60=0.00 avg300=0.00 total=7\n' }));
    expect(readCgroupMemory(13, roots)).toBeNull();
    // A hybrid host names its v1 controllers beside the unified line.
    expect(cgroupPath(`1:name=systemd:/a\n0::/b\n`)).toBe('/b');
  });

  test('only Linux reads a cgroup', () => {
    expect(createPosixPlatform('macos', null).cgroupMemory?.(process.pid)).toBeNull();
  });
});

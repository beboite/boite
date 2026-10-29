import { expect, test } from 'bun:test';
import { MacMemory, macChildPids, macProcessIdentity, residentMemory } from '../src/platform/macos-memory.ts';
import { createPosixPlatform } from '../src/platform/posix.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bus } from '../src/bus.ts';
import { Journal } from '../src/journal.ts';
import { ProcRegistry } from '../src/procs.ts';
import { DEFAULT_SETTINGS } from '../src/settings.ts';

function tree() {
  const nodes = new Map([
    [10, { parentPid: 1, birth: 10n, bytes: 100 }],
    [11, { parentPid: 10, birth: 11n, bytes: 200 }],
    [12, { parentPid: 11, birth: 12n, bytes: 300 }],
    [20, { parentPid: 1, birth: 20n, bytes: 400 }],
  ]);
  const stopped: number[] = [];
  const load = new MacMemory(
    pid => nodes.get(pid)?.bytes ?? null,
    pid => [...nodes].filter(([, node]) => node.parentPid === pid).map(([child]) => child),
    pid => nodes.get(pid) ?? null,
    pid => { stopped.push(pid); },
  );
  return { nodes, stopped, load, platform: createPosixPlatform('macos', load) };
}

test('macOS accounts for nested build workers once and can stop a sampled descendant tree', () => {
  const { load, platform, stopped } = tree();
  platform.pidAdded('agent', 10, true);
  platform.pidAdded('agent', 11, false);
  expect(platform.sample('agent')).toMatchObject({ processes: 3, memoryBytes: 600, cpuPercent: 0,
    cpuMeasured: false, memoryMeasured: true, workingSets: [{ pid: 10, bytes: 100 }, { pid: 11, bytes: 200 }, { pid: 12, bytes: 300 }] });
  expect(platform.terminateProcess('agent', 11)).toBe(true);
  expect(stopped.sort((a, b) => a - b)).toEqual([11, 12]);
  load.remove('agent', 11);
  expect(platform.sample('agent')?.memoryBytes).toBe(600);
});

test('macOS excludes another conversation subtree from accounting and termination', () => {
  const { platform, stopped } = tree();
  platform.pidAdded('agent', 10, true);
  platform.pidAdded('nested', 11, true);
  expect(platform.sample('agent')?.memoryBytes).toBe(100);
  expect(platform.sample('nested')?.memoryBytes).toBe(500);
  expect(platform.terminateProcess('agent', 11)).toBe(false);
  expect(platform.terminateProcess('agent', 20)).toBe(false);
  expect(platform.terminateProcess('agent', 10)).toBe(true);
  expect(stopped).toEqual([10]);
});

test('macOS terminateProcess stops an unregistered sampled worker and its new children', () => {
  const { nodes, platform, stopped } = tree();
  platform.pidAdded('agent', 10, true);
  platform.sample('agent');
  nodes.set(13, { parentPid: 12, birth: 13n, bytes: 50 });
  expect(platform.terminateProcess('agent', 11)).toBe(true);
  expect(stopped.sort((a, b) => a - b)).toEqual([11, 12, 13]);
});

test('macOS refuses reused roots, reused sampled workers, unknown threads and reparented workers', () => {
  const { nodes, platform, stopped } = tree();
  platform.pidAdded('agent', 10, true);
  platform.sample('agent');
  expect(platform.terminateProcess('other', 11)).toBe(false);
  expect(platform.terminateProcess('agent', 11, null)).toBe(false);
  expect(platform.terminateProcess('agent', 11, 1000)).toBe(false);
  nodes.get(11)!.birth = 99n;
  expect(platform.terminateProcess('agent', 11)).toBe(false);
  nodes.get(11)!.birth = 11n;
  nodes.get(11)!.parentPid = 20;
  expect(platform.terminateProcess('agent', 11)).toBe(false);
  nodes.get(11)!.parentPid = 10;
  nodes.get(10)!.birth = 100n;
  expect(platform.sample('agent')).toBeNull();
  expect(platform.terminateProcess('agent', 10)).toBe(false);
  expect(stopped).toEqual([]);
});

test('macOS rechecks tree members before signalling and tolerates a disappearing worker', () => {
  const { nodes, load } = tree();
  const stopped: number[] = [];
  const guarded = new MacMemory(pid => nodes.get(pid)?.bytes ?? null,
    pid => [...nodes].filter(([, node]) => node.parentPid === pid).map(([child]) => child),
    pid => nodes.get(pid) ? { ...nodes.get(pid)! } : null,
    pid => { stopped.push(pid); if (pid === 12) nodes.get(11)!.birth = 99n; });
  guarded.add('agent', 10);
  guarded.sample('agent');
  expect(guarded.killTree(11, 'agent')).toBe(false);
  expect(stopped).toEqual([12]);
  load.add('agent', 10);
  nodes.delete(12);
  expect(load.sample('agent')).toMatchObject({ memoryBytes: 300, processes: 2 });
  load.remove('agent', 10);
  expect(load.sample('agent')).toBeNull();
  expect(load.killTree(11, 'agent')).toBe(false);
});

test('macOS handles overlapping roots even when a registered grandchild precedes its parent', () => {
  const { nodes, platform, stopped } = tree();
  nodes.set(13, { parentPid: 12, birth: 13n, bytes: 50 });
  nodes.set(14, { parentPid: 13, birth: 14n, bytes: 50 });
  platform.pidAdded('agent', 10, true);
  platform.pidAdded('agent', 13, false);
  expect(platform.sample('agent')?.memoryBytes).toBe(700);
  expect(platform.terminateProcess('agent', 11)).toBe(true);
  expect(stopped).toEqual([14, 13, 12, 11]);
});

test('macOS decodes the public BSD identity without losing microseconds', () => {
  const bytes = new Uint8Array(136);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, 42, true);
  view.setBigUint64(120, 1_792_000_000n, true);
  view.setBigUint64(128, 123_456n, true);
  expect(macProcessIdentity(bytes)).toEqual({ parentPid: 42, birth: 1_792_000_000_123_456n });
});

test('macOS child enumeration uses PID counts and retries a buffer filled by new children', () => {
  let reads = 0;
  const children = macChildPids(10, (pid, buffer) => {
    expect(pid).toBe(10);
    if (buffer === null) return 1;
    reads++;
    if (reads === 1) { buffer.set([11, 12]); return 2; }
    buffer.set([11, 12, 13]);
    return 3;
  });
  expect(children).toEqual([11, 12, 13]);
  expect(reads).toBe(2);
  expect(macChildPids(10, () => -1)).toEqual([]);
  expect(macChildPids(10, (_pid, buffer) => buffer === null ? 2 : -1)).toEqual([]);
});

test.each([false, true])('macOS governor includes build memory, protects the root and refuses a reused victim: reused=%s', async reused => {
  const directory = mkdtempSync(join(tmpdir(), 'boite-macos-memory-'));
  const previous = process.env.BOITE_DATA_DIR;
  process.env.BOITE_DATA_DIR = directory;
  const journal = new Journal(join(directory, 'journal.db'));
  const bus = new Bus();
  const { nodes, platform, stopped } = tree();
  const pidAdded = platform.pidAdded;
  platform.pidAdded = (threadId, pid, internal) => {
    nodes.set(pid, { parentPid: 1, birth: BigInt(pid), bytes: 900 * 1024 ** 2 });
    pidAdded(threadId, pid, internal);
  };
  const registry = new ProcRegistry(journal, bus, platform);
  try {
    const root = registry.spawn('agent', process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { cwd: directory });
    nodes.get(11)!.parentPid = root.record.pid;
    nodes.get(11)!.bytes = 800 * 1024 ** 2;
    nodes.delete(12);
    registry.applySettings({ ...DEFAULT_SETTINGS, threadMemoryCapMb: 1024 });
    const events: unknown[] = [];
    bus.onAny((name, payload) => {
      if (name !== 'resources.memory') return;
      events.push(payload);
      if (reused && 'kind' in payload && payload.kind === 'pressure') nodes.get(11)!.birth = 99n;
    });
    (registry as unknown as { sampleLoad(): void }).sampleLoad();
    expect(registry.memory.status().agentBytes).toBe(1700 * 1024 ** 2);
    expect(stopped).toEqual(reused ? [] : [11]);
    const event = expect.objectContaining({ kind: 'killed', pid: 11, reason: 'thread-quota' });
    if (reused) expect(events).not.toContainEqual(event);
    else expect(events).toContainEqual(event);
    expect(root.proc.exitCode).toBeNull();
  } finally {
    await registry.killAll();
    await registry.close();
    bus.dispose();
    journal.close();
    if (previous === undefined) delete process.env.BOITE_DATA_DIR;
    else process.env.BOITE_DATA_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});

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
  const load = new MacMemory(pid => sizes.get(pid) ?? null, () => [],
    pid => sizes.has(pid) ? { parentPid: 1, birth: BigInt(pid) } : null);
  load.add('one', 10);
  load.add('one', 11);
  load.add('two', 20);
  expect(load.sample('one')).toEqual({ processes: 1, cpuPercent: 0, cpuMeasured: false, memoryMeasured: true, memoryBytes: 100, workingSets: [{ pid: 10, bytes: 100 }] });
  expect(load.sample('two')?.memoryBytes).toBe(200);
  sizes.set(10, 300);
  expect(load.sample('one')?.memoryBytes).toBe(300);
  load.remove('one', 10);
  expect(load.sample('one')).toBeNull();
  load.remove('one', 11);
  expect(load.sample('one')).toBeNull();
});

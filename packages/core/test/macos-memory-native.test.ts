import { expect, test } from 'bun:test';
import { dlopen, FFIType, ptr } from 'bun:ffi';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bus } from '../src/bus.ts';
import { Journal } from '../src/journal.ts';
import { MacMemory } from '../src/platform/macos-memory.ts';
import { createPosixPlatform } from '../src/platform/posix.ts';
import { ProcRegistry } from '../src/procs.ts';

const nativeTest = process.platform === 'darwin' ? test : test.skip;

nativeTest('native libproc samples descendants and stops only a controlled worker subtree', async () => {
  const libproc = dlopen('/usr/lib/libproc.dylib', {
    proc_pidinfo: { args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  });
  const directory = mkdtempSync(join(tmpdir(), 'boite-macos-native-'));
  const previous = process.env.BOITE_DATA_DIR;
  process.env.BOITE_DATA_DIR = directory;
  const journal = new Journal(join(directory, 'journal.db'));
  const bus = new Bus();
  // No injected readers or signallers: this exercises the shipping FFI and SIGKILL.
  const platform = createPosixPlatform('macos', new MacMemory());
  const registry = new ProcRegistry(journal, bus, platform);
  function bsdInfo(pid: number): Uint8Array | null {
    const buffer = new Uint8Array(136);
    const size = libproc.symbols.proc_pidinfo(pid, 3, 0, ptr(buffer), buffer.byteLength);
    if (size === 0) return null;
    expect(size).toBe(buffer.byteLength);
    return buffer;
  }
  try {
    const before = Date.now();
    const root = registry.spawn('native', process.execPath, [join(import.meta.dir, 'fixtures/macos-memory-tree.ts')], { cwd: directory });
    const reader = root.proc.stdout.getReader();
    try {
      let pending = '';
      const decoder = new TextDecoder();
      async function message(): Promise<Record<string, unknown>> {
        while (!pending.includes('\n')) {
          const chunk = await reader.read();
          if (chunk.done) throw new Error('native fixture exited before its next message');
          pending += decoder.decode(chunk.value, { stream: true });
        }
        const newline = pending.indexOf('\n');
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        return JSON.parse(line);
      }
      const pids = await message() as { root: number; worker: number; leaf: number };
      expect(pids.root).toBe(root.record.pid);
      expect(new Set(Object.values(pids)).size).toBe(3);
      const starts = new Map<number, number>();
      for (const [pid, parent] of [[pids.root, process.pid], [pids.worker, pids.root], [pids.leaf, pids.worker]] as const) {
        expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
        const bytes = bsdInfo(pid)!;
        expect(bytes).not.toBeNull();
        const info = new DataView(bytes.buffer);
        expect(info.getUint32(12, true)).toBe(pid);
        expect(info.getUint32(16, true)).toBe(parent);
        const birth = info.getBigUint64(120, true) * 1_000_000n + info.getBigUint64(128, true);
        starts.set(pid, Number(birth / 1000n));
        expect(Number(birth / 1000n)).toBeGreaterThanOrEqual(before - 1000);
        expect(Number(birth / 1000n)).toBeLessThanOrEqual(Date.now());
      }
      const sample = platform.sample('native');
      expect(sample).toMatchObject({ processes: 3, memoryMeasured: true, cpuMeasured: false });
      expect(sample!.workingSets!.map(member => member.pid).sort((a, b) => a - b))
        .toEqual(Object.values(pids).sort((a, b) => a - b));
      for (const member of sample!.workingSets!) expect(member.bytes).toBeGreaterThanOrEqual(8 * 1024 ** 2);
      expect(sample!.memoryBytes).toBe(sample!.workingSets!.reduce((sum, member) => sum + member.bytes, 0));

      expect(platform.terminateProcess('other', pids.worker)).toBe(false);
      expect(platform.terminateProcess('other', pids.root)).toBe(false);
      expect(platform.terminateProcess('native', pids.worker, null)).toBe(false);
      expect(platform.terminateProcess('native', pids.worker, 0)).toBe(false);
      expect(platform.terminateProcess('native', pids.worker, starts.get(pids.worker)!)).toBe(true);
      expect(await message()).toEqual({ exited: pids.worker, signal: 'SIGKILL' });
      // launchd may not have reaped the leaf yet; SZOMB (5) is already stopped.
      const deadline = Date.now() + 2000;
      let leaf = bsdInfo(pids.leaf);
      while (leaf !== null && new DataView(leaf.buffer).getUint32(4, true) !== 5 && Date.now() < deadline) {
        await Bun.sleep(10);
        leaf = bsdInfo(pids.leaf);
      }
      expect(leaf === null || new DataView(leaf.buffer).getUint32(4, true) === 5).toBe(true);
      expect(root.proc.exitCode).toBeNull();
      expect(platform.sample('native')).toMatchObject({ processes: 1, memoryBytes: expect.any(Number) });
    } finally { reader.releaseLock(); }
  } finally {
    await registry.killAll();
    await registry.close();
    bus.dispose();
    journal.close();
    libproc.close();
    if (previous === undefined) delete process.env.BOITE_DATA_DIR;
    else process.env.BOITE_DATA_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  }
}, 10_000);

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MemoryEvent } from '@boite/contracts';
import { Bus } from '../src/bus.ts';
import { Journal } from '../src/journal.ts';
import { ProcRegistry } from '../src/procs.ts';
import { processPlatform } from '../src/platform/index.ts';
import { DEFAULT_SETTINGS } from '../src/settings.ts';
import { waitFor } from './harness.ts';

const describeWindows = process.platform === 'win32' ? describe : describe.skip;

describeWindows('memory governor on Windows', () => {
  test('kills a real committed-memory descendant over quota and proves PagefileUsage at offset 56', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'boite-pressure-'));
    const previous = process.env.BOITE_DATA_DIR;
    process.env.BOITE_DATA_DIR = directory;
    const journal = new Journal(join(directory, 'journal.db'));
    const bus = new Bus();
    const events: MemoryEvent[] = [];
    bus.onAny((name, payload) => {
      if (name === 'resources.memory') events.push(payload as MemoryEvent);
    });
    const procs = new ProcRegistry(journal, bus, {
      ...processPlatform,
      machineMemory: () => ({ totalBytes: 32 * 1024 ** 3, availableBytes: 16000 * 1024 ** 2 }),
    });
    procs.applySettings({ ...DEFAULT_SETTINGS, threadMemoryCapMb: 1024, memoryReserveMb: 512, reapOrphans: false });
    // The root waits until it has joined the job before starting the allocator.
    const allocator = `
      const { dlopen, FFIType, ptr } = require('bun:ffi');
      const api = dlopen('kernel32.dll', {
        VirtualAlloc: { args: [FFIType.ptr, FFIType.u64, FFIType.u32, FFIType.u32], returns: FFIType.ptr },
        GetCurrentProcess: { args: [], returns: FFIType.ptr },
        K32GetProcessMemoryInfo: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
      }).symbols;
      function read() {
        const buffer = new Uint8Array(72);
        const view = new DataView(buffer.buffer);
        view.setUint32(0, 72, true);
        if (!api.K32GetProcessMemoryInfo(api.GetCurrentProcess(), ptr(buffer), 72)) throw new Error('memory read failed');
        return { commit: Number(view.getBigUint64(56, true)), rss: Number(view.getBigUint64(16, true)) };
      }
      const before = read();
      if (!api.VirtualAlloc(null, 256n * 1024n * 1024n, 0x3000, 4)) throw new Error('allocation failed');
      console.log(JSON.stringify({ pid: process.pid, before, after: read() }));
      setInterval(() => {}, 1000);
    `;
    const rootScript = `
      await Bun.stdin.stream().getReader().read();
      const child = Bun.spawn([process.execPath, '-e', ${JSON.stringify(allocator)}], { stdout: 'pipe', stderr: 'ignore', windowsHide: true });
      for await (const chunk of child.stdout) process.stdout.write(chunk);
      console.log('child exited ' + await child.exited);
      setInterval(() => {}, 1000);
    `;
    try {
      const root = procs.spawnPiped('pressure', process.execPath, ['-e', rootScript], { cwd: directory });
      await waitFor(() => processPlatform.sample('pressure')?.workingSets?.some(p => p.pid === root.record.pid) === true);
      root.proc.stdin.write('go\n');
      root.proc.stdin.flush();
      let output = '';
      const reading = (async () => { for await (const bytes of root.proc.stdout) output += new TextDecoder().decode(bytes); })();
      await waitFor(() => output.includes('}\n'));
      const probe = JSON.parse(output.trim().split('\n')[0]!);
      const childPid = probe.pid as number;
      expect(probe.after.commit - probe.before.commit).toBeGreaterThanOrEqual(256 * 1024 ** 2);
      expect(probe.after.rss - probe.before.rss).toBeLessThan(64 * 1024 ** 2);
      console.log(`PagefileUsage offset 56: commit +${probe.after.commit - probe.before.commit}, working set +${probe.after.rss - probe.before.rss} bytes`);
      await waitFor(() => procs.liveOf('pressure').some(p => p.pid === childPid));
      expect(childPid).not.toBe(root.record.pid);
      const measured = processPlatform.sample('pressure')!.workingSets!;
      expect(measured.find(process => process.pid === childPid)!.committedBytes).toBeGreaterThan(256 * 1024 ** 2);
      const quotaMb = Math.floor(measured.reduce((sum, process) => sum + process.committedBytes!, 0) / 1048576 / 1.05);
      procs.applySettings({ ...DEFAULT_SETTINGS, threadMemoryCapMb: quotaMb, memoryReserveMb: 512, reapOrphans: false });
      await waitFor(() => events.some(event => event.kind === 'killed'), 5000);
      await waitFor(() => output.includes('child exited'));
      const killed = events.filter(event => event.kind === 'killed');
      expect(killed).toHaveLength(1);
      expect(killed[0]).toMatchObject({ threadId: 'pressure', pid: childPid, state: 'critical', reason: 'thread-quota', limitBytes: quotaMb * 1048576 });
      expect(killed[0]!.bytes).toBeGreaterThan(200 * 1024 ** 2);
      expect(root.proc.exitCode).toBeNull();
      expect(procs.liveOf('pressure').some(p => p.pid === root.record.pid)).toBe(true);
      procs.killTree('pressure');
      await root.exited;
      await reading;
    } finally {
      await procs.killAll();
      await procs.close();
      bus.dispose();
      journal.close();
      if (previous === undefined) delete process.env.BOITE_DATA_DIR;
      else process.env.BOITE_DATA_DIR = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  }, 10000);
});

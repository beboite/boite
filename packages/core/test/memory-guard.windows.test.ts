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
  test('kills a real 256 MB descendant through its held handle and spares its root', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'boite-pressure-'));
    const previous = process.env.BOITE_DATA_DIR;
    process.env.BOITE_DATA_DIR = directory;
    const journal = new Journal(join(directory, 'journal.db'));
    const bus = new Bus();
    const events: MemoryEvent[] = [];
    let low = false;
    bus.onAny((name, payload) => {
      if (name === 'resources.memory') events.push(payload as MemoryEvent);
    });
    const procs = new ProcRegistry(journal, bus, {
      ...processPlatform,
      machineMemory: () => ({ totalBytes: 32 * 1024 ** 3, availableBytes: (low ? 256 : 16000) * 1024 ** 2 }),
    });
    procs.applySettings({ ...DEFAULT_SETTINGS, agentMemoryBudgetMb: 2048, threadMemoryCapMb: 1024, memoryReserveMb: 512, reapOrphans: false });
    // The root waits until it has joined the job before starting the allocator.
    const allocator = 'globalThis.memory = Buffer.alloc(256 * 1024 * 1024, 1); console.log(process.pid); setInterval(() => {}, 1000);';
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
      await waitFor(() => /^\d+/.test(output));
      const childPid = Number(output.trim().split(/\s/)[0]);
      await waitFor(() => procs.liveOf('pressure').some(p => p.pid === childPid));
      expect(childPid).not.toBe(root.record.pid);
      low = true;
      await waitFor(() => events.some(event => event.kind === 'killed'), 5000);
      low = false;
      await waitFor(() => output.includes('child exited'));
      const killed = events.filter(event => event.kind === 'killed');
      expect(killed).toHaveLength(1);
      expect(killed[0]).toMatchObject({ threadId: 'pressure', pid: childPid, state: 'critical' });
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

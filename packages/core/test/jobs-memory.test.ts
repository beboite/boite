import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bus } from '../src/bus.ts';
import { Journal } from '../src/journal.ts';
import { ProcRegistry } from '../src/procs.ts';
import { processPlatform } from '../src/platform/index.ts';
import type { ProcessEventSink } from '../src/platform/types.ts';
import { DEFAULT_SETTINGS } from '../src/settings.ts';
import { waitFor } from './harness.ts';

const describeWindows = process.platform === 'win32' ? describe : describe.skip;

// Commit at most 640 MB, only after the parent has seen the job's NEW_PROCESS.
const ALLOCATOR = `
  const { dlopen, FFIType } = require('bun:ffi');
  const { VirtualAlloc } = dlopen('kernel32.dll', {
    VirtualAlloc: { args: [FFIType.ptr, FFIType.u64, FFIType.u32, FFIType.u32], returns: FFIType.ptr },
  }).symbols;
  const { value } = await Bun.stdin.stream().getReader().read();
  const blocks = Math.min(40, Number(new TextDecoder().decode(value)));
  let allocated = 0;
  for (; allocated < blocks; allocated++) {
    if (!VirtualAlloc(null, 16n * 1024n * 1024n, 0x3000, 4)) break;
  }
  console.log(allocated === blocks ? 'allocation complete' : 'allocation refused');
  setTimeout(() => {}, 30000);
`;

describeWindows('job memory notifications', () => {
  let directory: string;
  let previousDataDir: string | undefined;
  let journal: Journal;
  let procs: ProcRegistry;
  let bus: Bus;
  let notices: Parameters<ProcessEventSink['memoryLimit']>[];
  let started: Set<number>;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'boite-memory-'));
    previousDataDir = process.env.BOITE_DATA_DIR;
    process.env.BOITE_DATA_DIR = directory;
    journal = new Journal(join(directory, 'journal.db'));
    bus = new Bus();
    notices = [];
    started = new Set();
    procs = new ProcRegistry(journal, bus, {
      ...processPlatform,
      retain(events, guards) {
        processPlatform.retain({
          ...events,
          started(threadId, pid, info) {
            started.add(pid);
            events.started(threadId, pid, info);
          },
          memoryLimit(threadId, kind) {
            notices.push([threadId, kind]);
            events.memoryLimit(threadId, kind);
          },
        }, guards);
      },
    });
    procs.applySettings({ ...DEFAULT_SETTINGS, agentMemoryBudgetMb: 768, threadMemoryCapMb: 256 });
  });

  afterEach(async () => {
    await procs.killAll();
    await procs.close();
    journal.close();
    if (previousDataDir === undefined) delete process.env.BOITE_DATA_DIR;
    else process.env.BOITE_DATA_DIR = previousDataDir;
    rmSync(directory, { recursive: true, force: true });
  });

  test('an allocation past the thread cap reaches the typed sink and keeps the warning', async () => {
    const logs: string[] = [];
    bus.onAny((name, event) => { if (name === 'core.log') logs.push((event as { message: string }).message); });
    const child = procs.spawnPiped('limited', process.execPath, ['-e', ALLOCATOR], { cwd: directory });
    const output = new Response(child.proc.stdout).text();
    await waitFor(() => started.has(child.record.pid), 5000);
    child.proc.stdin.write('40\n');
    child.proc.stdin.flush();
    await waitFor(() => notices.some(([id, kind]) => id === 'limited' && kind === 'thread-cap'), 5000);
    expect(logs).toContain('thread limited: the thread reached its memory cap');
    expect(notices.some(([, kind]) => kind === 'budget')).toBe(false);
    procs.killTree('limited');
    await child.exited;
    expect(await output).toContain('allocation refused');
  });

  test('two threads share the global budget and report its reserved completion key', async () => {
    procs.applySettings({ ...DEFAULT_SETTINGS, agentMemoryBudgetMb: 512, threadMemoryCapMb: 384 });
    for (const id of ['first', 'second']) {
      const child = procs.spawnPiped(id, process.execPath, ['-e', ALLOCATOR], { cwd: directory });
      await waitFor(() => started.has(child.record.pid), 5000);
      let output = '';
      const reader = child.proc.stdout.getReader();
      const read = reader.read().then(({ value }) => { output = new TextDecoder().decode(value); });
      child.proc.stdin.write('16\n');
      child.proc.stdin.flush();
      await waitFor(() => output.length > 0, 5000);
      await read;
      reader.releaseLock();
      expect(output).toContain(id === 'first' ? 'allocation complete' : 'allocation refused');
    }
    await waitFor(() => notices.some(([id, kind]) => id === null && kind === 'budget'), 5000);
    expect(notices.some(([, kind]) => kind === 'thread-cap')).toBe(false);
  });
});

import {expect, test} from 'bun:test';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import type {NativeProcessInfo, NativeProcessExit, ProcessEventSink} from '../src/platform/types.ts';
import type {ProcessReads} from '../src/platform/windows/process-reads.ts';

interface PacketFixture {
  configure(api: Partial<ProcessReads> & {close(handle: number): void; lastError(): number;
    openProcess(access: number, pid: number): number; terminateProcess(handle: number, code: number): boolean}, sink: ProcessEventSink): void;
  start(thread: string, pid: number, handle?: number): void;
  exit(thread: string, pid: number): void;
  terminateJobProcess(thread: string, pid: number): boolean;
  dispose(): void;
}

/** Load the actual registry with only its private native surface replaced.
 * Each copy has isolated state and imports the unchanged production readers.
 * No Windows DLL, process, job, or process handle is opened by this fixture. */
async function fixture(): Promise<{registry: PacketFixture; close(): void}> {
  const directory = mkdtempSync(join(tmpdir(), 'boite-jobs-pid-reuse-'));
  const original = resolve(import.meta.dir, '../src/platform/windows/jobs.ts');
  const source = readFileSync(original, 'utf8').replace(/from (['"])(\.[^'"\n]+)\1/g,
    (_, quote: string, name: string) => `from ${quote}${pathToFileURL(resolve(dirname(original), name)).href}${quote}`);
  const file = join(directory, 'jobs.ts');
  writeFileSync(file, source + `
export function configure(api: Native, events: ProcessEventSink) { native = api; sink = events; }
export const start = onProcessStarted, exit = reportExit;
export function dispose() {
  for (const waiting of awaitingCommandLine.values()) waiting.cancel();
  awaitingCommandLine.clear(); tracked.clear(); ignored.clear(); native = null; sink = null;
}
`);
  try {
    const registry = await import(pathToFileURL(file).href) as PacketFixture;
    return {registry, close() {registry.dispose(); rmSync(directory, {recursive: true, force: true});}};
  } catch (error) {rmSync(directory, {recursive: true, force: true}); throw error;}
}

for (const previous of ['console host without exit packet', 'process gone before its start could be read']) {
  test(`a captured process remains traceable and terminable after PID reuse by a ${previous}`, async () => {
    const {registry, close} = await fixture();
    const started: {pid: number; info: NativeProcessInfo}[] = [], exited: NativeProcessExit[] = [];
    const closed: number[] = [], terminated: number[] = [], opened: number[] = [];
    let live = true;
    const creation = 116444736000001111n;
    registry.configure({
      hasNt: false,
      lastError: () => 87,
      openProcess(_access, pid) {opened.push(pid); return 0;},
      close(handle) {closed.push(handle);},
      imageName(handle, buffer, size) {
        const image = handle === 101 ? String.raw`C:\Windows\System32\conhost.exe` : String.raw`C:\tools\debug-map.exe`;
        for (let i = 0; i < image.length; i++) buffer[i] = image.charCodeAt(i);
        size[0] = image.length; return true;
      },
      processTimes(_handle, buffer) {new DataView(buffer.buffer).setBigUint64(0, creation, true); return true;},
      exitCode(_handle, value) {value[0] = live ? 259 : 0; return true;},
      memoryInfo: () => false, ioCounters: () => false,
      terminateProcess(handle) {terminated.push(handle); return true;},
    }, {
      started(_thread, pid, info) {started.push({pid, info});},
      exited(_thread, _pid, info) {exited.push(info);},
      memoryLimit() {},
      note() {},
    });
    try {
      registry.start('earlier', 9052, previous.startsWith('console') ? 101 : 0);
      expect(started).toEqual([]);
      // The earlier process is gone, but its EXIT_PROCESS packet never came.
      registry.start('current', 9052, 202);
      expect(started).toEqual([{pid: 9052, info: expect.objectContaining({
        exe: String.raw`C:\tools\debug-map.exe`, incarnation: creation.toString(),
      })}]);
      registry.start('current', 9052, 203); // Duplicate start releases only the incoming handle.
      registry.exit('earlier', 9052); // A late PID-only exit cannot retire the replacement.
      registry.exit('current', 9052); // Its held handle still proves it is live.
      expect(exited).toEqual([]);
      expect(registry.terminateJobProcess('earlier', 9052)).toBe(false);
      expect(registry.terminateJobProcess('current', 9052)).toBe(true);
      expect(terminated).toEqual([202]);
      live = false; registry.exit('current', 9052);
      expect(exited).toEqual([expect.objectContaining({exitCode: 0, incarnation: creation.toString()})]);
      expect(started).toHaveLength(1);
      expect(closed).toEqual(previous.startsWith('console') ? [101, 203, 202] : [203, 202]);
      expect(opened).toEqual(previous.startsWith('console') ? [] : [9052]);
    } finally {close();}
  });
}

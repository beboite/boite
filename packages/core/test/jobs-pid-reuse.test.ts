import {createRequire} from 'node:module';
import {expect, spyOn, test} from 'bun:test';
import {mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import type {NativeProcessInfo, NativeProcessExit, ProcessEventSink, ProcessPlatform} from '../src/platform/types.ts';
import type {ProcessReads} from '../src/platform/windows/process-reads.ts';
import {Bus} from '../src/bus.ts';
import {ProcRegistry} from '../src/procs.ts';
import {createPosixPlatform} from '../src/platform/posix.ts';
import {startTestCore} from './harness.ts';

interface PacketFixture {
  configure(api: Partial<ProcessReads> & {close(handle: number): void; lastError(): number;
    openProcess(access: number, pid: number): number; terminateProcess(handle: number, code: number): boolean;
    queryJobInfo?(job: number, klass: number, buffer: Uint8Array): boolean}, sink: ProcessEventSink): void;
  start(thread: string, pid: number, handle?: number): void;
  exit(thread: string, pid: number): void;
  sample(thread: string, pid: number): void;
  hold(thread: string): void;
  threadJobHasProcesses?(thread: string): boolean;
  terminateJobProcess(thread: string, pid: number): boolean;
  dispose(): void;
}

/** Load the actual registry with only its private native surface replaced.
 * Each copy has isolated state and imports the unchanged production readers.
 * No Windows DLL, process, job, or process handle is opened by this fixture. */
async function fixture(): Promise<{registry: PacketFixture; close(): void}> {
  const directory = mkdtempSync(join(tmpdir(), 'boite-jobs-pid-reuse-'));
  const original = resolve(import.meta.dir, '../src/platform/windows/jobs.ts');
  const source = readFileSync(original, 'utf8').replace(/from (['"])(\.[^'"\n]+|@boite\/contracts)\1/g,
    (_, quote: string, name: string) => `from ${quote}${pathToFileURL(name.startsWith('.') ? resolve(dirname(original), name) : createRequire(original).resolve(name)).href}${quote}`);
  const file = join(directory, 'jobs.ts');
  writeFileSync(file, source + `
export function configure(api: Native, events: ProcessEventSink) { native = api; sink = events; }
export const start = onProcessStarted, exit = reportExit;
export function hold(thread: string) { threadJobs.set(thread, {handle: 1, pids: new Set()} as ThreadJob); }
export function sample(thread: string, pid: number) {
  threadJobs.set(thread, {handle: 1, pids: new Set([pid]), lastCpu100ns: 0n, lastSampleAt: 0} as ThreadJob);
  sampleThreadJob(thread);
}
export function dispose() {
  for (const waiting of awaitingCommandLine.values()) waiting.cancel();
  awaitingCommandLine.clear(); tracked.clear(); ignored.clear(); threadJobs.clear(); native = null; sink = null;
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

test('sampling reads the held status once for diagnostics and reconciles exits without packets', async () => {
  const {registry, close} = await fixture();
  const previous = process.env.BOITE_DIAGNOSE_JOB_EVENTS;
  const output = spyOn(console, 'error').mockImplementation(() => {});
  let readable = true, code = 259, reads = 0;
  const exited: NativeProcessExit[] = [];
  registry.configure({hasNt: false, lastError: () => 5, close() {}, imageName: () => false,
    openProcess: () => 0, terminateProcess: () => false,
    processTimes: () => false, memoryInfo: () => false, ioCounters: () => false, queryJobInfo: () => true,
    exitCode(_handle, value) {reads++; value[0] = code; return readable;},
  }, {started() {}, exited(_thread, _pid, info) {exited.push(info);}, memoryLimit() {}, note() {}});
  try {
    registry.start('current', 1234, 202);
    process.env.BOITE_DIAGNOSE_JOB_EVENTS = '1';
    registry.sample('current', 1234);
    expect(reads).toBe(1);
    readable = false;
    registry.sample('current', 1234);
    expect(reads).toBe(2);
    await Promise.resolve();
    expect(exited).toEqual([]);
    readable = true; code = 0;
    registry.sample('current', 1234);
    expect(reads).toBe(3);
    await Promise.resolve();
    expect(exited).toEqual([expect.objectContaining({exitCode: 0})]);
    const samples = output.mock.calls.filter(call => call[0] === 'WINDOWS_JOB_EVENT')
      .map(call => JSON.parse(String(call[1]))).filter(row => row.stage === 'jobs.sample-held');
    expect(samples).toEqual([
      expect.objectContaining({pid: 1234, read: true, code: 259, error: 0}),
      expect.objectContaining({pid: 1234, read: false, code: null, error: 5}),
      expect.objectContaining({pid: 1234, read: true, code: 0, error: 0}),
    ]);
  } finally {
    if (previous === undefined) delete process.env.BOITE_DIAGNOSE_JOB_EVENTS;
    else process.env.BOITE_DIAGNOSE_JOB_EVENTS = previous;
    output.mockRestore(); close();
  }
});

for (const state of ['exited', 'still-active', 'unseen-member', 'ignored-member', 'unreadable-job'] as const) {
  test(`publication reconciles captured exits before delayed job packets: ${state}`, async () => {
    const {registry, close} = await fixture(), harness = await startTestCore();
    const root = join(realpathSync(harness.dataDir), 'publication'); mkdirSync(root);
    const creation = 116444736000001111n, closed: number[] = [];
    let running = state === 'still-active', published = 0, queries = 0;
    const previous = process.env.BOITE_DIAGNOSE_JOB_EVENTS;
    const output = spyOn(console, 'error').mockImplementation(() => {});
    process.env.BOITE_DIAGNOSE_JOB_EVENTS = '1';
    const platform: ProcessPlatform = {...createPosixPlatform('linux', null),
      capability: () => ({os: 'windows', mode: 'events', note: 'held native job fixture'}),
      hasProcesses: id => registry.threadJobHasProcesses?.(id) ?? false,
      terminate: () => true,
      retain: events => registry.configure({hasNt: false, lastError: () => 5,
        openProcess: () => {throw new Error('must use the captured handle');},
        close: handle => {closed.push(handle);}, imageName(handle, out, size) {
          if (handle !== 303) return false;
          const image = String.raw`C:\Windows\System32\conhost.exe`;
          for (let i = 0; i < image.length; i++) out[i] = image.charCodeAt(i);
          size[0] = image.length; return true;
        },
        processTimes(_handle, out) {new DataView(out.buffer).setBigUint64(0, creation, true); return true;},
        exitCode(_handle, out) {out[0] = running ? 259 : 0; return true;},
        memoryInfo: () => false, ioCounters: () => false, terminateProcess: () => false,
        queryJobInfo(_job, klass, out) {
          queries++;
          expect(klass).toBe(3);
          if (state === 'unreadable-job') return false;
          if (state === 'unseen-member' || state === 'ignored-member') {
            const view = new DataView(out.buffer);
            view.setUint32(0, 1, true); view.setUint32(4, 1, true); view.setBigUint64(8, 5678n, true);
          }
          return true;
        },
      }, events),
      protectedExecution: {available: () => true, open: async () => ({
        launch: (command, args, cwd) => ({command, args, cwd, env: {...process.env}}),
        flush: () => {published++; return ['answer.js'];}, close() {},
      })},
    };
    const procs = new ProcRegistry(harness.core.journal, new Bus(), platform), id = 'publication';
    try {
      await procs.protection.install(id, {scope: {kind: 'job', id: 'job', associationId: 'association', grantRevision: 1},
        checkout: root, credentialPaths: [], executables: [process.execPath], expiresAt: Date.now() + 60000}, () => {});
      registry.hold(id);
      if (state === 'exited' || state === 'still-active') registry.start(id, 1234, 202);
      if (state === 'ignored-member') registry.start(id, 5678, 303);
      if (state === 'exited') {
        expect(procs.liveCount(id)).toBe(1);
        expect(procs.protection.flush(id)).toEqual(['answer.js']);
        expect(procs.liveCount(id)).toBe(0);
        expect(harness.core.journal.listProcesses(id, 10)).toEqual([expect.objectContaining({
          pid: 1234, exitCode: 0, exitedAt: expect.any(Number),
        })]);
        expect(closed).toEqual([202]);
      } else {
        expect(() => procs.protection.flush(id)).toThrow('tools must exit');
        expect(procs.liveCount(id)).toBe(state === 'still-active' ? 1 : 0);
        expect(closed).toEqual(state === 'ignored-member' ? [303] : []);
      }
      expect(published).toBe(state === 'exited' ? 1 : 0);
      expect(queries).toBe(1);
      const snapshots = output.mock.calls.filter(call => call[0] === 'WINDOWS_JOB_EVENT')
        .map(call => JSON.parse(String(call[1]))).filter(row => row.stage === 'jobs.publication-membership');
      expect(snapshots).toEqual([expect.objectContaining({
        members: state === 'unreadable-job' ? null : state.endsWith('member') ? 1 : 0,
        pids: state === 'unreadable-job' ? null : state.endsWith('member') ? '5678' : '',
        ignoredPids: state === 'unreadable-job' ? null : state === 'ignored-member' ? '5678' : '',
        capturedPids: state === 'exited' || state === 'still-active' ? '1234' : '',
      })]);
    } finally {
      running = false; registry.exit(id, 1234);
      await procs.close(); close(); await harness.stop();
      output.mockRestore();
      if (previous === undefined) delete process.env.BOITE_DIAGNOSE_JOB_EVENTS;
      else process.env.BOITE_DIAGNOSE_JOB_EVENTS = previous;
    }
  });
}

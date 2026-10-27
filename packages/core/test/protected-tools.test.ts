import {expect, test} from 'bun:test';
import {mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {Bus} from '../src/bus.ts';
import {ProcRegistry} from '../src/procs.ts';
import {protectedTools} from '../src/protected-tools.ts';
import {createPosixPlatform} from '../src/platform/posix.ts';
import type {ProcessEventSink, ProcessPlatform} from '../src/platform/types.ts';
import {startTestCore, waitFor} from './harness.ts';

for (const descendant of [false, true]) {
  test(`tool publication waits for delayed root telemetry${descendant ? ' and still rejects a live descendant' : ''}`, async () => {
    const harness = await startTestCore(), bus = new Bus();
    const root = join(harness.dataDir, 'project'); mkdirSync(root);
    let events!: ProcessEventSink, published = 0;
    const started = Promise.withResolvers<number>();
    bus.onAny((name, payload) => {
      if (name === 'process.started') started.resolve((payload as {pid: number}).pid);
    });
    // Real Bun child and real registry, with the Windows completion-port packet
    // deliberately held until after the ordinary process-exit callback.
    const platform: ProcessPlatform = {...createPosixPlatform('linux', null),
      capability: () => ({os: 'windows', mode: 'events', note: 'held native exit fixture'}),
      retain: sink => {events = sink;}, attach: () => true,
      protectedExecution: {available: () => true, open: async () => ({
        launch: (command, args, cwd) => ({command, args, cwd, env: {...process.env}}),
        flush: () => {published++; return ['answer.js'];}, close() {},
      })},
    };
    const procs = new ProcRegistry(harness.core.journal, bus, platform);
    const id = 'publication';
    try {
      await procs.protection.install(id, {scope: {kind: 'job', id: 'job', associationId: 'association', grantRevision: 1},
        checkout: root, credentialPaths: [], executables: [process.execPath], expiresAt: Date.now() + 60000}, () => {});
      const execution = protectedTools(procs, id, () => {}, () => {});
      const outcome = execution.execute(process.execPath, ['-e', "console.log('useful')"], root)
        .then(result => ({result, error: ''}), error => ({result: null, error: String(error)}));
      const pid = await started.promise;
      if (descendant) events.started(id, 900_001, {exe: 'captured-descendant', commandLine: null, parentPid: pid});
      const timers = procs as unknown as {exitTimers: Map<number, unknown>};
      await waitFor(() => timers.exitTimers.has(pid));
      expect(published).toBe(0);
      events.exited(id, pid, {exitCode: 0, cpuMs: 12, peakMemoryBytes: 34, ioBytes: 56});
      const result = await outcome;
      if (descendant) {
        expect(result.error).toContain('tools must exit');
        expect(published).toBe(0);
      } else {
        expect(result.error).toBe('');
        expect(result.result).toMatchObject({code: 0, stdout: 'useful\n'});
        expect(published).toBe(1);
      }
      const record = harness.core.journal.listProcesses(id, 10).find(record => record.pid === pid);
      expect(record).toMatchObject({exitCode: 0, cpuMs: 12, peakMemoryBytes: 34, ioBytes: 56});
    } finally {
      events.exited(id, 900_001, {exitCode: 0, cpuMs: null, peakMemoryBytes: null, ioBytes: null});
      await procs.close(); await harness.stop();
    }
  });
}

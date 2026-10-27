import {expect, spyOn, test} from 'bun:test';
import {mkdirSync, realpathSync} from 'node:fs';
import {join} from 'node:path';
import {Bus} from '../src/bus.ts';
import {ProcRegistry} from '../src/procs.ts';
import {protectedTools} from '../src/protected-tools.ts';
import {createPosixPlatform} from '../src/platform/posix.ts';
import type {ProcessEventSink, ProcessPlatform} from '../src/platform/types.ts';
import {startTestCore, waitFor} from './harness.ts';
import {thrown} from './settle.ts';

for (const mode of ['root', 'descendant', 'native', 'inherited-native', 'unreadable'] as const) {
  const descendant = mode === 'descendant';
  test(`tool publication drains delayed root telemetry: ${mode}`, async () => {
    const harness = await startTestCore(), bus = new Bus();
    const root = join(realpathSync(harness.dataDir), 'project'); mkdirSync(root);
    let events!: ProcessEventSink, published = 0;
    let nativePending = false;
    const membershipRead = Promise.withResolvers<void>();
    const started = Promise.withResolvers<number>();
    bus.onAny((name, payload) => {
      if (name === 'process.started') started.resolve((payload as {pid: number}).pid);
    });
    // Real Bun child and real registry, with the Windows completion-port packet
    // deliberately held until after the ordinary process-exit callback.
    const platform: ProcessPlatform = {...createPosixPlatform('linux', null),
      capability: () => ({os: 'windows', mode: 'events', note: 'held native exit fixture'}),
      retain: sink => {events = sink;}, attach: () => true,
      hasProcesses: id => {
        const pending = nativePending && id === (mode === 'inherited-native' ? 'inherited' : 'publication');
        if (pending) membershipRead.resolve();
        return pending;
      },
      protectedExecution: {available: () => true, open: async () => ({
        launch: (command, args, cwd) => ({command, args, cwd, env: {...process.env}}),
        flush: () => {published++; return ['answer.js'];}, close() {},
      })},
    };
    const procs = new ProcRegistry(harness.core.journal, bus, platform);
    const previousDiagnostic = process.env.BOITE_DIAGNOSE_JOB_EVENTS;
    const output = descendant ? spyOn(console, 'error').mockImplementation(() => {}) : null;
    if (descendant) process.env.BOITE_DIAGNOSE_JOB_EVENTS = '1';
    const id = 'publication';
    try {
      await procs.protection.install(id, {scope: {kind: 'job', id: 'job', associationId: 'association', grantRevision: 1},
        checkout: root, credentialPaths: [], executables: [process.execPath], expiresAt: Date.now() + 60000}, () => {});
      const execution = protectedTools(procs, id, () => {}, () => {});
      if (mode === 'inherited-native') procs.protection.inherit(id, 'inherited');
      nativePending = ['native', 'inherited-native', 'unreadable'].includes(mode);
      const outcome = execution.execute(process.execPath, ['-e', "console.log('useful')"], root)
        .then(result => ({result, error: ''}), error => ({result: null, error: String(error)}));
      const pid = await started.promise;
      if (descendant) events.started(id, 900_001, {exe: 'captured-descendant', commandLine: null, parentPid: pid});
      const timers = procs as unknown as {exitTimers: Map<number, unknown>};
      await waitFor(() => timers.exitTimers.has(pid));
      expect(published).toBe(0);
      events.exited(id, pid, {exitCode: 0, cpuMs: 12, peakMemoryBytes: 34, ioBytes: 56});
      if (nativePending) {
        await membershipRead.promise;
        expect(published).toBe(0);
        if (mode !== 'unreadable') {
          // An EXIT notification is insufficient while the native job still
          // contains its console.
          await Bun.sleep(50);
          expect(published).toBe(0);
          nativePending = false;
        }
      }
      const result = await outcome;
      if (descendant || mode === 'unreadable') {
        expect(result.error).toContain('tools must exit');
        expect(published).toBe(0);
        const events = output?.mock.calls.filter(call => call[0] === 'WINDOWS_JOB_EVENT')
          .map(call => JSON.parse(String(call[1])));
        if (events) {
          const refused = events.findIndex(event => event.stage === 'protection.flush-refused');
          expect(events[refused]).toMatchObject({phase: 'processes', field: 'execution.processes'});
          expect(events.findIndex(event => event.stage === 'protection.revoke')).toBeGreaterThan(refused);
        }
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
      output?.mockRestore();
      if (previousDiagnostic === undefined) delete process.env.BOITE_DIAGNOSE_JOB_EVENTS;
      else process.env.BOITE_DIAGNOSE_JOB_EVENTS = previousDiagnostic;
    }
  }, 15000);
}

test('direct publication still refuses native members without waiting', async () => {
  const harness = await startTestCore(), root = join(realpathSync(harness.dataDir), 'project'); mkdirSync(root);
  let pending = false, published = 0;
  const procs = new ProcRegistry(harness.core.journal, new Bus(), {...createPosixPlatform('linux', null),
    hasProcesses: () => pending,
    protectedExecution: {open: async () => ({launch: (command, args, cwd) => ({command, args, cwd, env: {...process.env}}),
      flush() {published++; return [];}, close() {}})},
  });
  try {
    await procs.protection.install('direct', {scope: {kind: 'job', id: 'job', associationId: 'association', grantRevision: 1},
      checkout: root, credentialPaths: [], executables: [process.execPath], expiresAt: Date.now() + 60000}, () => {});
    pending = true;
    expect(() => procs.protection.flush('direct')).toThrow('tools must exit');
    expect(published).toBe(0);
  } finally {await procs.close(); await harness.stop();}
});

for (const phase of ['root-exit', 'native-drain', 'revoked-drain'] as const) {
  test(`an old tool cannot publish or revoke a replacement during ${phase}`, async () => {
    const harness = await startTestCore(), root = join(realpathSync(harness.dataDir), 'project'); mkdirSync(root);
    const paused = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>(), opening = Promise.withResolvers<void>();
    let opens = 0, published = 0, pending = false, newClosed = false;
    const platform: ProcessPlatform = {...createPosixPlatform('linux', null),
      hasProcesses: () => {if (pending) paused.resolve(); return pending;},
      protectedExecution: {open: async () => {
        const replacement = ++opens > 1;
        if (replacement) await opening.promise;
        return {launch: (command, args, cwd) => ({command, args, cwd, env: {...process.env}}),
          flush: () => {published++; return [];}, close: () => {if (replacement) newClosed = true;}};
      }},
    };
    const procs = new ProcRegistry(harness.core.journal, new Bus(), platform), id = 'replace';
    const wait = procs.waitForExit.bind(procs);
    const hold = spyOn(procs, 'waitForExit').mockImplementation(async (id, pids) => {
      await wait(id, pids);
      if (pids && phase === 'root-exit') {paused.resolve(); await resume.promise;}
    });
    const input = {scope: {kind: 'job' as const, id: 'job', associationId: 'association', grantRevision: 1}, checkout: root,
      credentialPaths: [], executables: [process.execPath], expiresAt: Date.now() + 60000};
    try {
      await procs.protection.install(id, input, () => {});
      const execution = protectedTools(procs, id, () => {}, () => {});
      pending = phase !== 'root-exit';
      const result = thrown(execution.execute(process.execPath, ['-e', 'console.log("old")']));
      await paused.promise;
      if (phase === 'revoked-drain') {
        await procs.protection.revoke(id);
        expect(await result).toThrow('revoked');
        expect(published).toBe(0);
        return;
      }
      pending = false;
      await procs.protection.release(id);
      const replacement = procs.protection.install(id, input, () => {}).then(policy => ({policy, error: null}), error => ({policy: null, error}));
      resume.resolve();
      expect(await result).toThrow('captured capability was replaced');
      expect(() => procs.protection.assert(id)).not.toThrow();
      expect(published).toBe(0);
      opening.resolve();
      expect((await replacement).error).toBeNull();
      expect(newClosed).toBe(false);
      expect(() => execution.check()).toThrow('captured capability was replaced');
    } finally {
      pending = false; resume.resolve(); opening.resolve(); hold.mockRestore();
      await procs.close(); await harness.stop();
    }
  }, 15000);
}

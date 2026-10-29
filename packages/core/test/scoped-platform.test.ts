import {expect, test} from 'bun:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Bus} from '../src/bus.ts';
import {Journal} from '../src/journal.ts';
import {ProcRegistry} from '../src/procs.ts';
import {createPosixPlatform} from '../src/platform/posix.ts';
import {scopedPlatforms} from '../src/platform/scoped.ts';
import type {GuardEventSink, ProcessEventSink, ProcessPlatform} from '../src/platform/types.ts';

test('equal public thread IDs keep their native trace, descendants and termination through another registry restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'boite-native-scopes-'));
  const journals: Journal[] = [], registries: ProcRegistry[] = [], attached: string[] = [], killed: number[] = [];
  const processes = new Map<string, Set<number>>(), guarded = new Map<number, string>();
  const identities = new Map<string, Map<number, string>>();
  let events!: ProcessEventSink, guards!: GuardEventSink, releases = 0;
  const backend: ProcessPlatform = {
    ...createPosixPlatform('linux', null),
    retain(next, nextGuards) {events = next; guards = nextGuards;},
    async release() {releases++;},
    attach(scope, pid) {attached.push(scope); const pids = processes.get(scope) ?? new Set<number>(); pids.add(pid); processes.set(scope, pids); return true;},
    terminate(scope) {
      for (const pid of processes.get(scope) ?? []) {killed.push(pid); events.exited(scope, pid, {exitCode: 1, cpuMs: 0, peakMemoryBytes: 0, ioBytes: 0, startedAt: 1000, incarnation: identities.get(scope)?.get(pid)});}
      processes.delete(scope); return true;
    },
    terminateUnassigned() {throw new Error('A scoped native member must never use a PID fallback');},
    pidAdded(scope, pid) {guarded.set(pid, scope);},
    pidRemoved(_scope, pid) {guarded.delete(pid);},
    guardStatus: () => ({running: true, hook: '1', failure: null, audio: 'on', mutedPids: [...guarded.keys()]}),
    forget(scope) {if (!processes.get(scope)?.size) processes.delete(scope);},
  };
  const platform = scopedPlatforms(backend);
  const registry = () => {
    const journal = new Journal(join(directory, `${journals.length}.db`)); journals.push(journal);
    const bus = new Bus(), procs = new ProcRegistry(journal, bus, platform()); registries.push(procs);
    return {procs, bus};
  };
  const started = (scope: string, pid: number, incarnation: string) => {
    const births = identities.get(scope) ?? new Map(); births.set(pid, incarnation); identities.set(scope, births);
    events.started(scope, pid, {exe: 'git.exe', commandLine: 'git worktree add', parentPid: 1, startedAt: 1000, incarnation});
  };
  try {
    const a = registry(), b = registry();
    a.procs.platform.attach('same', 501); b.procs.platform.attach('same', 502);
    const [aScope, bScope] = attached;
    started(aScope!, 501, 'a-root'); started(bScope!, 502, 'b-root');
    processes.get(aScope!)!.add(503); started(aScope!, 503, 'a-descendant');
    expect(a.procs.liveOf('same').map(p => p.pid)).toEqual([501, 503]);
    expect(b.procs.liveOf('same').map(p => p.pid)).toEqual([502]);
    expect(a.procs.platform.guardStatus().mutedPids).toEqual([501, 503]);
    expect(b.procs.platform.guardStatus().mutedPids).toEqual([502]);
    const focus: string[] = [];
    a.bus.onAny(name => {if (name === 'process.focusPushed') focus.push('a');});
    b.bus.onAny(name => {if (name === 'process.focusPushed') focus.push('b');});
    guards.pushed(aScope!, 503, 'fixture', true); expect(focus).toEqual(['a']);
    await b.procs.killAll(); await b.procs.close();
    expect(killed).toEqual([502]); expect(releases).toBe(0);
    expect(a.procs.liveOf('same').map(p => p.pid)).toEqual([501, 503]);
    const c = registry(); c.procs.platform.attach('same', 502);
    const cScope = attached[2]!; started(cScope, 502, 'c-reused-pid');
    started(bScope!, 502, 'b-late-start');
    events.exited(bScope!, 502, {exitCode: 1, cpuMs: 0, peakMemoryBytes: 0, ioBytes: 0, startedAt: 1000, incarnation: 'b-root'});
    b.procs.platform.pidRemoved('same', 502, true);
    await b.procs.killAll();
    expect(c.procs.platform.guardStatus().mutedPids).toEqual([502]);
    expect(c.procs.liveOf('same').map(p => p.pid)).toEqual([502]);
    expect(a.procs.liveOf('same').map(p => p.pid)).toEqual([501, 503]);
    processes.get(aScope!)!.delete(501);
    events.exited(aScope!, 501, {exitCode: 0, cpuMs: 1, peakMemoryBytes: 1, ioBytes: 1, startedAt: 1000, incarnation: 'a-root'});
    expect(a.procs.liveOf('same').map(p => p.pid)).toEqual([503]);
    processes.get(aScope!)!.add(504); started(aScope!, 504, 'a-later-descendant');
    expect(a.procs.liveOf('same').map(p => p.pid)).toEqual([503, 504]);
    await c.procs.killAll(); await c.procs.close();
    await a.procs.killAll(); await a.procs.close();
    expect(killed).toEqual([502, 502, 503, 504]); expect(releases).toBe(1);
  } finally {
    for (const procs of registries) {await procs.killAll(); await procs.close();}
    for (const journal of journals) journal.close();
    rmSync(directory, {recursive: true, force: true});
  }
});

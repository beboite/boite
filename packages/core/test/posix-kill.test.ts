import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bus } from '../src/bus.ts';
import { Journal } from '../src/journal.ts';
import { GROUP_POLL_MS, KILL_GRACE_MS, stopGroup } from '../src/platform/posix-kill.ts';
import type { Signaller } from '../src/platform/posix-kill.ts';
import { ProcRegistry } from '../src/procs.ts';

/**
 * A process table with groups: `kill` throws ESRCH the way the kernel does when
 * nothing answers to the pid or group, signal 0 only probes, and a signal stops
 * whoever does not ignore it.
 */
class FakeSystem implements Signaller {
  readonly sent: string[] = [];
  readonly alive = new Map<number, { group: number; ignoresTerm: boolean }>();
  private readonly timers: { run: () => void; ms: number }[] = [];

  kill(pid: number, signal: NodeJS.Signals | 0): void {
    const targets = pid < 0
      ? [...this.alive.entries()].filter(([, process]) => process.group === -pid).map(([member]) => member)
      : this.alive.has(pid) ? [pid] : [];
    if (targets.length === 0) throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
    if (signal === 0) return;
    this.sent.push(`${signal} ${pid}`);
    for (const target of targets) {
      if (signal === 'SIGTERM' && this.alive.get(target)?.ignoresTerm === true) continue;
      this.alive.delete(target);
    }
  }

  later(run: () => void, ms: number): void {
    this.timers.push({ run, ms });
  }

  /** Runs the timers pending now, the way one step of time passing would. Returns the ms that took. */
  step(): number {
    const due = this.timers.splice(0);
    for (const timer of due) timer.run();
    return due.reduce((most, timer) => Math.max(most, timer.ms), 0);
  }

  /** Lets time pass until nothing is pending. Returns the total ms. */
  settle(): number {
    let total = 0;
    while (this.timers.length > 0) total += this.step();
    return total;
  }
}

describe('stopping a child off Windows', () => {
  test('SIGTERM reaches the child and what it started through the group', async () => {
    const system = new FakeSystem();
    system.alive.set(400, { group: 400, ignoresTerm: false });
    system.alive.set(401, { group: 400, ignoresTerm: false }); // a `sleep` the agent's shell started
    system.alive.set(900, { group: 1, ignoresTerm: false }); // someone else's process

    const stopped = stopGroup(400, () => system.alive.has(400), system);

    expect(system.sent).toEqual(['SIGTERM -400']);
    expect([...system.alive.keys()]).toEqual([900]);
    // The group is empty at once: no SIGKILL is left pending.
    expect(system.settle()).toBe(0);
    await stopped;
    expect(system.sent).toEqual(['SIGTERM -400']);
    expect([...system.alive.keys()]).toEqual([900]);
  });

  test('a member that ignores SIGTERM is killed two seconds later, even after its leader exited', async () => {
    const system = new FakeSystem();
    system.alive.set(500, { group: 500, ignoresTerm: false });
    system.alive.set(501, { group: 500, ignoresTerm: true });

    const stopped = stopGroup(500, () => system.alive.has(500), system);
    expect([...system.alive.keys()]).toEqual([501]);

    expect(system.settle()).toBe(KILL_GRACE_MS);
    await stopped;
    expect(system.sent).toEqual(['SIGTERM -500', 'SIGKILL -500']);
    expect(system.alive.size).toBe(0);
  });

  test('a group that empties during the grace gets no SIGKILL, even when its id leads a new group by then', async () => {
    const system = new FakeSystem();
    system.alive.set(800, { group: 800, ignoresTerm: false });
    system.alive.set(801, { group: 800, ignoresTerm: true });
    let settled = false;
    const stopped = stopGroup(800, () => system.alive.has(800), system).then(() => {
      settled = true;
    });

    // The member finishes its cleanup and exits on its own after a few polls.
    expect(system.step()).toBe(GROUP_POLL_MS);
    expect(system.step()).toBe(GROUP_POLL_MS);
    system.alive.delete(801);
    expect(system.step()).toBe(GROUP_POLL_MS);
    await stopped;
    expect(settled).toBe(true);

    // The id is free again and the next setsid gets it: an unrelated group.
    system.alive.set(800, { group: 800, ignoresTerm: false });
    expect(system.settle()).toBe(0);
    expect(system.sent).toEqual(['SIGTERM -800']);
    expect(system.alive.has(800)).toBe(true);
  });

  test('a child that leads no group is signalled alone, and only while it was not reaped', async () => {
    const system = new FakeSystem();
    system.alive.set(600, { group: 1, ignoresTerm: true });
    let reaped = false;

    const first = stopGroup(600, () => !reaped, system);
    expect(system.sent).toEqual(['SIGTERM 600']);
    system.settle();
    await first;
    expect(system.sent).toEqual(['SIGTERM 600', 'SIGKILL 600']);

    // Reaped, then the pid went to an unrelated process: it is never signalled.
    reaped = true;
    system.alive.set(600, { group: 1, ignoresTerm: false });
    await stopGroup(600, () => !reaped, system);
    system.settle();
    expect(system.sent).toEqual(['SIGTERM 600', 'SIGKILL 600']);
    expect(system.alive.has(600)).toBe(true);
  });

  test('a lone child reaped during the grace gets no SIGKILL', async () => {
    const system = new FakeSystem();
    system.alive.set(650, { group: 1, ignoresTerm: true });
    let reaped = false;
    const stopped = stopGroup(650, () => !reaped, system);
    system.step();
    reaped = true;
    system.alive.set(650, { group: 1, ignoresTerm: false }); // the pid went to someone else
    system.settle();
    await stopped;
    expect(system.sent).toEqual(['SIGTERM 650']);
    expect(system.alive.has(650)).toBe(true);
  });

  test('a pid that never existed schedules nothing', async () => {
    const system = new FakeSystem();
    await stopGroup(-1, () => true, system);
    await stopGroup(0, () => true, system);
    await stopGroup(700, () => true, system);
    expect(system.sent).toEqual([]);
    expect(system.settle()).toBe(0);
  });
});

// -- the registry's shutdown, on a real process group -----------------------

const describePosix = process.platform === 'win32' ? describe.skip : describe;

describePosix('the registry shutdown off Windows', () => {
  test('killAll resolves only after a child that ignores SIGTERM was SIGKILLed', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'boite-posix-kill-'));
    const previousDataDir = process.env.BOITE_DATA_DIR;
    process.env.BOITE_DATA_DIR = directory;
    const journal = new Journal(join(directory, 'journal.db'));
    const procs = new ProcRegistry(journal, new Bus());
    try {
      const child = procs.spawn('stubborn', process.execPath, [
        '-e',
        "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000);",
      ], { cwd: directory });
      // The handler is in once the child printed: a SIGTERM before it would just end it.
      const reader = child.proc.stdout.getReader();
      await reader.read();
      reader.releaseLock();

      const started = Date.now();
      await procs.killAll();
      expect(Date.now() - started).toBeGreaterThanOrEqual(KILL_GRACE_MS - GROUP_POLL_MS);
      const code = await Promise.race([child.exited, Bun.sleep(500).then(() => 'still running' as const)]);
      expect(code).not.toBe('still running');
      expect(child.proc.signalCode).toBe('SIGKILL');
    } finally {
      await procs.killAll();
      await procs.close();
      journal.close();
      if (previousDataDir === undefined) delete process.env.BOITE_DATA_DIR;
      else process.env.BOITE_DATA_DIR = previousDataDir;
      rmSync(directory, { recursive: true, force: true });
    }
  }, 10_000);
});

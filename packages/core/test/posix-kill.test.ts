import { describe, expect, test } from 'bun:test';
import { KILL_GRACE_MS, stopGroup } from '../src/platform/posix-kill.ts';
import type { Signaller } from '../src/platform/posix-kill.ts';

/**
 * A process table with groups: `kill` throws ESRCH the way the kernel does when
 * nothing answers to the pid or group, and a signal stops whoever does not
 * ignore it.
 */
class FakeSystem implements Signaller {
  readonly sent: string[] = [];
  readonly alive = new Map<number, { group: number; ignoresTerm: boolean }>();
  private readonly timers: { run: () => void; ms: number }[] = [];

  kill(pid: number, signal: NodeJS.Signals): void {
    const targets = pid < 0
      ? [...this.alive.entries()].filter(([, process]) => process.group === -pid).map(([member]) => member)
      : this.alive.has(pid) ? [pid] : [];
    if (targets.length === 0) throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
    this.sent.push(`${signal} ${pid}`);
    for (const target of targets) {
      if (signal === 'SIGTERM' && this.alive.get(target)?.ignoresTerm === true) continue;
      this.alive.delete(target);
    }
  }

  later(run: () => void, ms: number): void {
    this.timers.push({ run, ms });
  }

  /** Runs every pending timer, the way time passing would. */
  elapse(): number[] {
    const due = this.timers.splice(0);
    for (const timer of due) timer.run();
    return due.map((timer) => timer.ms);
  }
}

describe('stopping a child off Windows', () => {
  test('SIGTERM reaches the child and what it started through the group', () => {
    const system = new FakeSystem();
    system.alive.set(400, { group: 400, ignoresTerm: false });
    system.alive.set(401, { group: 400, ignoresTerm: false }); // a `sleep` the agent's shell started
    system.alive.set(900, { group: 1, ignoresTerm: false }); // someone else's process

    stopGroup(400, () => system.alive.has(400), system);

    expect(system.sent).toEqual(['SIGTERM -400']);
    expect([...system.alive.keys()]).toEqual([900]);
    // The late SIGKILL finds an empty group and touches nothing else.
    expect(system.elapse()).toEqual([KILL_GRACE_MS]);
    expect(system.sent).toEqual(['SIGTERM -400']);
    expect([...system.alive.keys()]).toEqual([900]);
  });

  test('a member that ignores SIGTERM is killed two seconds later, even after its leader exited', () => {
    const system = new FakeSystem();
    system.alive.set(500, { group: 500, ignoresTerm: false });
    system.alive.set(501, { group: 500, ignoresTerm: true });

    stopGroup(500, () => system.alive.has(500), system);
    expect([...system.alive.keys()]).toEqual([501]);

    system.elapse();
    expect(system.sent).toEqual(['SIGTERM -500', 'SIGKILL -500']);
    expect(system.alive.size).toBe(0);
  });

  test('a child that leads no group is signalled alone, and only while it was not reaped', () => {
    const system = new FakeSystem();
    system.alive.set(600, { group: 1, ignoresTerm: true });
    let reaped = false;

    stopGroup(600, () => !reaped, system);
    expect(system.sent).toEqual(['SIGTERM 600']);
    system.elapse();
    expect(system.sent).toEqual(['SIGTERM 600', 'SIGKILL 600']);

    // Reaped, then the pid went to an unrelated process: it is never signalled.
    reaped = true;
    system.alive.set(600, { group: 1, ignoresTerm: false });
    stopGroup(600, () => !reaped, system);
    system.elapse();
    expect(system.sent).toEqual(['SIGTERM 600', 'SIGKILL 600']);
    expect(system.alive.has(600)).toBe(true);
  });

  test('a pid that never existed schedules nothing', () => {
    const system = new FakeSystem();
    stopGroup(-1, () => true, system);
    stopGroup(0, () => true, system);
    stopGroup(700, () => true, system);
    expect(system.sent).toEqual([]);
    expect(system.elapse()).toEqual([]);
  });
});

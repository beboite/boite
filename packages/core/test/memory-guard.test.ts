import { describe, expect, test } from 'bun:test';
import { decideMemory, initialMemoryPolicy, type MemorySample } from '../src/memory-guard-logic.ts';
import { MemoryGuard, memoryNotice } from '../src/memory-guard.ts';
import { Bus } from '../src/bus.ts';
import { createPosixPlatform } from '../src/platform/posix.ts';
import { DEFAULT_SETTINGS } from '../src/settings.ts';

const sample = (patch: Partial<MemorySample> = {}): MemorySample => ({
  availableBytes: 1000, reserveBytes: 100, budgetBytes: 5000, quotaBytes: 2000,
  agentBytes: 0, processes: [], at: 0, ...patch,
});
const child = (pid: number, bytes: number, root = false, threadId = 'thread') => ({ threadId, pid, exe: 'child', bytes, root });

describe('memory policy', () => {
  test('kills the largest non-root of each thread over quota', () => {
    const processes = [child(1, 2500, true), child(2, 400), child(3, 300), child(4, 900, false, 'other')];
    const result = decideMemory(initialMemoryPolicy(), sample({ processes }));
    expect(result.kills).toEqual([{ process: processes[1]!, reason: 'thread-quota', limitBytes: 2000 }]);
    expect(result.policy.state).toBe('critical');
  });
  test.each(['budget', 'machine'] as const)('%s chooses the heaviest thread, not the largest process elsewhere', reason => {
    const processes = [child(1, 900, true), child(2, 400), child(3, 800, false, 'other')];
    const result = decideMemory(initialMemoryPolicy(), sample({ processes,
      ...(reason === 'budget' ? { agentBytes: 2100, budgetBytes: 2000 } : { availableBytes: 99 }),
    }));
    expect(result.kills).toEqual([{ process: processes[1]!, reason, limitBytes: reason === 'budget' ? 2000 : 100 }]);
  });
  test('one kill per thread and independent three-second cooldowns across recovery', () => {
    const processes = [child(1, 2100), child(2, 2200, false, 'other')];
    const low = sample({ processes, agentBytes: 4300, budgetBytes: 4000, availableBytes: 50, at: 100 });
    const first = decideMemory(initialMemoryPolicy(), low);
    expect(first.kills.map(kill => kill.process.pid)).toEqual([1, 2]);
    expect(decideMemory(first.policy, { ...low, at: 3099 }).kills).toEqual([]);
    const third = decideMemory(first.policy, { ...low, processes: [...processes, child(3, 2300, false, 'third')], at: 200 });
    expect(third.kills.map(kill => kill.process.pid)).toEqual([3]);
    let policy = decideMemory(first.policy, sample({ at: 1000 })).policy;
    policy = decideMemory(policy, sample({ at: 2000 })).policy;
    expect(decideMemory(policy, { ...low, at: 3100 }).kills).toHaveLength(2);
    expect(first.policy.nextKillAt.get('third')).toBeUndefined();
  });
  test('spares roots without punishing a lighter thread and reports nothing killable once', () => {
    const low = sample({ availableBytes: 50, processes: [child(1, 1900, true), child(2, 100, false, 'other')] });
    const first = decideMemory(initialMemoryPolicy(), low);
    expect(first.kills).toEqual([]);
    expect(first.nothingKillable).toEqual(['thread']);
    expect(decideMemory(first.policy, low).nothingKillable).toEqual([]);
    let policy = decideMemory(first.policy, sample()).policy;
    policy = decideMemory(policy, sample()).policy;
    expect(decideMemory(policy, low).nothingKillable).toEqual(['thread']);
  });
  test('recovery takes two good readings, missing readings reset it and recovery never kills', () => {
    let policy = decideMemory(initialMemoryPolicy(), sample({ availableBytes: 50 })).policy;
    policy = decideMemory(policy, sample()).policy;
    policy = decideMemory(policy, sample({ availableBytes: null })).policy;
    const recovering = decideMemory(policy, sample({ processes: [child(1, 200)] }));
    expect(recovering.policy.state).toBe('critical');
    expect(recovering.kills).toEqual([]);
    expect(decideMemory(recovering.policy, sample()).policy.state).toBe('ok');
  });
  test('budget remains enforced with a missing machine reading', () => {
    expect(decideMemory(initialMemoryPolicy(), sample({ availableBytes: null, agentBytes: 5001 })).policy.state).toBe('critical');
    expect(decideMemory(initialMemoryPolicy(), sample({ availableBytes: 100, agentBytes: 5000 })).policy.state).toBe('ok');
  });

  test('state changes emit once, an unsuccessful kill emits no kill event', () => {
    const bus = new Bus();
    const events: string[] = [];
    let availableBytes = 0;
    const guard = new MemoryGuard(bus, {
      ...createPosixPlatform('linux'),
      machineMemory: () => ({ totalBytes: 32 * 1024 ** 3, availableBytes }),
    });
    bus.onAny((name, payload) => {
      if (name === 'resources.memory') events.push((payload as { kind: string }).kind);
    });
    guard.applySettings(DEFAULT_SETTINGS);
    guard.sample(0, [child(1, 200)], () => false);
    guard.sample(0, [], () => false);
    expect(events).toEqual(['pressure']);
    availableBytes = 16 * 1024 ** 3;
    guard.sample(0, [], () => false);
    expect(guard.state).toBe('critical');
    guard.sample(0, [], () => false);
    expect(guard.state).toBe('ok');
    expect(events).toEqual(['pressure', 'pressure']);
    bus.dispose();
  });
});


test.each([
  ['thread-quota', 'this conversation exceeded its memory quota'],
  ['budget', 'the agents exceeded their shared memory budget'],
  ['machine', 'available machine memory fell below the reserve'],
] as const)('the %s notice gives the process, size, reason, limit and advice', (reason, cause) => {
  const notice = memoryNotice({ threadId: 't', kind: 'killed', pid: 42, exe: 'C:\\bin\\cargo.exe', bytes: 2048 * 1048576, reason, limitBytes: 9728 * 1048576, state: 'critical', at: 0 });
  expect(notice).toStartWith('[Boite memory guard] Stopped cargo.exe (pid 42, 2048 MB) because ' + cause + ' (9728 MB).');
  expect(notice).toContain('Do not rerun it unchanged; lower parallelism');
  expect(notice).toContain('cargo build -j 2');
});

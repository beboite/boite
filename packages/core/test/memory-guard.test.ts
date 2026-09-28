import { describe, expect, test } from 'bun:test';
import { decideMemory, initialMemoryPolicy, type MemorySample } from '../src/memory-guard-logic.ts';
import { MemoryGuard } from '../src/memory-guard.ts';
import { Bus } from '../src/bus.ts';
import { createPosixPlatform } from '../src/platform/posix.ts';
import { DEFAULT_SETTINGS } from '../src/settings.ts';

const sample = (patch: Partial<MemorySample> = {}): MemorySample => ({
  availableBytes: 1000, reserveBytes: 100, budgetBytes: 500,
  agentBytes: 0, kernelBudget: true, processes: [], at: 0, ...patch,
});
const child = (pid: number, bytes: number, root = false) => ({ threadId: 'thread', pid, exe: 'child', bytes, root });

describe('memory policy', () => {
  test('enters tight and critical immediately at the reserve thresholds', () => {
    expect(decideMemory(initialMemoryPolicy(), sample({ availableBytes: 200 })).policy.state).toBe('tight');
    expect(decideMemory(initialMemoryPolicy(), sample({ availableBytes: 100 })).policy.state).toBe('critical');
    expect(decideMemory(initialMemoryPolicy(), sample({ availableBytes: 201 })).policy.state).toBe('ok');
  });
  test('recovery requires two consecutive samples above the current threshold', () => {
    let policy = decideMemory(initialMemoryPolicy(), sample({ availableBytes: 50 })).policy;
    policy = decideMemory(policy, sample({ availableBytes: 150 })).policy;
    expect(policy.state).toBe('critical');
    policy = decideMemory(policy, sample({ availableBytes: 90 })).policy;
    policy = decideMemory(policy, sample({ availableBytes: 150 })).policy;
    expect(policy.state).toBe('critical');
    policy = decideMemory(policy, sample({ availableBytes: 150 })).policy;
    expect(policy.state).toBe('tight');
    policy = decideMemory(policy, sample()).policy;
    expect(policy.state).toBe('tight');
    expect(decideMemory(policy, sample()).policy.state).toBe('ok');
  });
  test('enforces the sampled budget only without a kernel budget', () => {
    expect(decideMemory(initialMemoryPolicy(), sample({ agentBytes: 501 })).policy.state).toBe('ok');
    expect(decideMemory(initialMemoryPolicy(), sample({ agentBytes: 501, kernelBudget: false })).policy.state).toBe('critical');
    expect(decideMemory(initialMemoryPolicy(), sample({ agentBytes: 500, kernelBudget: false })).policy.state).toBe('ok');
  });
  test('chooses one largest working set across threads, excluding roots', () => {
    const processes = [child(1, 900, true), child(2, 200), { ...child(3, 400), threadId: 'other' }];
    const result = decideMemory(initialMemoryPolicy(), sample({ availableBytes: 50, processes }));
    expect(result.victim?.pid).toBe(3);
    expect(result.policy).not.toBe(initialMemoryPolicy());
  });
  test('waits three seconds between victims, even across a recovery', () => {
    const low = sample({ availableBytes: 50, processes: [child(2, 200)], at: 100 });
    let policy = decideMemory(initialMemoryPolicy(), low).policy;
    expect(decideMemory(policy, { ...low, at: 3099 }).victim).toBeNull();
    policy = decideMemory(policy, sample({ at: 1000 })).policy;
    policy = decideMemory(policy, sample({ at: 2000 })).policy;
    expect(decideMemory(policy, { ...low, at: 3100 }).victim?.pid).toBe(2);
  });
  test('reports no killable process once per critical episode', () => {
    const low = sample({ availableBytes: 50, processes: [child(1, 900, true)] });
    const first = decideMemory(initialMemoryPolicy(), low);
    expect(first.victim).toBeNull();
    expect(first.nothingKillable).toBe(true);
    expect(decideMemory(first.policy, low).nothingKillable).toBe(false);
  });
  test('never kills on a recovery sample while hysteresis still holds critical', () => {
    const policy = decideMemory(initialMemoryPolicy(), sample({ availableBytes: 50 })).policy;
    expect(decideMemory(policy, sample({ processes: [child(1, 200)], at: 5000 })).victim).toBeNull();
  });
  test('a missing machine reading still enforces a fallback budget', () => {
    expect(decideMemory(initialMemoryPolicy(), sample({ availableBytes: null, agentBytes: 501, kernelBudget: false })).policy.state).toBe('critical');
  });

  test('a missing reading resets recovery and never releases a pressure hold', () => {
    let policy = decideMemory(initialMemoryPolicy(), sample({ availableBytes: 150 })).policy;
    policy = decideMemory(policy, sample()).policy;
    policy = decideMemory(policy, sample({ availableBytes: null })).policy;
    expect(decideMemory(policy, sample()).policy.state).toBe('tight');
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

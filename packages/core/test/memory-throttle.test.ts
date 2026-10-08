import { describe, expect, test } from 'bun:test';
import type { MemoryEvent } from '@boite/contracts';
import { Bus } from '../src/bus.ts';
import { MemoryGuard, memoryNotice } from '../src/memory-guard.ts';
import { decideThrottle, THROTTLE_QUIET_MS, THROTTLE_REPEAT_MS, THROTTLE_STREAK, type ThrottlePolicy } from '../src/memory-throttle-logic.ts';
import { createPosixPlatform } from '../src/platform/posix.ts';
import { DEFAULT_SETTINGS } from '../src/settings.ts';

const GB = 1024 ** 3;

/** One sample: the `high` count, the stall total in ms, and optionally when it was taken. */
type Sample = [high: number, stallMs: number, at?: number];

/** Feeds the samples, one per second unless a time is given, and returns when a notice was due. */
function run(samples: Sample[], start = 0, policy?: ThrottlePolicy): { notices: number[]; policy: ThrottlePolicy } {
  const notices: number[] = [];
  for (const [index, [highEvents, stallMs, time]] of samples.entries()) {
    const at = time ?? start + index * 1000;
    const result = decideThrottle(policy, { highEvents, stallMicros: stallMs * 1000 }, at);
    policy = result.policy;
    if (result.notify) notices.push(at);
  }
  return { notices, policy: policy! };
}

/** `count` samples from `from`: the count rises by one and the group waits `stallMs` more each second. */
const stalled = (count: number, from = 0, stallMs = 500): Sample[] => Array.from({ length: count }, (_, index) => [from + index, (from + index) * stallMs]);
/** `count` samples where nothing moves after `sample`. */
const still = (count: number, sample: Sample): Sample[] => Array<Sample>(count).fill([sample[0], sample[1]]);

describe('throttle policy', () => {
  test('a count that rises on every sample with a flat stall time never notifies', () => {
    // Page cache reaching the limit: 5271 events measured for 0.36 s of stall in total.
    const cache: Sample[] = Array.from({ length: 900 }, (_, index) => [index * 6, 356]);
    expect(run(cache).notices).toEqual([]);
    expect(run(cache).policy.streak).toBe(0);
    // A little waiting under the threshold is still not a stall: 199 ms per second.
    expect(run(stalled(900, 0, 199)).notices).toEqual([]);
    // Waiting without the limit being reached is somebody else's pressure.
    expect(run(Array.from({ length: 900 }, (_, index): Sample => [7, index * 900])).notices).toEqual([]);
  });

  test('fires once the group stalled in five samples, not on the baseline or earlier', () => {
    // The first reading is the baseline: old totals say nothing about now.
    expect(run(stalled(5, 900)).notices).toEqual([]);
    expect(run(stalled(6, 900)).notices).toEqual([THROTTLE_STREAK * 1000]);
    expect(run(stalled(6, 0, 200)).notices).toEqual([THROTTLE_STREAK * 1000]);
  });

  test('the threshold scales with the time between two samples', () => {
    // Four seconds apart: 800 ms of waiting is the bar, 799 is under it.
    const spaced = (stallMs: number): Sample[] => Array.from({ length: 6 }, (_, index) => [index, index * stallMs, index * 4000]);
    expect(run(spaced(799)).notices).toEqual([]);
    expect(run(spaced(800)).notices).toEqual([20_000]);
    // One late sample: 599 ms would pass over one second and does not over three.
    const late = run([[0, 0, 0], [1, 500, 1000], [2, 1099, 4000]]);
    expect(late.policy.streak).toBe(1);
    // Two readings at the same instant measure nothing and keep the older one.
    const twice = decideThrottle(late.policy, { highEvents: 3, stallMicros: 9_000_000 }, 4000);
    expect(twice).toEqual({ policy: late.policy, notify: false });
  });

  test('repeats after five minutes while the stall continues, never sooner', () => {
    const seconds = THROTTLE_REPEAT_MS / 1000 + THROTTLE_STREAK + 3;
    expect(run(stalled(seconds)).notices).toEqual([THROTTLE_STREAK * 1000, THROTTLE_STREAK * 1000 + THROTTLE_REPEAT_MS]);
  });

  test('thirty calm seconds reset the streak, a shorter pause does not', () => {
    const last: Sample = [3, 1500];
    const short = run([...stalled(4), ...still(THROTTLE_QUIET_MS / 1000 - 1, last), [4, 2000], [5, 2500]]);
    expect(short.notices).toHaveLength(1);
    const calm = run([...stalled(4), ...still(THROTTLE_QUIET_MS / 1000, last)]);
    expect(calm.policy.streak).toBe(0);
    // A count that keeps rising without stall time is calm too.
    const cache = run([...stalled(4), ...Array.from({ length: THROTTLE_QUIET_MS / 1000 }, (_, index): Sample => [4 + index, 1500])]);
    expect(cache.policy.streak).toBe(0);
    const after = run([[3, 1500], [4, 2000], [5, 2500], [6, 3000], [7, 3500]], 59_000, calm.policy);
    expect(after.notices).toEqual([]);
    expect(run([[8, 4000]], 64_000, after.policy).notices).toEqual([64_000]);
  });

  test('a new episode inside the five minutes stays silent, and a lower counter is a new baseline', () => {
    const first = run([...stalled(6), ...still(THROTTLE_QUIET_MS / 1000, [5, 2500])]);
    expect(first.notices).toEqual([5000]);
    expect(run([[5, 2500], ...stalled(6, 6)], 59_000, first.policy).notices).toEqual([]);
    const known: ThrottlePolicy = { highEvents: 50, stallMicros: 9_000_000, at: 0, streak: 4, stalledAt: 0, noticedAt: null };
    const baseline = { highEvents: 2, stallMicros: 9_500_000, at: 1000, streak: 0, stalledAt: 1000, noticedAt: null };
    expect(decideThrottle(known, { highEvents: 2, stallMicros: 9_500_000 }, 1000)).toEqual({ policy: baseline, notify: false });
    expect(decideThrottle(known, { highEvents: 51, stallMicros: 100 }, 1000).policy).toMatchObject({ streak: 0, stallMicros: 100 });
  });
});

describe('throttle notice', () => {
  const reading = (highEvents: number) => ({ path: '/a.scope', highEvents, stallMicros: highEvents * 500_000, highBytes: 5 * GB, maxBytes: 6 * GB, currentBytes: 5 * GB + 1048576 });

  test('the guard emits one thread event with the limit and the charge, and follows memoryProtection', () => {
    const bus = new Bus();
    const events: MemoryEvent[] = [];
    bus.onAny((name, payload) => { if (name === 'resources.memory') events.push(payload as MemoryEvent); });
    const asked: number[] = [];
    let high = 0;
    const guard = new MemoryGuard(bus, { ...createPosixPlatform('linux', null), cgroupMemory: (pid) => { asked.push(pid); return reading(high); } });
    guard.applySettings(DEFAULT_SETTINGS);
    for (let second = 0; second <= 8; second++) guard.throttle('thread', reading(second), second * 1000);
    guard.throttle('thread', null, 9000);
    // The registry's sample reads the root agent's group, never a tool's.
    const live = [{ root: false, record: { pid: 70 } }, { root: true, record: { pid: 71 } }, { root: true, record: { pid: 72 } }];
    for (high = 0; high <= 4; high++) guard.sampleThrottle('sampled', live);
    guard.sampleThrottle('tools-only', [live[0]!]);
    expect(asked).toEqual([71, 71, 71, 71, 71]);
    // The count alone, with nobody waiting, is no notice however long it rises.
    for (let second = 0; second <= 60; second++) guard.throttle('cache', { ...reading(second), stallMicros: 356_906 }, second * 1000);
    expect(events).toEqual([{ threadId: 'thread', kind: 'throttled', limitBytes: 5 * GB, bytes: 5 * GB + 1048576, state: 'ok', at: 5000 }]);

    guard.applySettings({ ...DEFAULT_SETTINGS, memoryProtection: false });
    guard.sampleThrottle('other', live);
    expect(asked).toHaveLength(5);
    for (let second = 0; second <= 8; second++) guard.throttle('other', reading(second), second * 1000);
    expect(events).toHaveLength(1);

    // A forgotten thread starts from a baseline again.
    guard.applySettings(DEFAULT_SETTINGS);
    for (let second = 0; second <= 4; second++) guard.throttle('again', reading(second), second * 1000);
    guard.forgetThrottle('again');
    for (let second = 5; second <= 9; second++) guard.throttle('again', reading(second), second * 1000);
    expect(events).toHaveLength(1);
    guard.throttle('again', reading(10), 10_000);
    expect(events).toHaveLength(2);
    bus.dispose();
  });

  test('the notice names the limit and keeps the advice', () => {
    const notice = memoryNotice({ threadId: 't', kind: 'throttled', limitBytes: 5 * GB, bytes: 5 * GB, state: 'ok', at: 0 });
    expect(notice).toStartWith("[Boite memory guard] This conversation's processes are being slowed by their memory limit (5120 MB): they stall instead of failing. Do not rerun it unchanged; lower parallelism");
    expect(notice).toContain('cargo build -j 2');
  });
});

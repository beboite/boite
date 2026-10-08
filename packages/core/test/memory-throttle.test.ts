import { describe, expect, test } from 'bun:test';
import type { MemoryEvent } from '@boite/contracts';
import { Bus } from '../src/bus.ts';
import { MemoryGuard, memoryNotice } from '../src/memory-guard.ts';
import { calmThrottle, decideThrottle, THROTTLE_GAP_MS, THROTTLE_QUIET_MS, THROTTLE_REPEAT_MS, THROTTLE_STREAK, type ThrottlePolicy } from '../src/memory-throttle-logic.ts';
import { createPosixPlatform } from '../src/platform/posix.ts';
import { DEFAULT_SETTINGS } from '../src/settings.ts';

const GB = 1024 ** 3;
const PATH = '/agents.slice/a.scope';

/** One sample: the `high` count, the stall total in ms, and optionally when it was taken. */
type Sample = [high: number, stallMs: number, at?: number];

/** Feeds the samples, one per second unless a time is given, and returns when a notice was due. */
function run(samples: Sample[], start = 0, policy?: ThrottlePolicy, path = PATH): { notices: number[]; policy: ThrottlePolicy } {
  const notices: number[] = [];
  for (const [index, [highEvents, stallMs, time]] of samples.entries()) {
    const at = time ?? start + index * 1000;
    const result = decideThrottle(policy, { path, highEvents, stallMicros: stallMs * 1000 }, at);
    policy = result.policy;
    if (result.notify) notices.push(at);
  }
  return { notices, policy: policy! };
}

/** `count` samples from `from`: the count rises by one and the group waits `stallMs` more each second. */
const stalled = (count: number, from = 0, stallMs = 500): Sample[] => Array.from({ length: count }, (_, index) => [from + index, (from + index) * stallMs]);
/** `count` samples where nothing moves after `sample`. */
const still = (count: number, sample: Sample): Sample[] => Array.from({ length: count }, (): Sample => [sample[0], sample[1]]);
/** A policy that noticed at 5 s and is still stalled at 9 s. */
const noticed = () => run(stalled(10)).policy;

describe('throttle policy', () => {
  test('a count that rises on every sample with a flat stall time never notifies', () => {
    // Page cache reaching the limit: 5271 events measured for 0.36 s of stall in total.
    const cache = run(Array.from({ length: 900 }, (_, index): Sample => [index * 6, 356]));
    expect(cache.notices).toEqual([]);
    expect(cache.policy.streak).toBe(0);
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
    const twice = decideThrottle(late.policy, { path: PATH, highEvents: 3, stallMicros: 9_000_000 }, 4000);
    expect(twice).toEqual({ policy: late.policy, notify: false });
  });

  test('a gap of more than five seconds restarts the measure without counting or losing the streak', () => {
    const before = run(stalled(5)).policy;
    expect(before).toMatchObject({ streak: 4, at: 4000, noticedAt: null });
    // One millisecond past the gap, with a share over the bar: still no stalled sample.
    const gap = decideThrottle(before, { path: PATH, highEvents: 9, stallMicros: 7_000_000 }, before.at + THROTTLE_GAP_MS + 1);
    expect(gap).toEqual({ policy: { ...before, highEvents: 9, stallMicros: 7_000_000, at: before.at + THROTTLE_GAP_MS + 1 }, notify: false });
    // The next ordinary sample is measured from the gap's counters, and completes the streak.
    expect(decideThrottle(gap.policy, { path: PATH, highEvents: 10, stallMicros: 7_500_000 }, gap.policy.at + 1000)).toMatchObject({ notify: true, policy: { streak: 5, noticedAt: gap.policy.at + 1000 } });
    // Exactly five seconds is still a sample.
    expect(decideThrottle(before, { path: PATH, highEvents: 9, stallMicros: 7_000_000 }, before.at + THROTTLE_GAP_MS)).toMatchObject({ notify: true });
    // A gap as long as the quiet period ends the streak like any calm stretch, and keeps what was noticed.
    const long = decideThrottle(noticed(), { path: PATH, highEvents: 90, stallMicros: 90_000_000 }, 9000 + THROTTLE_QUIET_MS);
    expect(long.policy).toMatchObject({ streak: 0, noticedAt: 5000, highEvents: 90 });
  });

  test('a clock that steps back starts over at the new time and keeps the repeat floor', () => {
    const known = noticed();
    const back = decideThrottle(known, { path: PATH, highEvents: 12, stallMicros: 8_000_000 }, 7000);
    expect(back).toEqual({ policy: { path: PATH, highEvents: 12, stallMicros: 8_000_000, at: 7000, streak: 0, stalledAt: 7000, noticedAt: 5000 }, notify: false });
    // Five stalled samples from there: no second notice inside the five minutes.
    expect(run(stalled(6, 13, 1000).map(([high, stall], index): Sample => [high, stall, 8000 + index * 1000]), 0, back.policy).notices).toEqual([]);
    // Stepping back before the notice itself must not silence the thread for longer than the floor.
    expect(decideThrottle(known, { path: PATH, highEvents: 12, stallMicros: 8_000_000 }, 2000).policy.noticedAt).toBe(2000);
    expect(decideThrottle(run(stalled(3)).policy, { path: PATH, highEvents: 12, stallMicros: 8_000_000 }, 500).policy.noticedAt).toBeNull();
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
    const after = run([[3, 1500], [4, 2000], [5, 2500], [6, 3000], [7, 3500]], 34_000, calm.policy);
    expect(after.notices).toEqual([]);
    expect(run([[8, 4000]], 39_000, after.policy).notices).toEqual([39_000]);
  });

  test('a new episode of the same group inside the five minutes stays silent', () => {
    const first = run([...stalled(6), ...still(THROTTLE_QUIET_MS / 1000, [5, 2500])]);
    expect(first.notices).toEqual([5000]);
    expect(first.policy).toMatchObject({ streak: 0, noticedAt: 5000 });
    expect(run([[5, 2500], ...stalled(6, 6)], 36_000, first.policy).notices).toEqual([]);
  });

  test('another cgroup path or lower counters are a new group that can notify at once', () => {
    const known = noticed();
    const fresh = { streak: 0, noticedAt: null };
    // The same counters under another scope: nothing carries over, the repeat floor included.
    const moved = decideThrottle(known, { path: '/agents.slice/b.scope', highEvents: 9, stallMicros: 4_500_000 }, 10_000);
    expect(moved).toEqual({ policy: { path: '/agents.slice/b.scope', highEvents: 9, stallMicros: 4_500_000, at: 10_000, stalledAt: 10_000, ...fresh }, notify: false });
    expect(run(stalled(5, 10), 11_000, moved.policy, '/agents.slice/b.scope').notices).toEqual([15_000]);
    // A lower count, or a lower stall total, on the same path is a recreated group.
    for (const reading of [{ highEvents: 2, stallMicros: 9_500_000 }, { highEvents: 51, stallMicros: 100 }]) {
      const lower = decideThrottle(known, { path: PATH, ...reading }, 10_000);
      expect(lower).toEqual({ policy: { path: PATH, ...reading, at: 10_000, stalledAt: 10_000, ...fresh }, notify: false });
    }
    const recreated = decideThrottle(known, { path: PATH, highEvents: 0, stallMicros: 0 }, 10_000).policy;
    expect(run(stalled(5, 1), 11_000, recreated).notices).toEqual([15_000]);
  });

  test('a streak ends by age alone, for a sample that brought no reading', () => {
    const known = run(stalled(5)).policy;
    expect(calmThrottle(known, 4000 + THROTTLE_QUIET_MS - 1)).toBe(known);
    expect(calmThrottle(known, 4000 + THROTTLE_QUIET_MS)).toEqual({ ...known, streak: 0 });
  });
});

describe('throttle notice', () => {
  const reading = (highEvents: number, path = PATH) => ({ path, highEvents, stallMicros: highEvents * 500_000, highBytes: 5 * GB, maxBytes: 6 * GB, currentBytes: 5 * GB + 1048576 });
  const listen = () => {
    const bus = new Bus();
    const events: MemoryEvent[] = [];
    bus.onAny((name, payload) => { if (name === 'resources.memory') events.push(payload as MemoryEvent); });
    return { bus, events };
  };

  test('the guard emits one thread event with the limit and the charge, and follows memoryProtection', () => {
    const { bus, events } = listen();
    const guard = new MemoryGuard(bus, createPosixPlatform('linux', null));
    guard.applySettings(DEFAULT_SETTINGS);
    for (let second = 0; second <= 8; second++) guard.throttle('thread', reading(second), second * 1000);
    // The count alone, with nobody waiting, is no notice however long it rises.
    for (let second = 0; second <= 60; second++) guard.throttle('cache', { ...reading(second), stallMicros: 356_906 }, second * 1000);
    expect(events).toEqual([{ threadId: 'thread', kind: 'throttled', limitBytes: 5 * GB, bytes: 5 * GB + 1048576, state: 'ok', at: 5000 }]);

    guard.applySettings({ ...DEFAULT_SETTINGS, memoryProtection: false });
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

  test('a group unread for thirty seconds needs five new stalled samples, a shorter blank does not', () => {
    const { bus, events } = listen();
    const guard = new MemoryGuard(bus, createPosixPlatform('linux', null));
    guard.applySettings(DEFAULT_SETTINGS);
    // Four stalled samples, then the group cannot be read for 29 s: the fifth still completes the streak.
    for (let second = 0; second <= 4; second++) guard.throttle('young', reading(second), second * 1000);
    guard.throttle('young', null, 4000 + THROTTLE_QUIET_MS - 1000);
    guard.throttle('young', reading(5), 4000 + THROTTLE_QUIET_MS - 500);
    guard.throttle('young', reading(6), 4000 + THROTTLE_QUIET_MS);
    expect(events.map(event => event.threadId)).toEqual(['young']);
    // The same with 30 s unread: the streak is over and five new samples are needed.
    for (let second = 0; second <= 4; second++) guard.throttle('old', reading(second), second * 1000);
    guard.throttle('old', null, 4000 + THROTTLE_QUIET_MS);
    // The first reading back comes after an idle gap and only restarts the measure.
    for (let step = 0; step < 5; step++) guard.throttle('old', reading(5 + step), 34_500 + step * 1000);
    expect(events).toHaveLength(1);
    guard.throttle('old', reading(10), 39_500);
    expect(events.map(event => event.threadId)).toEqual(['young', 'old']);
    // A thread never read has nothing to end.
    guard.throttle('unknown', null, 0);
    bus.dispose();
  });

  test('the sample tries each root agent in turn, never a tool or a pid that is none', () => {
    const { bus, events } = listen();
    const asked: number[] = [];
    let count = 0;
    let readable = new Set([71, 72]);
    const guard = new MemoryGuard(bus, { ...createPosixPlatform('linux', null), cgroupMemory: (pid) => { asked.push(pid); return readable.has(pid) ? reading(count, `/agents.slice/${pid}.scope`) : null; } });
    guard.applySettings(DEFAULT_SETTINGS);
    const live = [{ root: false, record: { pid: 70 } }, { root: true, record: { pid: 0 } }, { root: true, record: { pid: -1 } }, { root: true, record: { pid: 71.5 } }, { root: true, record: { pid: Number.NaN } }, { root: true, record: { pid: 71 } }, { root: true, record: { pid: 72 } }];
    for (let sample = 0; sample < 3; sample++) { count = sample; guard.sampleThrottle('sampled', live); }
    expect(asked).toEqual([71, 71, 71]);
    // The first root lost its group: the second is read in the same sample.
    readable = new Set([72]);
    asked.length = 0;
    guard.sampleThrottle('sampled', live);
    expect(asked).toEqual([71, 72]);
    // No root with a reading asks every root and notifies nothing.
    readable = new Set();
    asked.length = 0;
    guard.sampleThrottle('sampled', live);
    guard.sampleThrottle('tools-only', [live[0]!]);
    expect(asked).toEqual([71, 72]);
    guard.applySettings({ ...DEFAULT_SETTINGS, memoryProtection: false });
    guard.sampleThrottle('sampled', live);
    expect(asked).toHaveLength(2);
    expect(events).toEqual([]);
    bus.dispose();
  });

  test('the notice names the limit and says nothing was stopped', () => {
    const notice = memoryNotice({ threadId: 't', kind: 'throttled', limitBytes: 5 * GB, bytes: 6 * GB, state: 'ok', at: 0 });
    expect(notice).toBe("[Boite memory guard] This conversation's processes are being slowed by their memory limit (5120 MB): they stall instead of failing. Nothing was stopped. Start no other heavy job beside it, and lower parallelism for the next one, for example `cargo build -j 2`.");
    expect(notice).not.toContain('Do not rerun');
    // The other kinds keep the advice written for a stopped or refused process.
    expect(memoryNotice({ threadId: 't', kind: 'thread-cap', state: 'ok', at: 0 })).toEndWith('Do not rerun it unchanged; lower parallelism, for example `cargo build -j 2`; close editors or servers you started; run one heavy job at a time.');
  });
});

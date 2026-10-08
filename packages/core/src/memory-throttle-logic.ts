/**
 * When a thread whose cgroup is stalled at `memory.high` is worth a notice.
 * Pure: the registry feeds it one reading of the group per load sample.
 *
 * The `high` count rising is not enough. A group whose charge is mostly clean
 * page cache reaches the limit on every sample of a large build: the kernel
 * drops cache, the count climbs and no process waits. So a sample counts only
 * when the group's stall time rose with it.
 */

/** Stalled samples needed before the first notice. */
export const THROTTLE_STREAK = 5;
/** The least time between two notices of one thread. */
export const THROTTLE_REPEAT_MS = 5 * 60_000;
/** This long without a stalled sample ends the streak. */
export const THROTTLE_QUIET_MS = 30_000;
/** A longer wait between two samples is an idle gap: no share of it is measured. */
export const THROTTLE_GAP_MS = 5000;
/**
 * One part in this many of the time since the last sample must be stall time: 200 ms
 * per second. Whole numbers, so an exact fifth is not lost to rounding.
 */
export const THROTTLE_STALL_ONE_IN = 5;

export interface ThrottleReading {
  /** The group the counters belong to. Another path is another limit. */
  path: string;
  /** The `high` count of `memory.events`. */
  highEvents: number;
  /** The `some` total of `memory.pressure`, in microseconds. */
  stallMicros: number;
}

export interface ThrottlePolicy extends ThrottleReading {
  /** When that reading was taken. */
  at: number;
  /** Stalled samples since the last quiet period. */
  streak: number;
  stalledAt: number;
  noticedAt: number | null;
}

/** A streak whose last stalled sample is 30 s old is over, whether or not a reading came. */
export function calmThrottle(policy: ThrottlePolicy, at: number): ThrottlePolicy {
  return policy.streak > 0 && at - policy.stalledAt >= THROTTLE_QUIET_MS ? { ...policy, streak: 0 } : policy;
}

export function decideThrottle(policy: ThrottlePolicy | undefined, reading: ThrottleReading, at: number): { policy: ThrottlePolicy; notify: boolean } {
  const { path, highEvents, stallMicros } = reading;
  const counters = { path, highEvents, stallMicros, at };
  // The first reading is only a baseline. Another path or a lower counter is a
  // new group with its own limit, so what was said about the old one is dropped.
  if (policy === undefined || path !== policy.path || highEvents < policy.highEvents || stallMicros < policy.stallMicros) {
    return { policy: { ...counters, streak: 0, stalledAt: at, noticedAt: null }, notify: false };
  }
  const elapsedMs = at - policy.at;
  // No time passed, so no share of it can be measured: keep the older reading.
  if (elapsedMs === 0) return { policy, notify: false };
  // The clock stepped back: start over from here, without a second notice for the same episode.
  if (elapsedMs < 0) {
    return { policy: { ...counters, streak: 0, stalledAt: at, noticedAt: policy.noticedAt === null ? null : Math.min(policy.noticedAt, at) }, notify: false };
  }
  // After an idle gap the counters only restart the measure; a stall spread over it proves nothing.
  const stalled = elapsedMs <= THROTTLE_GAP_MS && highEvents > policy.highEvents
    && (stallMicros - policy.stallMicros) * THROTTLE_STALL_ONE_IN >= elapsedMs * 1000;
  if (!stalled) return { policy: calmThrottle({ ...policy, ...counters }, at), notify: false };
  const streak = policy.streak + 1;
  const notify = streak >= THROTTLE_STREAK && (policy.noticedAt === null || at - policy.noticedAt >= THROTTLE_REPEAT_MS);
  return { policy: { ...counters, streak, stalledAt: at, noticedAt: notify ? at : policy.noticedAt }, notify };
}

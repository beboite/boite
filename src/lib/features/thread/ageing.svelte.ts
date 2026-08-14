import { app } from "$lib/app/store.svelte";
import { settings } from "$lib/features/settings/store.svelte";
import { threadActivitySince } from "./activity.svelte";
import { dueForAutoSettle, nextWake } from "$lib/domain/thread-ageing";
import type { Thread } from "$lib/types";

/**
 * The clock behind snooze and auto-settle, and the reason there is barely one.
 *
 * A snoozed thread is not scheduled, it carries the instant it comes back, so
 * nothing has to have been running while the app was closed. All this needs is
 * to redraw when that instant arrives: one timer, armed for the soonest wake
 * and for nothing else, and no timer at all while nothing is snoozed. That is
 * what `rules/performance.md` asks of anything that repeats.
 *
 * Auto-settle rides the same wake rather than owning a tick. It is measured in
 * days, so a pass on load, a pass whenever a snooze ends, and a pass an hour
 * after any of them is far finer than the thing it is deciding.
 */

const HOURLY = 3_600_000;

let timer: ReturnType<typeof setTimeout> | null = null;
// Whether the clock is running, so a rearm asked for after teardown does not
// leave a timer behind that nothing holds the handle to any more.
let running = false;

/**
 * The instant every filed-away list ages against, and why it is state.
 *
 * `Date.now()` read inside a `$derived` is not a dependency of it: the number
 * changes on its own, nothing writes anything Svelte is watching, and the
 * derived keeps the answer it computed the first time. So the sidebar's filter
 * used to hold a snoozed thread out of the list until an unrelated mutation
 * happened to rebuild it: the wake fired and redrew nothing.
 *
 * Written by the sweep and nowhere else, because the sweep is armed for exactly
 * the instants at which the answer can have changed.
 */
let tick = $state(Date.now());

/** The instant to age against, for anything that has to redraw when one ends. */
export function ageingNow(): number {
  return tick;
}

/**
 * When a thread was last doing something, for a clock that has to answer for
 * threads this session never watched.
 *
 * The in-memory registry only knows what happened since the app opened, and a
 * row restored on boot is exactly the row auto-settle is about. `createdAt` is
 * the honest floor: a thread nothing has touched since it was made has been
 * quiet since it was made.
 */
function activityOf(thread: Thread): number {
  return threadActivitySince(thread.id) ?? thread.createdAt;
}

function sweep() {
  const now = Date.now();
  tick = now;
  const due = dueForAutoSettle(app.threads, {
    now,
    days: settings.state.autoSettleDays,
    statusOf: (thread) => thread.status,
    activityOf,
  });
  for (const thread of due) void app.fileThread(thread.id, { settled: true });
  arm(now);
}

/**
 * Arms the one timer, for the soonest of the next wake and the hourly pass.
 *
 * Rearmed rather than left running: a wake that has been superseded by a nearer
 * one, or by a thread that came back on its own, would otherwise fire against a
 * list that has already moved.
 */
function arm(now: number) {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  const wake = nextWake(app.threads, now);
  const hourly = settings.state.autoSettleDays > 0 ? now + HOURLY : null;
  const at = wake === null ? hourly : hourly === null ? wake : Math.min(wake, hourly);
  if (at === null) return;
  // Capped because a timeout past 2^31 ms fires immediately, and a thread
  // snoozed for a year is a legitimate thing to ask for.
  const delay = Math.min(Math.max(at - now, 1_000), HOURLY);
  timer = setTimeout(sweep, delay);
}

/** Starts the clock, and returns the way to stop it. */
export function startThreadAgeing(): () => void {
  running = true;
  sweep();
  return () => {
    running = false;
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
}

/**
 * Runs the pass again, for when a thread was snoozed or the setting changed.
 *
 * Both are moments `arm` could not have known about: it is armed for the list as
 * it was, and the default boot state (nothing snoozed, auto-settle off) arms no
 * timer at all, so the first snooze of a session would otherwise never be woken
 * by anything. A whole pass rather than just a rearm because turning
 * auto-settle on is a request about the threads that are already old, and an
 * hour is a long time to look at a list that ignored the setting.
 *
 * Not the other way round: the settle writes the pass itself makes do not come
 * back through here, or every due thread would ask for another pass.
 */
export function rearmThreadAgeing() {
  if (!running) return;
  sweep();
}

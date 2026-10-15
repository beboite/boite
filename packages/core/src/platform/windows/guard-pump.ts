/**
 * How long the guard pump may block, with nothing native in it.
 *
 * The pump sleeps in `MsgWaitForMultipleObjects`. A window event or a thread
 * message ends the wait, a Worker command does not: it waits for the pump to
 * give the JS event loop its turn. Once the main thread can post the pump a
 * `WM_NULL` after every command, the wait no longer has to be short to see
 * commands, and the pump wakes once a second instead of ten times.
 */

/** Slots of the Int32Array the main thread and the Worker share. */
export const PUMP_STOP = 0;
/** Commands the main thread posted after `start`. */
export const PUMP_POSTED = 1;
/** 1 while the main thread wakes the pump after each command. */
export const PUMP_WAKEABLE = 2;
export const PUMP_SLOTS = 3;

/** The wait while nothing can wake the pump: a command is seen within it. */
export const PUMP_SHORT_WAIT_MS = 100;
/** The wait once commands wake the pump: one turn per audio poll. */
export const PUMP_LONG_WAIT_MS = 1000;

export interface PumpState {
  /** Commands the main thread posted, and the ones this Worker has handled. */
  posted: number;
  handled: number;
  /** The main thread posts a thread message after every command and the stop. */
  wakeable: boolean;
  /** Milliseconds until a walk a new pid waits for, null when none waits. */
  walkIn: number | null;
  /** Milliseconds until the regular audio poll. */
  pollIn: number;
}

/**
 * The bound of the next wait. A command posted but not handled yet means its
 * message is queued on the JS side: the pump must not block in front of it,
 * since the `WM_NULL` that came with it may already be drained.
 */
export function pumpWaitMs(state: PumpState): number {
  if (state.posted !== state.handled) return 0;
  let wait = state.wakeable ? PUMP_LONG_WAIT_MS : PUMP_SHORT_WAIT_MS;
  if (state.walkIn !== null) wait = Math.min(wait, state.walkIn);
  return Math.max(0, Math.min(wait, state.pollIn));
}

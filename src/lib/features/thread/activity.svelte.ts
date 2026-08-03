/**
 * When each thread last changed what it was doing.
 *
 * The row already says a thread is working; what it could never say is for how
 * long, or how long ago it stopped — which is the whole question a dashboard
 * with six terminals on it is asked. Nothing recorded it: `createdAt` is when
 * the row was made, and the status itself carries no timestamp.
 *
 * In memory only, deliberately. This is a reading of the session in front of
 * you, so after a restart a thread is as old as its row and says so, rather
 * than claiming to have been idle since a date nobody was there for.
 */
const since = $state<Record<string, number>>({});

/** A thread's status moved. Called from the one place both the local and the
    remote path already pass through. */
export function noteThreadActivity(threadId: string, at = Date.now()) {
  since[threadId] = at;
}

/** When this thread entered the state it is in, or null if not seen change. */
export function threadActivitySince(threadId: string): number | null {
  return since[threadId] ?? null;
}

export function forgetThreadActivity(threadId: string) {
  delete since[threadId];
}

/** A workspace switch replaces every thread, and none of these timestamps
    describe the ones that arrive. */
export function resetThreadActivity() {
  for (const id of Object.keys(since)) delete since[id];
}

/**
 * Who asked for a chat thread's native session, and whether it is still theirs.
 *
 * `Runtime::open` stops whatever session a thread already has before it starts
 * a new one, which is right when the caller means "give me this conversation
 * here, now" and wrong every other time. So the window keeps the one fact the
 * host cannot answer for it: this row was opened from here and nothing has
 * stopped it since. The launchers set it, the stop paths clear it, and the pane
 * reads it before resuming a row it would otherwise restart mid-turn.
 *
 * Deliberately not `$state`: nothing draws it, and a set that made panes
 * re-render on every launch would be a frame spent on bookkeeping.
 */

import { backend } from "$lib/backend";
import { notifications } from "$lib/features/notifications/store.svelte";
import { logger } from "$lib/shared/services/logger.svelte";
import { t } from "$lib/i18n/index.svelte";

const openedHere = new Set<string>();

/**
 * Starts or resumes a row's native session, and remembers that we did.
 *
 * Never awaited by a launcher: the pane mounts, reads its timeline and
 * subscribes on its own, and a launch held open for a process spawn is the
 * round trip the terminal path spent years removing. A failure is a toast and a
 * log line rather than a failed launch, since the row exists either way and the
 * composer's own button opens it again.
 */
export function openPilotSession(threadId: string): Promise<void> {
  openedHere.add(threadId);
  return backend()
    .pilot.open(threadId)
    .then(() => undefined)
    .catch((err: unknown) => {
      openedHere.delete(threadId);
      logger.warn("pilot", `${threadId}: session did not open`, String(err));
      notifications.error(t("pilot.openFailed"));
    });
}

/** Whether this window opened a session for this row and has not stopped it. */
export function pilotSessionOpenedHere(threadId: string): boolean {
  return openedHere.has(threadId);
}

/** The row's session is gone: stopped, auto-slept, or its thread closed. */
export function forgetPilotSession(threadId: string): void {
  openedHere.delete(threadId);
}

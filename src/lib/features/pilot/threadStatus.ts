/**
 * A chat thread's status, arriving from the desktop host.
 *
 * The one status in the app that is told rather than measured: no pid registry,
 * no screen rows, no clock. It used to be derived inside `ChatPane.svelte`,
 * which meant a row only had a status while somebody was drawing it, and an
 * agent's own thread lives in a hidden group where nothing is drawn. The dot in
 * the sidebar is exactly what the user watches from outside that group.
 *
 * So the host is the source now. The projection writes the row's status column
 * and pushes `boite://thread-status` here (`src-tauri/src/commands/pilot.rs`);
 * a remote boite pushes the same fact as the `thread.status` control event it
 * already sends for every terminal thread, which `app/control-events.ts`
 * applies. This is the desktop half of that one arrangement.
 */

import { app } from "$lib/app/store.svelte";
import { announceStatus } from "$lib/features/thread/statusEngine";
import { logger } from "$lib/shared/services/logger.svelte";
import type { ThreadStatus } from "$lib/types";

const THREAD_STATUS = "boite://thread-status";

/** The three words `boite_core::pilot::status_word` answers. */
const KNOWN = new Set<ThreadStatus>(["running", "waiting", "ready"]);

/** Applies one pushed status. Exported for its test, which has no Tauri bus. */
export function applyPilotStatus(threadId: string, status: string): void {
  const thread = app.threadById(threadId);
  if (!thread) return;
  const next = status as ThreadStatus;
  if (!KNOWN.has(next)) {
    logger.warn("pilot", `${threadId}: unknown status pushed`, status);
    return;
  }
  // The same two notifications a terminal thread raises, on the same terms:
  // `announceStatus` keeps its own record of what each thread last read, so the
  // first event about a thread is a reading and says nothing.
  announceStatus(thread, next);
  if (thread.status !== next) app.setThreadStatus(threadId, next);
}

/**
 * Listens for as long as the window is up, and hands back the unsubscribe.
 *
 * Desktop only: on the web there is no Tauri event bus, and a remote workspace
 * carries the same fact down the control plane instead. A no-op there rather
 * than a failure to load.
 */
export function watchPilotStatus(): () => void {
  let stop: (() => void) | null = null;
  let dropped = false;
  void import("@tauri-apps/api/event")
    .then(({ listen }) =>
      listen<{ threadId?: string; status?: string }>(THREAD_STATUS, (event) => {
        const id = event.payload?.threadId;
        const status = event.payload?.status;
        if (id && status) applyPilotStatus(id, status);
      }),
    )
    .then((unlisten) => {
      if (dropped) unlisten();
      else stop = unlisten;
    })
    .catch(() => {});
  return () => {
    dropped = true;
    stop?.();
  };
}

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
 * Ownership stays private; the connection map exposes startup and retry state.
 */

import { backend } from "$lib/backend";
import { notifications } from "$lib/features/notifications/store.svelte";
import { logger } from "$lib/shared/services/logger.svelte";
import { t } from "$lib/i18n/index.svelte";
import { pilotConnections } from "./connection.svelte";

const openedHere = new Set<string>();
const pending = new Map<string, Promise<void>>();

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
  const existing = pending.get(threadId);
  if (existing) return existing;
  openedHere.add(threadId);
  pilotConnections.set(threadId, "opening");
  const opening = Promise.resolve()
    .then(() => backend().pilot.open(threadId))
    .then(() => {
      if (openedHere.has(threadId)) pilotConnections.set(threadId, "ready");
    })
    .catch((err: unknown) => {
      if (!openedHere.has(threadId)) return;
      openedHere.delete(threadId);
      pilotConnections.set(threadId, "failed");
      logger.warn("pilot", `${threadId}: session did not open`, String(err));
      notifications.error(t("pilot.openFailed"));
    })
    .finally(() => pending.delete(threadId));
  pending.set(threadId, opening);
  return opening;
}

/**
 * The three steps a chat launch runs, in the one order that works.
 *
 * `pilot.open` reads the `threads` row and refuses with "no thread <id>" while
 * the insert is still in flight. The launcher used to fire it beside the write
 * rather than behind it, so on a machine under load the pane came up on a row
 * whose session had never been opened, and the only way back in was the
 * composer's own button. Await the row, show the pane, then open the engine.
 * Startup latency and failures are visible inside the conversation.
 *
 * Its own function so the order is testable: the launchers it serves reach
 * into the app store, the backend and the worktree pool, and none of that is
 * what a test of the order needs to build.
 */
export async function openChatThread(steps: {
  /** Resolves when the `threads` row is in the database. */
  created: () => Promise<unknown>;
  /** Resolves when the host has been asked for a session on that row. */
  opened: () => Promise<unknown>;
  /** Puts the pane on screen. Nothing waits on it. */
  shown: () => void;
}): Promise<void> {
  await steps.created();
  steps.shown();
  await steps.opened();
}

/** Whether this window opened a session for this row and has not stopped it. */
export function pilotSessionOpenedHere(threadId: string): boolean {
  return openedHere.has(threadId);
}

/** The row's session is gone: stopped, auto-slept, or its thread closed. */
export function forgetPilotSession(threadId: string): void {
  openedHere.delete(threadId);
  pilotConnections.delete(threadId);
}

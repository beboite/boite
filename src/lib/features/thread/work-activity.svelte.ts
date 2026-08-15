import { logger } from "$lib/shared/services/logger.svelte";

/**
 * When an agent last picked up a task in each thread.
 *
 * The one question the sidebar's order is really asking, and neither of the two
 * things that were tried before it. Not every status change, which
 * `activity.svelte.ts` stamps: a thread finishing, going quiet or being woken
 * by a poll moves that one, so an order built on it rearranged itself around
 * nothing. And not the user's input either, which is what this file used to
 * hold: the terminal writes back on its own through the same channel a
 * keystroke leaves by — focus reports above all — so clicking a thread stamped
 * it and sent it to the top, which is the bug this replaced.
 *
 * So: the moment a thread entered `running`, written from the one funnel both
 * the local and the remote status paths already pass through
 * (`noteStatusChange`). A thread no agent has worked in on this device ranks by
 * its row's age rather than as never.
 *
 * Persisted per device rather than kept for the session, and that is the whole
 * point: the order is a memory of where the work has been, and an app restart
 * is exactly when that memory is worth having. Same storage as the layout blob
 * (localStorage, `settings.store`'s DEVICE_KEY neighbour), because the answer
 * belongs to this screen and not to the boite every device shares.
 */
const STORE_KEY = "boite.threadWorkStarted";

// What this file held before the order stopped being about typing. Dropped on
// load so a device that has been through the old build does not carry a blob
// nothing will ever read again.
const RETIRED_KEY = "boite.threadUserActivity";

// A burst of status changes is one write rather than several. Nothing on screen
// is waiting for it: the sort reads the state, not the blob.
const FLUSH_DEBOUNCE_MS = 10_000;

// A device that has been through a few hundred threads should not carry all of
// them forever. The cap keeps the most recent, which is the only end an order
// by recency ever reads.
const MAX_ENTRIES = 400;

function load(): Record<string, number> {
  if (typeof localStorage === "undefined") return {};
  try {
    localStorage.removeItem(RETIRED_KEY);
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, number> = {};
    for (const [id, at] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof at === "number" && Number.isFinite(at)) out[id] = at;
    }
    return out;
  } catch {
    return {};
  }
}

const started = $state<Record<string, number>>(load());

let flushTimer: ReturnType<typeof setTimeout> | null = null;

function trimmed(): Record<string, number> {
  const entries = Object.entries(started);
  if (entries.length <= MAX_ENTRIES) return { ...started };
  entries.sort((a, b) => b[1] - a[1]);
  return Object.fromEntries(entries.slice(0, MAX_ENTRIES));
}

/** Writes now. Exported for the page-hide path, which has no time to wait. */
export function flushWorkActivity() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(trimmed()));
  } catch (err) {
    logger.error("threads", "work activity persist failed", String(err));
  }
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushWorkActivity();
  }, FLUSH_DEBOUNCE_MS);
}

// The debounce is what makes a busy workspace cheap, and it is also what would
// lose the last ten seconds of it if the window went away mid-wait. Installed by
// the module rather than by a component, because the answer has to be written
// whether or not anything happened to be mounted. `pagehide` covers the tab and
// the desktop window closing; `visibilitychange` is the one a phone actually
// fires when the app is swiped away.
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => flushWorkActivity());
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) flushWorkActivity();
  });
}

/**
 * An agent started working in this thread.
 *
 * The transition into `running`, never the state: the status sweep re-asserts
 * `running` twice a second for as long as a turn lasts, and a stamp moved by
 * each of those would rank a long task above a fresh one.
 */
export function noteWorkStarted(threadId: string, at = Date.now()) {
  started[threadId] = at;
  scheduleFlush();
}

/** When an agent last started working in this thread, or null if never on this
    device. */
export function workStartedSince(threadId: string): number | null {
  return started[threadId] ?? null;
}

export function forgetWorkStarted(threadId: string) {
  if (started[threadId] === undefined) return;
  delete started[threadId];
  scheduleFlush();
}

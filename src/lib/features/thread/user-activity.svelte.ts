import { logger } from "$lib/shared/services/logger.svelte";

/**
 * When the user last typed into each thread.
 *
 * Deliberately not the same question as `activity.svelte.ts`, which stamps
 * every status change: an agent starting a turn on its own, finishing one at
 * three in the morning or being woken by a poll all move that timestamp, so an
 * order built on it rearranges itself around work nobody asked for. This one
 * only moves when input leaves the keyboard for the PTY, which is the thing a
 * "what was I last on" order is actually asking about.
 *
 * Persisted per device rather than kept for the session, and that is the whole
 * point: the order is a memory of what the user was doing, and an app restart
 * is exactly when that memory is worth having. Same storage as the layout blob
 * (localStorage, `settings.store`'s DEVICE_KEY neighbour), because the answer
 * belongs to this screen and not to the boite every device shares.
 */
const STORE_KEY = "boite.threadUserActivity";

// Every keystroke moves the in-memory stamp; the disk write waits. Ten seconds
// of typing is one write rather than several hundred, and nothing on screen is
// waiting for it: the sort reads the state, not the blob.
const FLUSH_DEBOUNCE_MS = 10_000;

// A device that has been through a few hundred threads should not carry all of
// them forever. The cap keeps the most recent, which is the only end an order
// by recency ever reads.
const MAX_ENTRIES = 400;

function load(): Record<string, number> {
  if (typeof localStorage === "undefined") return {};
  try {
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

const typed = $state<Record<string, number>>(load());

let flushTimer: ReturnType<typeof setTimeout> | null = null;

function trimmed(): Record<string, number> {
  const entries = Object.entries(typed);
  if (entries.length <= MAX_ENTRIES) return { ...typed };
  entries.sort((a, b) => b[1] - a[1]);
  return Object.fromEntries(entries.slice(0, MAX_ENTRIES));
}

/** Writes now. Exported for the page-hide path, which has no time to wait. */
export function flushUserActivity() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(trimmed()));
  } catch (err) {
    logger.error("threads", "user activity persist failed", String(err));
  }
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushUserActivity();
  }, FLUSH_DEBOUNCE_MS);
}

// The debounce is what makes typing cheap, and it is also what would lose the
// last ten seconds of it if the window went away mid-wait. Installed by the
// module rather than by a component, because the answer has to be written
// whether or not anything happened to be mounted. `pagehide` covers the tab and
// the desktop window closing; `visibilitychange` is the one a phone actually
// fires when the app is swiped away.
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => flushUserActivity());
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) flushUserActivity();
  });
}

/**
 * The user sent something to this thread.
 *
 * Called from the one funnel every input goes through on its way to the PTY, so
 * a phone's key bar and a desktop keystroke count the same and neither the
 * agent's output nor a status poll counts at all.
 */
export function noteUserInput(threadId: string, at = Date.now()) {
  typed[threadId] = at;
  scheduleFlush();
}

/** When the user last typed into this thread, or null if never on this device. */
export function userActivitySince(threadId: string): number | null {
  return typed[threadId] ?? null;
}

export function forgetUserActivity(threadId: string) {
  if (typed[threadId] === undefined) return;
  delete typed[threadId];
  scheduleFlush();
}

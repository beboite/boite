import { logger } from "$lib/shared/services/logger.svelte";

/**
 * Where the work has been: per thread, and per project.
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
 * (`noteStatusChange`), plus the moments the user themselves asked for work —
 * a launch, a line submitted into a pane. A thread no agent has worked in on
 * this device ranks by its row's age rather than as never.
 *
 * The project ledger is the same answer at the level above, and it is a
 * separate map on purpose. A project used to rank by the highest stamp among
 * the threads it still has, so closing the thread that held that stamp took the
 * stamp with it and the project sank in the list while the user was doing
 * nothing but tidying up. What the order wants is a memory of when work last
 * happened here, which is a fact about the project and outlives any one thread,
 * so it is written down per project and only ever moves forward.
 *
 * Persisted per device rather than kept for the session, and that is the whole
 * point: the order is a memory of where the work has been, and an app restart
 * is exactly when that memory is worth having. Same storage as the layout blob
 * (localStorage, `settings.store`'s DEVICE_KEY neighbour), because the answer
 * belongs to this screen and not to the boite every device shares.
 */
const STORE_KEY = "boite.threadWorkStarted";
const PROJECT_KEY = "boite.projectWorkStarted";

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

/**
 * How long a woken thread is allowed to look busy without it counting as work.
 *
 * Waking is not working. A thread coming back — clicked awake after an
 * auto-sleep, relaunched, or resumed by an app restart — replays its
 * conversation, and the replay draws the same spinner a real turn draws, so the
 * status engine reports `running` and the order used to hoist the project on
 * it. An app restart did it for every thread at once, which reshuffled the
 * whole sidebar around nothing the user had asked for.
 *
 * So the first `running` after a resume is spent rather than stamped, and the
 * mark is dropped the moment the user actually submits a line into that pane:
 * waking a thread to give it work is two events, and only the second one is
 * work.
 */
const WAKE_GRACE_MS = 120_000;

function load(key: string): Record<string, number> {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(key);
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

function dropRetired() {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(RETIRED_KEY);
  } catch {
    // A storage that refuses a delete is one nothing else here can use either.
  }
}

dropRetired();

const started = $state<Record<string, number>>(load(STORE_KEY));
const projects = $state<Record<string, number>>(load(PROJECT_KEY));

let flushTimer: ReturnType<typeof setTimeout> | null = null;

// The threads a resume is still in flight for, and when it started. In memory
// only: a mark that survived a restart would swallow the first real turn after
// it, and the restart itself is what armed it in the first place.
const waking = new Map<string, number>();

function trimmed(map: Record<string, number>): Record<string, number> {
  const entries = Object.entries(map);
  if (entries.length <= MAX_ENTRIES) return { ...map };
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
    localStorage.setItem(STORE_KEY, JSON.stringify(trimmed(started)));
    localStorage.setItem(PROJECT_KEY, JSON.stringify(trimmed(projects)));
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

/**
 * Work happened in this project.
 *
 * Only ever forward. Every caller is reporting something that just happened, so
 * a stamp older than the one already written is a clock that went backwards or
 * a seed replaying history, and neither is a reason to demote a project.
 */
export function noteProjectWork(projectId: string, at = Date.now()) {
  const known = projects[projectId] ?? 0;
  if (at <= known) return;
  projects[projectId] = at;
  scheduleFlush();
}

/** When an agent last started working in this thread, or null if never on this
    device. */
export function workStartedSince(threadId: string): number | null {
  return started[threadId] ?? null;
}

/** When work last happened in this project, or null if never on this device. */
export function projectWorkSince(projectId: string): number | null {
  return projects[projectId] ?? null;
}

export function forgetWorkStarted(threadId: string) {
  waking.delete(threadId);
  if (started[threadId] === undefined) return;
  delete started[threadId];
  scheduleFlush();
}

/** A project that is gone takes its place in the order with it. */
export function forgetProjectWork(projectId: string) {
  if (projects[projectId] === undefined) return;
  delete projects[projectId];
  scheduleFlush();
}

/**
 * This thread is coming back rather than starting: hold its next `running`.
 *
 * Armed by the pane whenever it spawns onto a conversation that already exists,
 * which covers all three ways a thread wakes up — clicked awake after an
 * auto-sleep, relaunched by hand, resumed by the app restarting.
 */
export function noteThreadWaking(threadId: string, at = Date.now()) {
  waking.set(threadId, at);
}

/**
 * Whether this thread's `running` is a replay, and spends the mark if it is.
 *
 * One `running` per resume: whatever the agent does after that is its own.
 */
export function consumeWaking(threadId: string, at = Date.now()): boolean {
  const armed = waking.get(threadId);
  if (armed === undefined) return false;
  waking.delete(threadId);
  return at - armed < WAKE_GRACE_MS;
}

/** The user submitted a line here, so nothing about this thread is a replay. */
export function clearWaking(threadId: string) {
  waking.delete(threadId);
}

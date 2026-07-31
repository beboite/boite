// Which threads carry a name the user typed. Agent CLIs re-emit an OSC title
// every few seconds, so without this a hand-picked name would be overwritten
// moments after being set: the title pipeline (OSC locally, thread.title
// control events remotely) skips every thread listed here.
//
// Device-scoped, like the layout blob: the name itself lives in the thread row
// and travels with the workspace, only the "stop retitling this" flag is local.

import { logger } from "$lib/shared/services/logger.svelte";

const KEY = "boite.renamedThreads";

let ids: Set<string> | null = null;

function all(): Set<string> {
  if (ids) return ids;
  ids = new Set();
  if (typeof localStorage === "undefined") return ids;
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? "[]") as unknown;
    if (Array.isArray(parsed)) {
      for (const id of parsed) if (typeof id === "string") ids.add(id);
    }
  } catch {
    // Unreadable blob: start empty rather than refuse to rename anything.
  }
  return ids;
}

function persist() {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(KEY, JSON.stringify([...all()]));
  } catch (err) {
    logger.error("thread", "renamedThreads persist failed", String(err));
  }
}

export function isRenamed(id: string): boolean {
  return all().has(id);
}

export function markRenamed(id: string) {
  const set = all();
  if (set.has(id)) return;
  set.add(id);
  persist();
}

export function clearRenamed(id: string) {
  const set = all();
  if (!set.delete(id)) return;
  persist();
}

// Threads closed on another device never pass through removeThread here, so
// their ids would accumulate forever. Called once per load with the surviving
// set.
export function pruneRenamed(existing: Iterable<string>) {
  const set = all();
  if (set.size === 0) return;
  const alive = new Set(existing);
  let dropped = false;
  // Deleting the entry the loop is standing on is defined behaviour for a Set —
  // the iterator moves to the next live one — so this does not need a copy.
  for (const id of set) {
    if (!alive.has(id)) {
      set.delete(id);
      dropped = true;
    }
  }
  if (dropped) persist();
}

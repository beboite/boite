import { backend } from "$lib/backend";
import { log } from "$lib/shared/log";
import { emptyState, fromRows, reduce, turnDiff, type PilotThreadState } from "./reduce";
import type { PilotEvent, PilotItemRow, PilotTurnDiff } from "./types";

/**
 * One chat thread's timeline, live.
 *
 * The reduction is `reduce.ts` and has no Svelte in it; what is here is the
 * three things reactivity costs: when a delta reaches `$state`, when a
 * subscription starts, and when both are dropped.
 *
 * The rule the shape enforces: **a delta never writes state.** Deltas land in a
 * buffer keyed by item, and one animation frame later the whole buffer is
 * applied and the thread's view is replaced once. A two hundred token turn is
 * one paint per frame rather than two hundred paints, which is the render
 * budget `docs/pilot.md` writes down.
 */

/** How many rows one cursor page reads. The host clamps anything larger. */
const PAGE = 200;

/** What a pane reads. Replaced whole on a flush, never mutated in place. */
const views = $state<Record<string, PilotThreadState>>({});

/** The live reduction, off `$state` so a delta costs no reactivity at all. */
const states = new Map<string, PilotThreadState>();

/** Deltas waiting for the next frame, joined per item. */
const pending = new Map<string, Map<string, string>>();

/** The unsubscribe each loaded thread owns. */
const feeds = new Map<string, () => void>();

/** The frame a flush is already armed on, so one frame arms one flush. */
let frame: number | null = null;

/** The timeline of a thread, empty until `load` has read it. */
export function pilotThread(threadId: string): PilotThreadState {
  return views[threadId] ?? emptyState();
}

/** What a completed turn changed, or null before its diff was written. */
export function pilotTurnDiff(threadId: string, turnId: string): PilotTurnDiff | null {
  const state = states.get(threadId);
  return state ? turnDiff(state, turnId) : null;
}

/**
 * Reads a thread's timeline by cursor, then subscribes.
 *
 * In that order and never the other way round: subscribing first would push
 * events for rows the read has not returned yet, and the reduction would open
 * cards the page below is about to open again. Reading first and subscribing on
 * the cursor the read ended at is what makes an arrival mid-turn seamless, the
 * host's `after_seq` being exclusive.
 *
 * Called twice on one thread, the second call is the first one's promise: a
 * pane mounting while its own load is in flight must not open a second feed.
 */
export async function load(threadId: string): Promise<void> {
  if (feeds.has(threadId)) return;
  const state = emptyState();
  states.set(threadId, state);
  try {
    let after = 0;
    for (;;) {
      const rows: PilotItemRow[] = await backend().pilot.items(threadId, after, PAGE);
      if (rows.length === 0) break;
      fromRows(rows, state);
      after = rows[rows.length - 1].seq;
      if (rows.length < PAGE) break;
    }
  } catch (err) {
    log.warn("pilot.store", "pilot.items.failed", { thread: threadId, reason: String(err) });
  }
  views[threadId] = { ...state };
  if (feeds.has(threadId)) return;
  try {
    feeds.set(
      threadId,
      backend().pilot.subscribe(threadId, (event) => apply(threadId, event)),
    );
  } catch (err) {
    log.warn("pilot.store", "pilot.subscribe.failed", { thread: threadId, reason: String(err) });
  }
}

/**
 * Drops a thread: the feed, the buffers and the view.
 *
 * A pane that closes has to call this. The host keeps pushing at a device that
 * asked for a thread until it says otherwise, and a buffer nothing reads is a
 * turn's worth of text held for a pane that is gone.
 */
export function release(threadId: string): void {
  feeds.get(threadId)?.();
  feeds.delete(threadId);
  pending.delete(threadId);
  states.delete(threadId);
  delete views[threadId];
}

/** Every loaded thread lets go, for a disconnect or a window teardown. */
export function releaseAll(): void {
  for (const threadId of Array.from(feeds.keys())) release(threadId);
}

/**
 * One event in.
 *
 * A delta is buffered and a frame is armed; everything else is applied at once,
 * with whatever that thread has buffered flushed first. A complete card painted
 * before the tail of its own text would draw the tail twice, which is the same
 * rule the hosts follow when they coalesce.
 */
function apply(threadId: string, event: PilotEvent): void {
  const state = states.get(threadId);
  if (!state) return;
  if (event.kind === "item.delta") {
    let held = pending.get(threadId);
    if (!held) {
      held = new Map();
      pending.set(threadId, held);
    }
    held.set(event.item_id, (held.get(event.item_id) ?? "") + event.text);
    arm();
    return;
  }
  drain(threadId);
  if (reduce(state, event)) publish(threadId, state);
}

function arm(): void {
  if (frame !== null) return;
  const schedule =
    typeof requestAnimationFrame === "function"
      ? requestAnimationFrame
      : (fn: () => void) => setTimeout(fn, 16) as unknown as number;
  frame = schedule(() => {
    frame = null;
    for (const threadId of Array.from(pending.keys())) {
      const state = states.get(threadId);
      if (!state) {
        pending.delete(threadId);
        continue;
      }
      if (drain(threadId)) publish(threadId, state);
    }
  }) as unknown as number;
}

/** Applies what a thread buffered. Answers whether anything moved. */
function drain(threadId: string): boolean {
  const held = pending.get(threadId);
  const state = states.get(threadId);
  if (!held || !state) return false;
  pending.delete(threadId);
  let moved = false;
  for (const [itemId, text] of held) {
    if (reduce(state, { kind: "item.delta", item_id: itemId, text })) moved = true;
  }
  return moved;
}

/**
 * Hands the reduction to `$state`, once.
 *
 * A shallow copy rather than the live object: the reduction mutates, and a pane
 * reading the same reference would see rows change under it without the effect
 * that draws them ever running.
 */
function publish(threadId: string, state: PilotThreadState): void {
  views[threadId] = { ...state, items: [...state.items] };
}

/** For the tests, which do not have a window to hold state between them. */
export function resetPilotStoreForTest(): void {
  releaseAll();
  pending.clear();
  states.clear();
  frame = null;
}

import type { Journal } from '../journal.ts';
import { moveInlineOutputs, moveInlineValues, recodePartBlobs } from './part-blobs.ts';
import { deleteUnusedCommandLines, internOldCommandLines, TracePrune } from './processes.ts';
import { messageOfError } from './stream-buffer.ts';

/** How long events are kept. The projections hold the state; events are the recent trail. */
export const EVENT_RETENTION_MS = 30 * 86_400_000;
/** How long the trail events (`TRAIL_ONLY`) written before they stopped are kept. */
export const TRAIL_RETENTION_MS = 3 * 86_400_000;
const RETENTION_FIRST_MS = 60_000;
const RETENTION_EVERY_MS = 86_400_000;
const RETENTION_BATCH = 5_000;
const TRAIL_CURSOR = 'events:trail-pruned-through';

/**
 * Prunes events past the retention a minute after start and then daily, one
 * batch per timer tick so that no pass holds the event loop on an old machine:
 * the trail events first, walked forward from where the last pass stopped,
 * then every event past 30 days from the front of the table. The daily pass
 * ends with `PRAGMA optimize`. Returns the stop.
 */
export function scheduleEventRetention(journal: Journal, onError: (message: string) => void): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const arm = (delay: number): void => {
    timer = setTimeout(pass, delay);
    timer.unref?.();
  };
  const pass = (): void => {
    timer = null;
    if (journal.isClosed()) return;
    try {
      if (pruneEventsOnce(journal, Date.now())) {
        arm(10);
        return;
      }
      journal.optimize();
    } catch (error) {
      onError(`journal event retention: ${messageOfError(error)}`);
    }
    arm(RETENTION_EVERY_MS);
  };
  arm(RETENTION_FIRST_MS);
  return () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
}

/** One batch of event retention at `now`; true while more is left. */
export function pruneEventsOnce(journal: Journal, now: number): boolean {
  const after = (journal.getSetting(TRAIL_CURSOR) as number | undefined) ?? 0;
  const trail = journal.pruneTrail(after, now - TRAIL_RETENTION_MS, RETENTION_BATCH);
  if (trail.through !== after) journal.setSetting(TRAIL_CURSOR, trail.through);
  if (!trail.done) return true;
  return journal.pruneEvents(now - EVENT_RETENTION_MS, RETENTION_BATCH) > 0;
}

const MOVE_FIRST_MS = 3 * 60_000;
const MOVE_EVERY_MS = 250;
const MOVE_RETRY_MS = 30_000;
const DAILY_MS = 86_400_000;
/** About how many bytes of stored values one tick reads, so a tick stays in the tens of milliseconds. */
export const COMPACTION_TICK_BYTES = 2 * 1024 * 1024;
/** Trace rows or command lines one tick reads or rewrites. */
export const COMPACTION_TICK_ROWS = 2_000;
/** A cursor at this value is a pass that finished: rows written since are in the new shape. */
const DONE = Number.MAX_SAFE_INTEGER;
const PRUNED_THROUGH = 'processes:pruned-through';
const PRUNED_AT = 'processes:pruned-at';
const UNUSED_AT = 'command-lines:cleaned-at';
const UNUSED_THROUGH = 'command-lines:cleaned-through';

/** What one step did: more is left, it is finished, or an open message holds it. */
type Step = 'more' | 'done' | 'busy';

/** One pass over rows written in an older shape, resumed from a rowid kept in settings. */
function rowPass(journal: Journal, key: string, run: (after: number) => number | null): Step {
  const after = (journal.getSetting(key) as number | undefined) ?? 0;
  if (after === DONE) return 'done';
  const through = run(after);
  if (through === -1) return 'busy';
  journal.setSetting(key, through === null ? DONE : through);
  return through === null ? 'done' : 'more';
}

/**
 * A walk that starts again a day after it last ended, resumed from the cursor
 * kept under `throughKey`: `run` takes it and returns the next one and
 * whether anything is left.
 */
function dailyPass(journal: Journal, now: number, atKey: string, throughKey: string, run: (after: unknown) => { through: unknown; more: boolean }): Step {
  const at = journal.getSetting(atKey) as number | undefined;
  if (at !== undefined && now - at < DAILY_MS) return 'done';
  const after = journal.getSetting(throughKey);
  const { through, more } = run(after);
  if (more) {
    if (through !== after) journal.setSetting(throughKey, through);
    return 'more';
  }
  journal.setSetting(atKey, now);
  journal.deleteSetting(throughKey);
  return 'done';
}

/**
 * The steps of the background compaction, in order. A step that finished is
 * skipped from then on; the daily ones run again a day after they last ended.
 */
export function compactionSteps(journal: Journal): ((now: number) => Step)[] {
  const isOpen = (id: string) => journal.streamingMessage(id) !== undefined;
  const trace = new TracePrune(journal.db, COMPACTION_TICK_ROWS);
  return [
    // Values of 32 KiB and more of rows written before `part_blobs`.
    () => rowPass(journal, 'part-blobs:moved-through', after => moveInlineValues(journal.db, after, isOpen)),
    // Tool outputs of 4 to 32 KiB of rows written before schema 36.
    () => rowPass(journal, 'part-blobs:outputs-moved-through', after => moveInlineOutputs(journal.db, after, COMPACTION_TICK_BYTES, isOpen)),
    // `part_blobs` rows stored as text before schema 36.
    () => rowPass(journal, 'part-blobs:recoded-through', after => recodePartBlobs(journal.db, after, COMPACTION_TICK_BYTES)),
    // Command lines of trace rows written before schema 36.
    () => rowPass(journal, 'processes:interned-through', after => internOldCommandLines(journal.db, after, COMPACTION_TICK_ROWS)),
    // Every thread's trace cut to what it keeps, a bounded batch per tick, then once a day.
    now => dailyPass(journal, now, PRUNED_AT, PRUNED_THROUGH, after => trace.step((after as string | undefined) ?? '')),
    // Command lines no trace row names any more, once a day.
    now => dailyPass(journal, now, UNUSED_AT, UNUSED_THROUGH, after => {
      const through = deleteUnusedCommandLines(journal.db, (after as number | undefined) ?? 0, COMPACTION_TICK_ROWS);
      return { through, more: through !== null };
    }),
  ];
}

/**
 * Runs the first step that is not finished, once. Returns 'done' when every
 * step is, which is when the timer waits a day.
 */
export function compactOnce(journal: Journal, steps: ((now: number) => Step)[], now: number): Step {
  for (const step of steps) {
    const result = step(now);
    if (result !== 'done') return result;
  }
  return 'done';
}

/**
 * Brings rows written in an older shape to the current one and keeps the
 * trace bounded, one bounded batch per tick 250 ms apart, starting a few
 * minutes after start (`compactionSteps`). A streaming turn pauses it. Each
 * step keeps its cursor in settings, so a finished journal is never scanned
 * again; once every step is done it wakes once a day for the daily ones.
 * Returns the stop.
 */
export function scheduleInlineValueMoves(journal: Journal, onError: (message: string) => void): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const steps = compactionSteps(journal);
  const arm = (delay: number): void => {
    timer = setTimeout(pass, delay);
    timer.unref?.();
  };
  const pass = (): void => {
    timer = null;
    if (journal.isClosed()) return;
    if (journal.hasOpenMessages()) { arm(MOVE_RETRY_MS); return; }
    try {
      journal.flushDeltas();
      const result = compactOnce(journal, steps, Date.now());
      arm(result === 'more' ? MOVE_EVERY_MS : result === 'busy' ? MOVE_RETRY_MS : DAILY_MS);
    } catch (error) {
      onError(`journal compaction: ${messageOfError(error)}`);
      arm(MOVE_RETRY_MS);
    }
  };
  arm(MOVE_FIRST_MS);
  return () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
}

import type { Journal } from '../journal.ts';
import { moveInlineOutputs, moveInlineValues, recodePartBlobs, type PassResult } from './part-blobs.ts';
import { internOldCommandLines, TracePrune, type TracePhase } from './processes.ts';
import { messageOfError } from './stream-buffer.ts';
import { TRAIL_CURSOR } from './trail.ts';

/** How long events are kept. The projections hold the state; events are the recent trail. */
export const EVENT_RETENTION_MS = 30 * 86_400_000;
/** How long the trail events (`TRAIL_ONLY`) written before they stopped are kept. */
export const TRAIL_RETENTION_MS = 3 * 86_400_000;
const RETENTION_FIRST_MS = 60_000;
const RETENTION_EVERY_MS = 86_400_000;

/**
 * About how long one background tick may hold the event loop. Each pass sizes
 * its batch to the time its last tick took (`Pace`): a slow disk or a busy
 * machine gets smaller batches, never longer ticks.
 */
export const TICK_TARGET_MS = 40;

/** A batch size that follows the time its last tick took, between `min` and `max`. */
export class Pace {
  constructor(public size: number, readonly min: number, readonly max: number) {}

  /** Runs `run` at the current size, then halves it after a tick past the target or grows it by half after one under half of it. */
  async run<T>(run: (size: number) => T | Promise<T>): Promise<T> {
    const started = performance.now();
    const result = await run(this.size);
    const ms = performance.now() - started;
    if (ms > TICK_TARGET_MS) this.size = Math.max(this.min, Math.floor(this.size / 2));
    else if (ms < TICK_TARGET_MS / 2) this.size = Math.min(this.max, Math.floor(this.size * 1.5));
    return result;
  }
}

/**
 * Bytes of stored values a tick reads, compresses and writes. A single larger
 * value is read alone. Cold pages on a loaded machine cost ten times warm
 * ones, so the pace never grows past what a cold tick reads in about 100 ms.
 */
export const bytePace = (): Pace => new Pace(512 * 1024, 64 * 1024, 2 * 1024 * 1024);
/**
 * Rows a tick reads or deletes. A cold row costs up to about 45 µs on the
 * 4.2 GB journal: 2,000 keeps a tick under 100 ms when the pace has grown on
 * warm rows.
 */
export const rowPace = (): Pace => new Pace(1_000, 100, 2_000);
/** Events a retention tick looks at: deleting one cold event cost up to 125 µs with its indexes. */
export const eventPace = (): Pace => new Pace(500, 100, 600);

/**
 * Prunes events past the retention a minute after start and then daily, one
 * paced batch per timer tick so that no pass holds the event loop on an old
 * machine: the trail events first, walked forward from where the last pass
 * stopped, then every event past 30 days from the front of the table. The
 * planner statistics run one `ANALYZE` per tick (`Journal.staleStatistics`):
 * at the first pass those a migration left missing, kept off the startup
 * path, and after each prune those it made stale. Returns the stop.
 */
export function scheduleEventRetention(journal: Journal, onError: (message: string) => void): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  // The statistics this pass still builds, one per tick; null at the start of a pass.
  let statistics: string[] | null = null;
  let first = true, pruned = false;
  const pace = eventPace();
  const arm = (delay: number): void => {
    if (stopped || journal.isClosed()) return;
    timer = setTimeout(pass, delay);
    timer.unref?.();
  };
  const pass = async (): Promise<void> => {
    timer = null;
    if (stopped || journal.isClosed()) return;
    try {
      // Waiting for checkpoints is not a productive tick, including for ANALYZE.
      if (journal.checkpoints?.behind === true) { arm(MOVE_RETRY_MS); return; }
      statistics ??= first ? journal.staleStatistics(true) : [];
      first = false;
      const statement = statistics[0];
      if (statement !== undefined) {
        journal.analyze(statement);
        statistics.shift();
        arm(10);
        return;
      }
      if (!pruned) {
        const more = await pace.run(limit => pruneEventsOnce(journal, Date.now(), limit));
        if (stopped || journal.isClosed()) return;
        if (more) {
          arm(10);
          return;
        }
        statistics = journal.staleStatistics();
        pruned = true;
        arm(10);
        return;
      }
    } catch (error) {
      onError(`journal event retention: ${messageOfError(error)}`);
      arm(MOVE_RETRY_MS);
      return;
    }
    statistics = null;
    pruned = false;
    arm(RETENTION_EVERY_MS);
  };
  arm(RETENTION_FIRST_MS);
  return () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
}

/**
 * One batch of event retention at `now`, looking at `limit` events; true while
 * more is left. A batch waits while the checkpoints catch up with the WAL
 * (`WalCheckpoints.behind`), as the compaction ticks do.
 */
export function pruneEventsOnce(journal: Journal, now: number, limit = 5_000): boolean {
  if (journal.isClosed()) return false;
  if (journal.checkpoints?.behind === true) return true;
  const after = (journal.getSetting(TRAIL_CURSOR) as number | undefined) ?? 0;
  const trail = journal.pruneTrail(after, now - TRAIL_RETENTION_MS, limit);
  if (trail.through !== after) journal.setSetting(TRAIL_CURSOR, trail.through);
  if (!trail.done) return true;
  return journal.pruneEvents(now - EVENT_RETENTION_MS, limit) > 0;
}

const MOVE_FIRST_MS = 3 * 60_000;
/** The spacing of the compaction ticks while a step has more to do. */
export const MOVE_EVERY_MS = 250;
const MOVE_RETRY_MS = 30_000;
const DAILY_MS = 86_400_000;
/** A cursor at this value is a pass that finished: rows written since are in the new shape. */
const DONE = Number.MAX_SAFE_INTEGER;
/** The one-time passes, by the setting holding their cursor. */
export const ONE_TIME_PASSES = ['part-blobs:moved-through', 'part-blobs:outputs-moved-through', 'part-blobs:recoded-through', 'processes:interned-through'] as const;
const PRUNED_THROUGH = 'processes:pruned-through';
export const PRUNED_AT = 'processes:pruned-at';
/** Free pages an incremental vacuum leaves, for the writes to come. */
const FREE_KEPT_BYTES = 16 * 1024 * 1024;

/** What one step did: more is left, it is finished, or an open message holds it. */
type Step = 'more' | 'done' | 'busy';

/** One pass over rows written in an older shape, resumed from a rowid kept in settings. */
async function rowPass(journal: Journal, key: string, run: (after: number) => PassResult | Promise<PassResult>): Promise<Step> {
  const after = (journal.getSetting(key) as number | undefined) ?? 0;
  if (after === DONE) return 'done';
  const through = await run(after);
  // Closed while its values were compressed on the thread pool.
  if (journal.isClosed()) return 'busy';
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
  if (at !== undefined && at > now) journal.deleteSetting(atKey);
  if (at !== undefined && at <= now && now - at < DAILY_MS) return 'done';
  const { through, more } = run(journal.getSetting(throughKey));
  if (more) {
    journal.setSetting(throughKey, through);
    return 'more';
  }
  journal.setSetting(atKey, now);
  journal.deleteSetting(throughKey);
  return 'done';
}

/**
 * Gives free pages back to the disk on a journal in incremental auto-vacuum
 * (set when the journal is created, or by `journal/vacuum.ts` for an older one), `pages` per tick, until the free list is
 * back to `FREE_KEPT_BYTES`.
 */
function freePages(journal: Journal, pages: number): Step {
  const db = journal.db;
  if ((db.query('PRAGMA auto_vacuum').get() as { auto_vacuum: number }).auto_vacuum !== 2) return 'done';
  const { freelist_count: free } = db.query('PRAGMA freelist_count').get() as { freelist_count: number };
  const { page_size: size } = db.query('PRAGMA page_size').get() as { page_size: number };
  if (free * size <= FREE_KEPT_BYTES) return 'done';
  db.exec(`PRAGMA incremental_vacuum(${Math.min(pages, free)})`);
  return 'more';
}

/** True once every one-time pass finished and the trace was cut once: what is left free will stay free. */
export function compactionFinished(read: (key: string) => unknown): boolean {
  return ONE_TIME_PASSES.every(key => read(key) === DONE) && read(PRUNED_AT) !== undefined;
}

/**
 * The steps of the background compaction, in order. A step that finished is
 * skipped from then on; the daily ones run again a day after they last ended.
 * Each sizes its batch with its own `Pace`.
 */
export function compactionSteps(journal: Journal): ((now: number) => Promise<Step>)[] {
  const isOpen = (id: string) => journal.isClosed() || journal.streamingMessage(id) !== undefined;
  // A command line read back costs up to 70 µs, overflow pages included.
  const [outputs, recode, intern, vacuum] = [bytePace(), bytePace(), new Pace(500, 50, 800), new Pace(256, 32, 4_096)];
  // Scanning or deleting a thread's old rows reads each row's page, cold and
  // spread over the table: up to 180 µs a row scanned and 130 µs a row deleted
  // on the 4.2 GB journal, so a batch grown on warm pages stays under 100 ms.
  const trace: Record<TracePhase, Pace> = { find: rowPace(), scan: new Pace(200, 50, 400), delete: new Pace(250, 50, 500), sweep: rowPace() };
  const prune = new TracePrune(journal.db, trace.find.size);
  // A tick waits while the checkpoints catch up with the WAL, so that the
  // passes rarely make this thread copy its frames (`WalCheckpoints.behind`):
  // the check runs before a tick, so only that tick's writes can cross it.
  const unlessBehind = (step: (now: number) => Promise<Step>) => (now: number): Promise<Step> =>
    journal.checkpoints?.behind === true ? Promise.resolve('more') : step(now);
  const steps: ((now: number) => Promise<Step>)[] = [
    // Values of 32 KiB and more of rows written before `part_blobs`, one row per tick.
    () => rowPass(journal, ONE_TIME_PASSES[0], after => moveInlineValues(journal.db, after, isOpen)),
    // Tool outputs of 4 to 32 KiB of rows written before schema 37.
    () => outputs.run(size => rowPass(journal, ONE_TIME_PASSES[1], after => moveInlineOutputs(journal.db, after, size, isOpen))),
    // `part_blobs` rows stored as text before schema 37.
    () => recode.run(size => rowPass(journal, ONE_TIME_PASSES[2], after => recodePartBlobs(journal.db, after, size, () => journal.isClosed()))),
    // Every thread's trace cut to what it keeps, then once a day; before the
    // command lines move, so the lines of the rows it deletes are never written.
    now => trace[prune.phase].run(size => {
      prune.limit = size;
      return dailyPass(journal, now, PRUNED_AT, PRUNED_THROUGH, after => prune.step((after as string | undefined) ?? ''));
    }),
    // Command lines of trace rows written before schema 37.
    () => intern.run(size => rowPass(journal, ONE_TIME_PASSES[3], after => internOldCommandLines(journal.db, after, size))),
    // Free pages back to the disk, once the journal is in incremental auto-vacuum.
    () => vacuum.run(pages => freePages(journal, pages)),
  ];
  return steps.map(unlessBehind);
}

/**
 * Runs the first step that is not finished, once. Returns 'done' when every
 * step is, which is when the timer waits a day.
 */
export async function compactOnce(steps: ((now: number) => Promise<Step>)[], now: number): Promise<Step> {
  for (const step of steps) {
    const result = await step(now);
    if (result !== 'done') return result;
  }
  return 'done';
}

/**
 * Brings rows written in an older shape to the current one, keeps the trace
 * bounded and gives free pages back, one paced batch per tick 250 ms apart,
 * starting a few minutes after start (`compactionSteps`). A streaming turn
 * pauses it. Each step keeps its cursor in settings, so a finished journal is
 * never scanned again; once every step is done it wakes once a day for the
 * daily ones. Returns the stop.
 */
export function scheduleInlineValueMoves(journal: Journal, onError: (message: string) => void): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const steps = compactionSteps(journal);
  const arm = (delay: number): void => {
    timer = setTimeout(pass, delay);
    timer.unref?.();
  };
  const pass = async (): Promise<void> => {
    timer = null;
    if (journal.isClosed()) return;
    if (journal.hasOpenMessages()) { arm(MOVE_RETRY_MS); return; }
    let result: Step;
    try {
      journal.flushDeltas();
      result = await compactOnce(steps, Date.now());
    } catch (error) {
      if (journal.isClosed()) return;
      onError(`journal compaction: ${messageOfError(error)}`);
      result = 'busy';
    }
    if (journal.isClosed() || stopped) return;
    arm(result === 'more' ? MOVE_EVERY_MS : result === 'busy' ? MOVE_RETRY_MS : DAILY_MS);
  };
  arm(MOVE_FIRST_MS);
  return () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
}

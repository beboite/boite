import type { Journal } from '../journal.ts';
import { moveInlineValues } from './part-blobs.ts';
import { messageOfError } from './stream-buffer.ts';

/** How long events are kept. The projections hold the state; events are the recent trail. */
export const EVENT_RETENTION_MS = 30 * 86_400_000;
const RETENTION_FIRST_MS = 60_000;
const RETENTION_EVERY_MS = 86_400_000;
const RETENTION_BATCH = 5_000;

/**
 * Prunes events past the retention a minute after start and then daily, one
 * batch per timer tick so that no pass holds the event loop on an old machine.
 * Returns the stop.
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
      if (journal.pruneEvents(Date.now() - EVENT_RETENTION_MS, RETENTION_BATCH) > 0) {
        arm(10);
        return;
      }
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

const MOVE_FIRST_MS = 3 * 60_000;
const MOVE_EVERY_MS = 250;
const MOVE_RETRY_MS = 30_000;
const MOVE_CURSOR = 'part-blobs:moved-through';

/**
 * Moves the large values of rows written before `part_blobs`, one message per
 * tick, starting a few minutes after start. A streaming turn pauses it: the
 * largest rows take a moment each, once. The last rowid done is kept, so a
 * finished journal is never scanned again.
 */
export function scheduleInlineValueMoves(journal: Journal, onError: (message: string) => void): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
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
      const after = (journal.getSetting(MOVE_CURSOR) as number | undefined) ?? 0;
      const moved = moveInlineValues(journal.db, after, id => journal.streamingMessage(id) !== undefined);
      if (moved === null) return;
      if (moved === -1) { arm(MOVE_RETRY_MS); return; }
      journal.setSetting(MOVE_CURSOR, moved);
      arm(MOVE_EVERY_MS);
    } catch (error) {
      onError(`journal part values move: ${messageOfError(error)}`);
      arm(MOVE_RETRY_MS);
    }
  };
  arm(MOVE_FIRST_MS);
  return () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
}

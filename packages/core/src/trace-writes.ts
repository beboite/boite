import type { ThreadId } from '@boite/contracts';
import type { Bus } from './bus.ts';
import { diskFull } from './errors.ts';

/** How often a disk that stays full is reported while trace rows are skipped. */
const DISK_FULL_WARN_MS = 60_000;
/** When each core's bus last carried that warning. */
const warnedAt = new WeakMap<Bus, number>();

/**
 * A trace row is the one write a busy build makes per process. On a full disk
 * it is skipped: the process runs on untraced and the core with it, where the
 * throw from a job callback used to stop the core (#596). One warning per
 * `DISK_FULL_WARN_MS` while the disk stays full.
 */
export function traceWrite(bus: Bus, threadId: ThreadId, write: () => void): void {
  try {
    write();
  } catch (error) {
    if (!diskFull(error)) throw error;
    const now = Date.now();
    if (now - (warnedAt.get(bus) ?? -Infinity) < DISK_FULL_WARN_MS) return;
    warnedAt.set(bus, now);
    bus.emit('core.log', { level: 'warn', message: 'the disk is full: process trace rows are skipped until it has room', source: 'process', event: 'trace.disk-full', threadId, at: now });
  }
}

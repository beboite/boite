import type {Captured} from './capture.ts';

/** This admits only the finite ordinary pipe experiment, never production. */
export function acceptsNullMessageProbe(result: Captured): boolean {
  if (result.code !== 0 || result.timedOut || result.err !== '') return false;
  const record = result.out.match(/^NULL_MESSAGE_PROBE reads=32 eof-writes=32 flushes=32 write-blocks=32 received=2097152 pre-read-flush-pending=1 joined=3 closed=9 io-acquired=(\d+) io-closed=(\d+) retained=0 error=0 semanticAccepted=1 productionAccepted=0\r?\n$/);
  if (!record) return false;
  const acquired = Number(record[1]), closed = Number(record[2]);
  // 32 writes each way, 32 EOF reads and at least 128 discard reads.
  return Number.isSafeInteger(acquired) && acquired >= 224 && acquired === closed;
}

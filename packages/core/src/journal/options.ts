import type { UsageProtocolOf } from './usage-buckets.ts';
import type { WalCheckpointOptions } from './wal-checkpoints.ts';

export interface JournalOptions {
  /** Where a write that fails on a timer, with no caller to throw to, is reported. */
  onError?: (message: string) => void;
  /** Overrides the WAL checkpoint thresholds, for tests (`journal/wal-checkpoints.ts`). */
  checkpoints?: WalCheckpointOptions;
  /** The protocol each provider id runs on, for the migration that freezes stored usage (`journal/usage-buckets.ts`). */
  usageProtocol?: UsageProtocolOf;
}

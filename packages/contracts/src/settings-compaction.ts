import type { Settings } from './settings';
import type { AutoCompact } from './settings-validation';
import type { ThreadSummary } from './threads';

export type CompactionTarget = 'agent' | 'subagent' | 'bot';

/** A complete override; removing the target restores the current common defaults. */
export interface CompactionPolicy {
  autoCompact: AutoCompact | null;
  backgroundCompaction: boolean;
}

/** Children take precedence, including children started by a resident bot. */
export function effectiveCompaction(settings: Pick<Settings, 'autoCompact' | 'backgroundCompaction' | 'compactionByType'>, thread: Pick<ThreadSummary, 'parentThreadId' | 'agentSessionId'>): CompactionPolicy {
  const target: CompactionTarget = thread.parentThreadId ? 'subagent' : thread.agentSessionId ? 'bot' : 'agent';
  return settings.compactionByType?.[target] ?? {
    autoCompact: settings.autoCompact ?? null,
    backgroundCompaction: settings.backgroundCompaction === true,
  };
}

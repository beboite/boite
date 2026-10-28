/**
 * What a child's finished turn means, for every owner of child threads:
 * delegation letters, workflow steps. A turn that ends on background work the
 * agent will be woken by is a checkpoint; only the turn after that work is its
 * final result.
 */
import type { BackgroundTask, Turn } from '@boite/contracts';
import type { Core } from '../core.ts';

export type ChildEnd =
  /** A compaction or cache keepalive: no step of the task. */
  | { kind: 'maintenance' }
  /** Ended to wait on its own background work: not done, and its worktree is still in use. */
  | { kind: 'checkpoint'; live: BackgroundTask[] }
  | { kind: 'final' };

export function childEnd(core: Core, turn: Turn): ChildEnd {
  if (turn.execution?.operation === 'compact' || turn.execution?.operation === 'keepalive') return { kind: 'maintenance' };
  const live = turn.status === 'done' ? core.threads.agentState.background.get(turn.threadId) ?? [] : [];
  return live.length > 0 ? { kind: 'checkpoint', live } : { kind: 'final' };
}

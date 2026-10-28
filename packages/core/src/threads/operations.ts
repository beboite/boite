import type { ActivityTurn, Turn } from '@boite/contracts';
import type { AutonomousSource } from '../agents/runtime.ts';

export const SYSTEM_LABEL = { coordination: 'Agent coordination', delegation: 'Agent delegation', background: 'Background work finished', resume: 'Resumed after a restart', 'pull-request': 'Pull request update', routine: 'Routine', event: 'Agent event' } as const;

/** Native command names may be unknown until the session starts; paths are ordinary input. */
export function nativeCommandPrompt(prompt: string): boolean {
  return /^\s*\/[\w:-]+(?:\s|$)/.test(prompt);
}

/** The turns whose opening message is Boite's and not the user's: a persistent agent's wakes among them. */
export function systemOperation(operation: string | undefined): operation is keyof typeof SYSTEM_LABEL {
  return operation === 'coordination' || operation === 'delegation' || operation === 'background' || operation === 'resume' || operation === 'pull-request'
    || operation === 'routine' || operation === 'event';
}

/**
 * Where a turn comes from when the core starts it by itself, or null for the
 * user's message, a routine or an event (`AgentRuntime.attempt` admitted it,
 * or it is the owner's Run now), a compaction, a cache ping, and a restart
 * continuing a turn that was running (`threads/handoff.ts`).
 */
export function autonomousSource(operation: NonNullable<Turn['execution']>['operation'] | undefined, activity: ActivityTurn | undefined, requestId: string | undefined): AutonomousSource | null {
  switch (operation) {
    case undefined: return activity ? 'goal' : null;
    case 'background': case 'coordination': case 'delegation': case 'pull-request': return operation;
    case 'resume': return requestId?.startsWith('restart_') ? null : 'resume';
    default: return null;
  }
}

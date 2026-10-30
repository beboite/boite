import type { ActivityTurn, Attachment, ComposerChoice, PreviewReference, SentFrom, ThreadLink, Turn } from '@boite/contracts';
import type { AutonomousSource } from '../agents/runtime.ts';

/** What a turn opens with. `display` replaces the prompt in the conversation. */
export interface TurnInput {
  prompt: string;
  attachments?: Attachment[];
  previews?: PreviewReference[];
  display?: string;
}

/**
 * Why the core resumes a thread by itself: a usage limit lifted, a turn that
 * stopped before its answer, a restart continuing a running turn, or a restart
 * that cut a subagent.
 */
export type ResumeReason = 'limit' | 'carry-on' | 'handoff' | 'delegation-restart';

/** An idempotency key: a second start with the same one returns the first turn (`threads/inputs.ts`). */
interface Keyed { requestId?: string }

/**
 * Who starts a turn and why. The stored operation, whether Boite speaks
 * instead of the user, and the source a persistent agent admits it as all
 * follow from the kind, never from the shape of the other arguments.
 */
export type TurnOrigin =
  | Keyed & { kind: 'user'; sentFrom?: SentFrom | null }
  | Keyed & { kind: 'goal'; activity: ActivityTurn }
  | Keyed & { kind: 'spawned'; startedBy: ThreadLink }
  | Keyed & { kind: 'compact'; automatic: boolean }
  | Keyed & { kind: 'keepalive' }
  | Keyed & { kind: 'resume'; reason: ResumeReason }
  /** `owner`: a team letter with the owner's post among its triggers, a wake no bot pause or budget holds (`docs/teams.md`). */
  | Keyed & { kind: 'coordination'; owner?: true }
  | Keyed & { kind: 'delegation' | 'goal-check' | 'background' | 'pull-request' | 'routine' | 'event' };

export interface StartTurnOptions {
  /** Refuses the start when the thread's agent selection changed since the client read it. */
  expectedSelectionVersion?: number;
  /** Runs inside the commit that accepts the turn; its result runs once the commit landed. */
  persistAdmission?: () => (() => void);
  /** The agent selection the input was queued with, which the turn keeps. */
  choice?: ComposerChoice;
  /** The prompt as typed, when it may start an automatic goal (`docs/goals.md`). */
  autoGoal?: string;
}

export type TurnOperation = NonNullable<Turn['execution']>['operation'];

export const USER_ORIGIN: TurnOrigin = { kind: 'user' };

/** The operation stored on the turn. A goal check runs on its tracker, a delegated child, so it counts as delegation. */
export function originOperation(origin: TurnOrigin): TurnOperation | undefined {
  switch (origin.kind) {
    case 'user': case 'goal': case 'spawned': return undefined;
    case 'goal-check': return 'delegation';
    default: return origin.kind;
  }
}

/** Boite speaks instead of the user: an automatic compaction and every cache ping. */
export function originAutomatic(origin: TurnOrigin): boolean {
  return (origin.kind === 'compact' && origin.automatic) || origin.kind === 'keepalive';
}

/**
 * Where a turn comes from when the core starts it by itself, or null for the
 * user's message, a routine or an event (`AgentRuntime.attempt` admitted it,
 * or it is the owner's Run now), a compaction, a cache ping, and a restart
 * continuing a turn that was running (`threads/handoff.ts`, `delegation/restart.ts`).
 */
export function autonomousSource(origin: TurnOrigin): AutonomousSource | null {
  switch (origin.kind) {
    case 'goal': return 'goal';
    case 'coordination': return origin.owner ? null : 'coordination';
    case 'background': case 'delegation': case 'pull-request': return origin.kind;
    case 'goal-check': return 'delegation';
    case 'resume': return origin.reason === 'handoff' || origin.reason === 'delegation-restart' ? null : 'resume';
    default: return null;
  }
}

import type { PauseOrigin } from '@boite/contracts';
import type { Core } from '../core.ts';

/** A pause as a team or a run records it. A pause saved before its origin was recorded reads as the owner's. */
export interface Pause { by?: PauseOrigin; at?: number }

/** Which pause outranks which: a new pause never replaces a stricter one. */
const RANK: Record<PauseOrigin, number> = { restart: 0, agent: 0, stop: 1, owner: 2 };

/** The pause to record when `by` pauses again what `current` may already hold. */
export function pauseOver(current: Pause | null, by: PauseOrigin, at = Date.now()): Required<Pause> {
  if (current === null) return { by, at };
  const held = current.by ?? 'owner';
  return RANK[by] >= RANK[held] ? { by, at } : { by: held, at: current.at ?? at };
}

/** A prompt the owner wrote to the conversation after `at`: not one Boite, a routine or another agent opened. */
export function ownerWroteSince(core: Core, threadId: string, at: number): boolean {
  return core.journal.db.query(`SELECT 1 FROM messages WHERE thread_id = ? AND role = 'user' AND created_at > ?
    AND json_extract(parts, '$[0].startedBy') IS NULL AND json_extract(parts, '$[0].activity') IS NULL LIMIT 1`).get(threadId, at) !== null;
}

/**
 * Why the conversation's agent may not lift this pause, or null when it may:
 * its own and a restart's at any time, the owner's Stop or a run the owner
 * paused once the owner wrote to the conversation after it, the Settings
 * switch never.
 */
export function pauseHold(core: Core, rootId: string, pause: Pause, kind: 'team' | 'run'): string | null {
  const by = pause.by ?? 'owner';
  if (by === 'agent' || by === 'restart') return null;
  const wrote = pause.at !== undefined && pause.by !== undefined && ownerWroteSince(core, rootId, pause.at);
  if (by === 'stop') return wrote ? null : 'the owner stopped this conversation; once they write to it again, you may resume';
  if (kind === 'run') return wrote ? null : 'the owner paused this run; once they write to the conversation again, you may resume it';
  return 'the owner paused subagents in Subagents > Settings; only they resume them';
}

/** How the agent's guide names a pause. */
export function pauseLine(pause: Pause): string {
  switch (pause.by) {
    case 'agent': return 'Paused by you: boite delegate resume continues the team, its stopped children and paused workflows.';
    case 'restart': return 'Paused by a Boite restart: boite delegate resume continues the team, its cut children and paused workflows.';
    case 'stop': return 'Paused by the owner\'s Stop: once they write to you again, boite delegate resume continues the team if they want it to.';
    default: return 'Paused by the owner: new children and steps wait until they resume it in Subagents > Settings.';
  }
}

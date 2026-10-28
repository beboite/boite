/** Children a restart handoff cut: no result for their parent, a continuation from the next core. */
import type { Turn } from '@boite/contracts';
import type { Core } from '../core.ts';
import { messageOf } from '../errors.ts';

/** Children a restart handoff cut, by the turn it cut: the next core sends each a continuation. */
const RESTART_CUT = 'delegation-restart-cut';
interface RestartCut { childId: string; turnId: string }

/** The handoff stopped this child turn on purpose: it is kept for the next core, never reported as stopped. */
export function recordRestartCut(core: Core, turn: Turn): void {
  const cut = (core.journal.getSetting(RESTART_CUT) as RestartCut[] | undefined) ?? [];
  core.journal.setSetting(RESTART_CUT, [...cut.filter(entry => entry.childId !== turn.threadId), { childId: turn.threadId, turnId: turn.id }]);
}

/** A child stopped for good: no restart continues its cut turn, from this core's handoff, the previous one's or a cut kept here. */
export function endRestart(core: Core, childId: string): void {
  core.threads.handoff.forget(childId);
  const cut = (core.journal.getSetting(RESTART_CUT) as RestartCut[] | undefined) ?? [];
  const rest = cut.filter(entry => entry.childId !== childId);
  if (rest.length === cut.length) return;
  if (rest.length) core.journal.setSetting(RESTART_CUT, rest);
  else core.journal.deleteSetting(RESTART_CUT);
}

/** Whether a restart continues this cut turn: this core hands it on, or the next one has yet to continue it. */
export function restartContinues(core: Core, childId: string, turnId: string): boolean {
  const handoff = core.threads.handoff;
  if (handoff.carries(turnId) || handoff.inheritedTurns().has(turnId)) return true;
  return ((core.journal.getSetting(RESTART_CUT) as RestartCut[] | undefined) ?? []).some(cut => cut.childId === childId && cut.turnId === turnId);
}

/**
 * The previous core cut these children, but this one does not carry its
 * handoff on (older than an hour, unreadable): none of them resumes, and their
 * parents are returned so recovery holds those teams as after a crash.
 */
export function dropRestartCuts(core: Core): string[] {
  const cut = (core.journal.getSetting(RESTART_CUT) as RestartCut[] | undefined) ?? [];
  if (!cut.length) return [];
  core.journal.deleteSetting(RESTART_CUT);
  return cut.flatMap(({ childId }) => core.journal.getThread(childId)?.parentThreadId ?? []);
}

/**
 * Once the server listens after a restart handoff: each child the handoff
 * cut gets the continuation its parent's cut turn gets. A new instruction,
 * a Stop or an archive since then decides instead, and so does a pause of its
 * team. Returns how many went on.
 */
export function resumeRestartCuts(core: Core): number {
  const cut = (core.journal.getSetting(RESTART_CUT) as RestartCut[] | undefined) ?? [];
  if (!cut.length) return 0;
  core.journal.deleteSetting(RESTART_CUT);
  let resumed = 0;
  for (const { childId, turnId } of cut) {
    const child = core.journal.getThread(childId);
    const last = core.journal.db.query('SELECT id FROM turns WHERE thread_id = ? ORDER BY rowid DESC LIMIT 1').get(childId) as { id: string } | null;
    const turn = last ? core.journal.getTurn(last.id) : null;
    if (!child || child.archived || turn?.id !== turnId || turn.status !== 'stopped') continue;
    if (!child.parentThreadId) {
      // A child for a parent on another machine: that machine holds its team, and a Stop or an archive there reaches it as a stop.
      if (!core.delegation.remote.parentOf(childId)) continue;
    } else {
      // A Stop during the handoff's grace paused the team after the cut: that pause decides.
      const root = core.journal.getThread(child.parentThreadId), config = core.delegation.config(child.parentThreadId);
      if (!root || root.archived || !config.enabled || config.paused) continue;
    }
    // Its turns open with the parent's brief or letters, not a prompt of the user's: the brief goes along.
    const task = (core.journal.db.query('SELECT task FROM delegated_agents WHERE thread_id = ?').get(childId) as { task: string } | null)?.task;
    const prompt = `${core.threads.handoff.continuation(turn)}${task ? `\n\nYour task from the parent agent, supplied as JSON data:\n${JSON.stringify(task)}` : ''}`;
    try {
      core.threads.startTurn(childId, prompt, [], undefined, 'resume', undefined, `restart_${turnId}`);
      resumed += 1;
    } catch (error) {
      core.log('warn', `subagent ${childId} was not resumed after the restart: ${messageOf(error)}`);
    }
  }
  if (resumed > 0) core.log('info', `restart handoff: resumed ${resumed} subagents`);
  return resumed;
}

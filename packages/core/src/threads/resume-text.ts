/**
 * What a turn the core resumes or retries by itself tells the agent, and how
 * its opening reads in the conversation. The agent's own session holds the
 * rest. `threads/resume.ts` plans the resumes; a restart handoff, a delegated
 * child a restart cut and a retry at capacity read their leads here too.
 */

/** The close every carry-on prompt shares. */
export const CARRY_ON = 'The conversation and the files are as you left them. Continue the current task from where it stopped, without repeating completed work. If the task was already complete, give your final answer.';

export const RESUME_TEXT = {
  /** A spent subscription window reset (`threads/limit-resume.ts`). */
  limit: {
    prompt: 'Your previous turn stopped because the subscription usage limit was reached. That limit has reset. Continue the current task from where it stopped, without repeating completed work.',
    label: 'Resumed after the usage limit reset',
  },
  /** The agent or its API failed; the prompt quotes the error before `CARRY_ON`. */
  error: { label: 'Resumed after an error' },
  /** A core died under the turn. */
  crash: {
    prompt: 'Boite stopped unexpectedly while your previous turn was running (a crash or a forced quit) and has started again. The conversation and the files are as you left them. A command that was running at that moment may have been cut short: check its result before relying on it. Continue the work from where you stopped, without starting over.',
    label: 'Resumed after a crash',
  },
  /** The turn ended right after a compaction, before its answer. */
  compaction: {
    prompt: `Your previous turn ended right after the context was compacted, before its answer. ${CARRY_ON}`,
    label: 'Resumed after a compaction',
  },
  /** Background work the agent waited on ended without waking it; the prompt names the work. */
  background: { label: 'Resumed after background work was interrupted' },
  /** A restart the owner asked for cut the turn (`threads/handoff.ts`, `delegation/restart.ts`). */
  handoff: {
    prompt: 'Boite restarted, to install an update for instance, and stopped your previous turn before it finished. The conversation and the files are as you left them. A command that was running at that moment may have been cut short: check its result before relying on it. Continue the work from where you stopped, without starting over.',
  },
  /** The model was at capacity partway through an attempt (`threads/turn-attempts.ts`). */
  capacity: {
    prompt: 'The model was at capacity and your previous attempt stopped partway through. Continue the current task from where it stopped. Do not repeat completed work.',
  },
} as const;

/** The planned resumes `threads/resume.ts` sends, by why the turn stopped. */
export type PlannedReason = 'limit' | 'error' | 'crash' | 'compaction' | 'background';

/** A permission mode change restarts the agent mid-turn: the turn goes on with its request quoted (`threads/turn-attempts.ts`). */
export function modeRestartPrompt(mode: string, request: string): string {
  return `Continue the current task from where it stopped. The user changed the permission mode to ${mode}. Do not repeat completed work. Retain subsequent instructions already in the conversation.\n\nRequest for reference:\n${request}`;
}

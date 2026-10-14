import type { BackgroundInterruption } from '@boite/contracts';

/** Why a delegated agent's background work ended without waking it, in the words its parent reads. */
export const INTERRUPTION_TEXT: Record<BackgroundInterruption, string> = {
  'error': 'the task failed',
  'cancelled': 'the task was cancelled',
  'no-longer-reported': 'its agent stopped reporting the task (its process ended)',
  'session-ended': 'its agent process was ended',
  'core-restarted': 'Boite or the PC restarted',
};

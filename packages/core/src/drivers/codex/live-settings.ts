import type { LiveTurnSettings } from '../types.ts';
import type { CodexRpc } from './rpc.ts';

/**
 * `turn/settings/update`: the effort and the service tier of the model requests
 * a running turn has not sent yet. Probed on codex 0.160.1 against a recording
 * endpoint: after `applied`, the next request of the same turn carried the new
 * `reasoning.effort` and `service_tier`. The change belongs to that turn alone;
 * the next `turn/start` names both again.
 *
 * Answers what the server took. A thread with no effort has nothing to send,
 * since null means "unchanged" there, while a null tier clears it. Rejects
 * when the server has no such request: an older codex, or one launched without
 * `LIVE_TURN_SETTINGS` and the `experimentalApi` capability.
 */
export async function updateTurnSettings(rpc: CodexRpc, threadId: string, turnId: string, change: LiveTurnSettings): Promise<LiveTurnSettings> {
  const taken: LiveTurnSettings = {};
  if (typeof change.effort === 'string') taken.effort = change.effort;
  if ('speed' in change) taken.speed = change.speed ?? null;
  if (!('effort' in taken) && !('speed' in taken)) return {};
  const answer = await rpc.request<{ status?: string }>('turn/settings/update', {
    threadId,
    turnId,
    ...('effort' in taken ? { effort: taken.effort } : {}),
    ...('speed' in taken ? { serviceTier: taken.speed } : {}),
  });
  // `targetUnavailable`: the turn ended, or it has no step left to change.
  return answer.status === 'applied' ? taken : {};
}

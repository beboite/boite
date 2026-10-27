import type {SessionContext} from '../types.ts';
import type {MuseSessionRecord} from './protocol.ts';
import {META_PROVIDER, MODE_POSTURE} from './protocol.ts';
import {modelOf} from './mapping.ts';
import type {MuseRpc} from './rpc.ts';

/** Native model and permission projections, kept across warm turns. */
export class MuseControls {
  modelId: string | null = null;
  approvalMode: string | null = null;

  /**
   * The thread as it stands for this turn: its model and its approval mode,
   * sent only when the host reports something else. The effort rides on
   * `turn/start` itself.
   */
  async align(rpc: MuseRpc, sessionId: string, ctx: SessionContext, protectedNative: boolean): Promise<void> {
    const model = modelOf(ctx);
    if (model !== null && model !== this.modelId) {
      const result = await rpc.command<{status?: string}>('session/setModel', { sessionId, model: { modelId: model, providerId: META_PROVIDER } });
      if (protectedNative && result.status !== 'accepted') throw new Error('execution.muse.model: native host did not admit the captured model');
      if (result.status === undefined || result.status === 'accepted') this.modelId = model;
    }
    const mode = MODE_POSTURE[ctx.thread.permissionMode].approvalMode;
    if (mode !== this.approvalMode) {
      const result = await rpc.command<{effectiveMode?: {mode?: string}}>('session/setApprovalMode', { sessionId, mode });
      if (protectedNative && result.effectiveMode?.mode !== mode) throw new Error('execution.muse.mode: native host did not confirm the captured approval mode');
      this.approvalMode = result.effectiveMode?.mode ?? mode;
    }
  }

  adopt(session: MuseSessionRecord): string {
    this.modelId = session.modelId ?? null;
    this.approvalMode = session.approvalMode?.mode ?? null;
    return session.sessionId;
  }

}

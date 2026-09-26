/** Voice input: its configuration, the local engine install and a transcription. */
import { RpcErrorCode } from '@boite/contracts';
import { RpcFailure } from '../client';
import type { FakeContext, FakeMethods } from './context';

export function speechMethods(ctx: FakeContext) {
  return {
    'speech.config': async (params) => {
      return { ...ctx.speech };
    },
    'speech.status': async (params) => {
      return { ...ctx.speechStatus };
    },
    'speech.configure': async (params) => {
      const p = params;
      ctx.speech = { engine: p.engine, language: p.language, apiProvider: p.apiProvider, fallback: p.fallback, executable: p.executable, modelPath: p.modelPath };
      if (p.groqKey !== undefined) ctx.speechStatus.groqKeySet = !!p.groqKey;
      if (p.openrouterKey !== undefined) ctx.speechStatus.openrouterKeySet = !!p.openrouterKey;
      ctx.speechStatus.engine = p.engine; ctx.speechStatus.revision = crypto.randomUUID();
      ctx.speechStatus.ready = p.engine === 'local' ? ctx.speechStatus.localReady : p.apiProvider === 'groq' ? ctx.speechStatus.groqKeySet : ctx.speechStatus.openrouterKeySet;
      return { ...ctx.speechStatus };
    },
    'speech.install': async (params) => {
      ctx.speechStatus.localReady = true;
      ctx.speechStatus.ready = ctx.speech.engine === 'local' || ctx.speechStatus.ready;
      return { ...ctx.speechStatus };
    },
    'speech.installCancel': async (params) => {
      return { ...ctx.speechStatus };
    },
    'speech.uninstall': async (params) => {
      ctx.speechStatus.localReady = false;
      if (ctx.speech.engine === 'local') ctx.speechStatus.ready = false;
      return { ...ctx.speechStatus };
    },
    'speech.cancel': async (params) => {
      ctx.speechRequests.delete(params.requestId);
      return { ok: true };
    },
    'speech.transcribe': async (params) => {
      const p = params;
      if (!ctx.speechStatus.ready) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'Configure Voice first' });
      if (p.revision !== ctx.speechStatus.revision) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'Voice settings changed during recording; record again with the selected engine' });
      if (ctx.speechRequests.size) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'Another transcription is running; try again shortly' });
      const request = Symbol(p.requestId);
      ctx.speechRequests.set(p.requestId, request);
      await new Promise(resolve => setTimeout(resolve, 250));
      if (ctx.speechRequests.get(p.requestId) !== request) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'Transcription cancelled' });
      ctx.speechRequests.delete(p.requestId);
      return { text: 'Please add a test for this change.' };
    },
  } satisfies Partial<FakeMethods>;
}

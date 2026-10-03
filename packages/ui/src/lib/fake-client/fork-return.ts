import { RpcErrorCode, type AgentLetter } from '@boite/contracts';
import { RpcFailure } from '../client';
import { coordinationMethods } from './coordination';
import type { FakeContext, FakeMethods } from './context';

export function forkReturnMethods(ctx: FakeContext): Pick<FakeMethods, 'threads.mergeBack'> {
  const receipts = new Map<string, { fingerprint: string; letter: Promise<AgentLetter> }>();
  const send = coordinationMethods(ctx)['collaboration.send'];
  const refuse = (message: string): never => { throw new RpcFailure({ code: RpcErrorCode.Refused, message }); };
  return {
    'threads.mergeBack': async ({ threadId, summary, requestId }) => {
      const fork = ctx.thread(threadId);
      const sourceId = fork.forkOrigin?.threadId;
      if (!sourceId || sourceId === fork.id) refuse('threadId: expected a fork with a distinct recorded source');
      const source = ctx.threads.get(sourceId!);
      if (!source || source.archived) refuse('fork source is unavailable');
      if (typeof summary !== 'string' || !summary.trim() || summary.length > 4000) throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'summary: expected 1 to 4000 characters' });
      if (typeof requestId !== 'string' || !requestId.trim() || requestId.length > 128) throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'requestId: expected 1 to 128 characters' });
      const key = JSON.stringify([threadId, requestId]);
      const fingerprint = JSON.stringify([sourceId, summary]);
      const receipt = receipts.get(key);
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) refuse('requestId already used for different content');
        const original = await receipt.letter;
        return structuredClone(ctx.letters.get(threadId)?.find(entry => entry.id === original.id) ?? original);
      }
      const letter = send({ threadId, to: { coreId: ctx.identity.coreId, threadId: sourceId! }, text: summary, requestId: `fork-return:${requestId}` });
      receipts.set(key, { fingerprint, letter });
      try { return await letter; }
      catch (error) { receipts.delete(key); throw error; }
    },
  };
}

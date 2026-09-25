/** Pairing grants, paired sessions and the Web Push the fake refuses. */
import { RpcErrorCode } from '@boite/contracts';
import { RpcFailure } from '../client';
import type { FakeContext, FakeMethods } from './context';

export function pairingMethods(ctx: FakeContext) {
  return {
    'pairing.grant': async (params) => {
      const grant = `fake-grant-${++ctx.seq}`;
      return {
        url: `http://192.168.1.20:8777/?grant=${grant}`,
        grant,
        role: params?.role ?? 'device',
        expiresAt: ctx.now() + 10 * 60 * 1000
      };
    },
    'sessions.list': async (params) => {
      return structuredClone(ctx.sessions);
    },
    'push.status': async (params) => {
      return { publicKey: '', subscribed: false };
    },
    'push.subscribe': async (params) => {
      throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'Web Push needs a paired connection to a real core' });
    },
    'push.unsubscribe': async (params) => {
      throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'Web Push needs a paired connection to a real core' });
    },
    'push.test': async (params) => {
      throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'Web Push needs a paired connection to a real core' });
    },
    'sessions.revoke': async (params) => {
      if (!ctx.sessions.some((session) => session.id === params.sessionId)) {
        throw new RpcFailure({ code: RpcErrorCode.Refused, message: `unknown session ${params.sessionId}` });
      }
      ctx.sessions = ctx.sessions.filter((session) => session.id !== params.sessionId);
      ctx.emit('sessions.updated', { sessionId: params.sessionId, state: 'revoked' });
      return { ok: true };
    },
  } satisfies Partial<FakeMethods>;
}
